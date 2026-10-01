// The decisions the payout routes make, pinned without a server.
//
// There is no route test harness in this repo, so every rule a route applies
// that does not need a request or a database lives in lib/payout-api and is
// checked here: who may ask for a payment, which ids a body may name, what a
// payment has to look like before it is recorded, which state a request has to
// be in for each admin action, which status code each store error becomes, and
// who may open a receipt. The routes are thin enough that reading them against
// this list is the rest of the review.
//
// The last section reads the three route files themselves and holds their
// user-visible strings to the house rules: no dashes anywhere, and nothing on
// the affiliate side that names a share, a commission, a gross figure, a split
// or a percentage.
//
//   npx tsx scripts/payout-api-checks.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asBody,
  candidatesFrom,
  cancelledRefusal,
  MAX_CARDS_PER_REQUEST,
  mayReadReceipt,
  payslipGate,
  readConversionIds,
  readPayment,
  readPayoutAction,
  readPayslipAction,
  readRequestId,
  readRowId,
  requestedByFor,
  requestFailure,
  stateRefusal,
  storeFailure,
  textField,
  type Refusal,
} from '../src/lib/payout-api';
import {
  StoreConfigError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from '../src/lib/store/errors';
import type { Conversion } from '../src/lib/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const DASHES = /[\u2013\u2014]/;

/*
 * Every sentence the module hands a route. `affiliate` marks the ones an
 * affiliate can be shown, which carry the stricter wording rule.
 */
const said: { text: string; affiliate: boolean }[] = [];
function heard(refusal: Refusal, affiliate: boolean): Refusal;
function heard(refusal: Refusal | null | undefined, affiliate: boolean): Refusal | null;
function heard(refusal: Refusal | null | undefined, affiliate: boolean): Refusal | null {
  if (!refusal) return null;
  said.push({ text: refusal.error, affiliate });
  if (refusal.hint) said.push({ text: refusal.hint, affiliate });
  for (const text of Object.values(refusal.fields ?? {})) said.push({ text, affiliate });
  return refusal;
}

type Who = { id: string; username: string; role: 'admin' | 'affiliate'; usr: string; actingAs: { adminId: string; adminName: string } | null };
const SAM: Who = { id: 'u-sam', username: 'sam', role: 'affiliate', usr: 'sam', actingAs: null };
const ADMIN: Who = { id: 'u-admin', username: 'alex', role: 'admin', usr: '', actingAs: null };
/* An admin in Client View is the affiliate, with actingAs remembering who is really there. */
const VIEWING: Who = { ...SAM, actingAs: { adminId: 'u-admin', adminName: 'alex' } };

console.log('\u2014 a body, read without trusting it \u2014');
check('an object is itself', asBody({ action: 'pay' }).action === 'pay');
check('null is empty', Object.keys(asBody(null)).length === 0);
check('an array is empty, not an object with numbered keys', Object.keys(asBody(['pay'])).length === 0);
check('a string is empty', Object.keys(asBody('pay')).length === 0);
check('a number is empty', Object.keys(asBody(12)).length === 0);
check('a text field', textField({ note: 'sent' }, 'note') === 'sent');
check('a non-string field reads as empty', textField({ note: 12 }, 'note') === '' && textField({}, 'note') === '');

console.log('\n\u2014 a row id \u2014');
check('digits', readRowId('12') === '12');
check('a whole number', readRowId(12) === '12');
check('with space around it', readRowId(' 12 ') === '12');
check('zero is not one', readRowId('0') === '' && readRowId(0) === '');
check('a leading zero is not one', readRowId('012') === '');
check('negative is not one', readRowId('-1') === '' && readRowId(-1) === '');
check('a fraction is not one', readRowId('1.5') === '' && readRowId(1.5) === '');
check('past the safe range is not one', readRowId('9007199254740993') === '' && readRowId(2 ** 60) === '');
check('text is not one', readRowId('abc') === '' && readRowId('12abc') === '');
check('nothing is not one', readRowId('') === '' && readRowId(null) === '' && readRowId(undefined) === '');
check('an array is not one', readRowId(['12']) === '');
{
  const missing = heard(readRequestId(undefined).ok ? null : (readRequestId(undefined) as { refusal: Refusal }).refusal, false);
  check('a missing request id is a 400', missing?.status === 400, missing);
  const blank = readRequestId('');
  check('a blank one too', !blank.ok && blank.refusal.status === 400, blank);
  const junk = readRequestId('abc');
  check('a malformed one is simply not found', !junk.ok && junk.refusal.status === 404, junk);
  if (!junk.ok) heard(junk.refusal, false);
  const good = readRequestId('7');
  check('a good one is read', good.ok && good.id === '7', good);
}

console.log('\n\u2014 the ids an affiliate chooses \u2014');
{
  const ok = readConversionIds(['1', '2', '3']);
  check('strings are read', ok.ok && ok.ids.join() === '1,2,3', ok);
  const numbers = readConversionIds([4, '5']);
  check('whole numbers are read as strings', numbers.ok && numbers.ids.join() === '4,5', numbers);
  const order = readConversionIds(['9', '2']);
  check('in the order given', order.ok && order.ids.join() === '9,2', order);
  /*
   * Duplicates are passed through rather than quietly merged, so the answer
   * comes from validateRequestedIds and says the same thing the database
   * would. A silent merge would turn a client bug into a request nobody
   * noticed was different from what was sent.
   */
  const twice = readConversionIds(['1', '1']);
  check('a duplicate is passed on for the request check to refuse', twice.ok && twice.ids.length === 2, twice);
  const none = readConversionIds([]);
  check('an empty list is passed on for the request check to refuse', none.ok && none.ids.length === 0, none);
  // Conversion ids are row ids on Supabase and "<row>:<hash>" on the Sheets
  // store, so the shape is left to the store; this only refuses what no store
  // could mean.
  const sheets = readConversionIds(['14:a1b2c3']);
  check('an id in another store shape is read', sheets.ok && sheets.ids[0] === '14:a1b2c3', sheets);

  for (const [name, value] of [
    ['missing', undefined],
    ['null', null],
    ['a single id rather than a list', '1'],
    ['an object', { 0: '1' }],
    ['a list holding an object', [{ id: '1' }]],
    ['a list holding null', ['1', null]],
    ['a list holding an empty string', ['']],
    ['a list holding a fraction', [1.5]],
    ['a list holding a negative', [-3]],
    ['a list holding a very long string', ['1'.repeat(65)]],
  ] as const) {
    const result = readConversionIds(value);
    check(`${name} is refused`, !result.ok, result);
    if (!result.ok) {
      check(`${name} is a 400`, result.refusal.status === 400, result.refusal);
      heard(result.refusal, true);
    }
  }
  check('the cap is 200', MAX_CARDS_PER_REQUEST === 200);
  const atCap = readConversionIds(Array.from({ length: 200 }, (_, i) => String(i + 1)));
  check('200 is allowed', atCap.ok);
  const overCap = readConversionIds(Array.from({ length: 201 }, (_, i) => String(i + 1)));
  check('201 is refused', !overCap.ok, overCap);
  if (!overCap.ok) {
    check('as a 422', overCap.refusal.status === 422, overCap.refusal);
    heard(overCap.refusal, true);
  }
}

console.log('\n\u2014 who may ask to be paid \u2014');
check('an affiliate may not request: payouts are monthly now', heard(payslipGate(SAM, 'request'), true)?.error === 'Payouts are now sent monthly, so there is nothing to request.');
check('an affiliate may confirm', payslipGate(SAM, 'confirm') === null);
check('nor an admin in Client View', payslipGate(VIEWING, 'request')?.status === 403);
check('and confirm', payslipGate(VIEWING, 'confirm') === null);
{
  const admin = heard(payslipGate(ADMIN, 'request'), true);
  check('a plain admin may not request', admin?.status === 403, admin);
  check('and is told only an affiliate can', admin?.error === 'Only an affiliate can request a payment.', admin);
  const adminConfirm = heard(payslipGate(ADMIN, 'confirm'), true);
  check('nor confirm somebody else\u2019s payment', adminConfirm?.status === 403, adminConfirm);
  const noId = heard(payslipGate({ ...SAM, id: '' }, 'request'), true);
  check('an account with no id has no payslips', noId?.status === 403 && noId.error === 'This account has no payslips of its own.', noId);
  const noIdConfirm = payslipGate({ ...SAM, id: '' }, 'confirm');
  check('for confirming either', noIdConfirm?.status === 403, noIdConfirm);
  const noKey = heard(payslipGate({ ...SAM, usr: '' }, 'request'), true);
  check('no tracking key, nothing to request', noKey?.status === 403 && noKey.error === 'Your account has no tracking key, so nothing can be requested.', noKey);
  check('but a payment already made can still be confirmed', payslipGate({ ...SAM, usr: '' }, 'confirm') === null);
  const lgf = heard(payslipGate(SAM, 'request', true), true);
  check('an LGF employee may not request', lgf?.status === 403 && lgf.error === 'LGF employees are not paid through payout requests.', lgf);
  check('nor through Client View', payslipGate(VIEWING, 'request', true)?.status === 403);
  check('but may still confirm a payment', payslipGate(SAM, 'confirm', true) === null);
  check('an admin is still refused as an admin', payslipGate(ADMIN, 'request', true)?.error === 'Only an affiliate can request a payment.');
}
check('request is an action', readPayslipAction('request') === 'request');
check('confirm is an action', readPayslipAction('confirm') === 'confirm');
check('pay is not an affiliate action', readPayslipAction('pay') === null);
check('nothing is not an action', readPayslipAction(undefined) === null && readPayslipAction('') === null);
check('case matters', readPayslipAction('Request') === null);

console.log('\n\u2014 the audit line \u2014');
check('an affiliate is themself', requestedByFor(SAM) === 'sam');
check('Client View names the admin behind it (A7)', requestedByFor(VIEWING) === 'sam (via alex)', requestedByFor(VIEWING));

console.log('\n\u2014 what a request is priced from \u2014');
{
  const rows: Conversion[] = [
    { id: '1', createdAt: '', approvedOn: '2026-07-01', slug: 'card', usr: 'sam', amount: 35.5, notes: 'private' },
    { id: '2', createdAt: '', approvedOn: '2026-07-02', slug: 'card', usr: 'sam', amount: 40, notes: '' },
  ];
  const own = candidatesFrom({ conversions: rows, gross: false });
  check('an affiliate load becomes candidates', own !== null && own.length === 2, own);
  check('carrying only what the check needs', own !== null && JSON.stringify(own[0]) === JSON.stringify({ id: '1', usr: 'sam', approvedOn: '2026-07-01', amount: 35.5 }), own);
  /*
   * A gross load is the merchant's money. Recording it as somebody's request
   * would snapshot the wrong figure onto a payslip forever, so it is refused
   * outright rather than trusted to never happen.
   */
  check('a gross load is never priced from', candidatesFrom({ conversions: rows, gross: true }) === null);
}

console.log('\n\u2014 a request that did not go through \u2014');
{
  const conflict = heard(requestFailure(new StoreConflictError('anything')), true);
  check('a conflict is a 409', conflict.status === 409, conflict);
  check('saying the card is already on a request', conflict.error === 'One of those approvals is already on a request.', conflict);
  const invalid = heard(requestFailure(new StoreValidationError('The same card was selected twice.')), true);
  check('a validation error is a 422 with its own sentence', invalid.status === 422 && invalid.error === 'The same card was selected twice.', invalid);
  const config = heard(requestFailure(new StoreConfigError('Payout requests need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.')), true);
  check('a missing database is a 503', config.status === 503, config);
  const gone = heard(requestFailure(new StoreNotFoundError('That account no longer exists.')), true);
  check('a vanished account is a 404', gone.status === 404 && gone.error === 'That account no longer exists.', gone);
  const raw = heard(requestFailure(new Error('reading a payout request: permission denied for table users (42501) at user u-other')), true);
  check('anything else is a 500', raw.status === 500, raw);
  check('whose raw text never reaches an affiliate', !raw.error.includes('u-other') && !raw.error.includes('42501'), raw);
  const thrown = requestFailure('a string was thrown');
  check('even when what was thrown is not an Error', thrown.status === 500 && thrown.error !== 'a string was thrown', thrown);
  const dashed = heard(requestFailure(new StoreValidationError('Nope \u2014 not today.')), true);
  check('a store sentence with a dash in it is replaced', !DASHES.test(dashed.error) && dashed.status === 422, dashed);
}

console.log('\n\u2014 a store error, for the admin route \u2014');
{
  const conflict = storeFailure(new StoreConflictError('Only an unpaid request can be cancelled.'), 'That did not save.');
  check('conflict 409 with its sentence', conflict.status === 409 && conflict.error === 'Only an unpaid request can be cancelled.', conflict);
  const missing = storeFailure(new StoreNotFoundError('That request no longer exists.'), 'That did not save.');
  check('missing 404 with its sentence', missing.status === 404 && missing.error === 'That request no longer exists.', missing);
  const invalid = storeFailure(new StoreValidationError('Those cards could not be read.'), 'That did not save.');
  check('invalid 422', invalid.status === 422, invalid);
  const config = storeFailure(new StoreConfigError('Set SUPABASE_URL.'), 'That did not save.');
  check('config 503', config.status === 503 && config.error === 'Set SUPABASE_URL.', config);
  const hidden = storeFailure(new Error('recording a payment: boom (XX000)'), 'That did not save.');
  check('by default an unknown error shows the fallback', hidden.status === 500 && hidden.error === 'That did not save.', hidden);
  const shown = storeFailure(new Error('recording a payment: boom (XX000)'), 'That did not save.', { showUnknown: true });
  check('an admin route may show it', shown.status === 500 && shown.error === 'recording a payment: boom (XX000)', shown);
  const dashedShown = storeFailure(new Error('boom \u2013 bang'), 'That did not save.', { showUnknown: true });
  check('but never with a dash in it', dashedShown.error === 'That did not save.', dashedShown);
  const emptyConfig = storeFailure(new StoreConfigError(''), 'That did not save.');
  check('an empty store sentence falls back', emptyConfig.status === 503 && emptyConfig.error === 'That did not save.', emptyConfig);
  heard(hidden, false);
}

console.log('\n\u2014 what an admin may do to a request in each state \u2014');
check('pay action', readPayoutAction('pay') === 'pay');
check('clear action', readPayoutAction('clear') === 'clear');
check('proof action', readPayoutAction('proof') === 'proof');
check('remove-proof action', readPayoutAction('remove-proof') === 'remove-proof');
check('cancel action', readPayoutAction('cancel') === 'cancel');
check('confirm is not an admin action', readPayoutAction('confirm') === null);
check('nothing is not an action', readPayoutAction(undefined) === null && readPayoutAction(7) === null);
for (const action of ['pay', 'clear', 'proof', 'remove-proof'] as const) {
  check(`${action} on a requested request`, stateRefusal(action, 'requested') === null);
  check(`${action} on a paid request`, stateRefusal(action, 'paid') === null);
  const refused = heard(stateRefusal(action, 'cancelled'), false);
  check(`${action} on a cancelled request is a 409`, refused?.status === 409, refused);
  // A write that matched no row is a cancel that landed underneath it, and
  // says the same thing the up-front guard does.
  const unmatched = cancelledRefusal(action);
  check(`${action} that matched nothing says the same`, unmatched.status === 409 && unmatched.error === refused?.error, unmatched);
}
check('pay on a cancelled request, in the spec\u2019s words', stateRefusal('pay', 'cancelled')?.error === 'That request was cancelled and cannot be paid.');
check('cancel a requested request', stateRefusal('cancel', 'requested') === null);
{
  const paid = heard(stateRefusal('cancel', 'paid'), false);
  check('cancel a paid request is a 409', paid?.status === 409 && paid.error === 'Only an unpaid request can be cancelled.', paid);
  check('and says to clear it first', /clear/i.test(paid?.hint ?? ''), paid);
  const again = heard(stateRefusal('cancel', 'cancelled'), false);
  check('cancel a cancelled request is a 409', again?.status === 409, again);
}

console.log('\n\u2014 a payment, before it is recorded \u2014');
{
  const TODAY = '2026-10-10';
  const ASKED = '2026-10-03T09:15:00.000+00:00';
  function pay(body: Record<string, unknown>) {
    return readPayment(body, TODAY, ASKED);
  }
  const good = pay({ amount: 140, paidOn: '2026-10-08', reference: 'TX-1', note: 'wire' });
  check('a good payment is read', good.ok, good);
  if (good.ok) {
    check('its amount', good.payment.amount === 140);
    check('its day', good.payment.paidOn === '2026-10-08');
    check('its reference and note', good.payment.reference === 'TX-1' && good.payment.note === 'wire');
  }
  const text = pay({ amount: '140.505', paidOn: '2026-10-08' });
  check('an amount typed as text is read, and rounded to cents', text.ok && text.payment.amount === 140.51, text);
  const cents = pay({ amount: 0.1 + 0.2, paidOn: '2026-10-08' });
  check('float noise is rounded away', cents.ok && cents.payment.amount === 0.3, cents);
  const zero = pay({ amount: 0, paidOn: '2026-10-08' });
  check('zero is a figure somebody can mean', zero.ok && zero.payment.amount === 0, zero);
  const noDay = pay({ amount: 10 });
  check('no day means today', noDay.ok && noDay.payment.paidOn === TODAY, noDay);
  const onAsked = pay({ amount: 10, paidOn: '2026-10-03' });
  check('paid the day it was asked for', onAsked.ok, onAsked);
  const missingRef = pay({ amount: 10, reference: 5 });
  check('a non-string reference is empty', missingRef.ok && missingRef.payment.reference === '', missingRef);

  function refusedField(name: string, body: Record<string, unknown>, field: 'amount' | 'paidOn', sentence?: string) {
    const result = pay(body);
    check(name, !result.ok, result);
    if (result.ok) return;
    heard(result.refusal, false);
    check(`${name}: a 422`, result.refusal.status === 422, result.refusal);
    check(`${name}: on ${field}`, typeof result.refusal.fields?.[field] === 'string', result.refusal);
    if (sentence) check(`${name}: says so`, result.refusal.fields?.[field] === sentence, result.refusal.fields);
  }
  refusedField('no amount', { paidOn: '2026-10-08' }, 'amount', 'What was sent.');
  // Number('') and Number(null) are both 0, which would record a payment of nothing.
  refusedField('an empty amount is not zero', { amount: '', paidOn: '2026-10-08' }, 'amount');
  refusedField('a null amount is not zero', { amount: null, paidOn: '2026-10-08' }, 'amount');
  refusedField('a boolean amount', { amount: true, paidOn: '2026-10-08' }, 'amount');
  refusedField('a negative amount', { amount: -5, paidOn: '2026-10-08' }, 'amount');
  refusedField('a negative amount as text', { amount: '-5', paidOn: '2026-10-08' }, 'amount');
  refusedField('hex', { amount: '0x10', paidOn: '2026-10-08' }, 'amount');
  refusedField('exponent', { amount: '1e3', paidOn: '2026-10-08' }, 'amount');
  refusedField('infinity', { amount: 'Infinity', paidOn: '2026-10-08' }, 'amount');
  refusedField('not a number', { amount: 'lots', paidOn: '2026-10-08' }, 'amount');
  refusedField('a million and a cent', { amount: 1_000_000.01, paidOn: '2026-10-08' }, 'amount', 'That is larger than any payout this app has made. Check the figure.');
  check('a million exactly is allowed', pay({ amount: 1_000_000, paidOn: '2026-10-08' }).ok);
  refusedField('tomorrow', { amount: 10, paidOn: '2026-10-11' }, 'paidOn', 'The day it was sent. It cannot be in the future.');
  refusedField('not a day', { amount: 10, paidOn: '2026-02-30' }, 'paidOn');
  refusedField('a timestamp is not a day', { amount: 10, paidOn: '2026-10-08T10:00:00Z' }, 'paidOn');
  refusedField('before it was asked for', { amount: 10, paidOn: '2026-10-02' }, 'paidOn', 'This request was not made until 3 Oct 2026.');
  {
    const both = pay({ amount: 'lots', paidOn: '2026-10-11' });
    check('both fields at once', !both.ok && Boolean(both.refusal.fields?.amount) && Boolean(both.refusal.fields?.paidOn), both);
  }
  const noAsked = readPayment({ amount: 10, paidOn: '2020-01-01' }, TODAY, '');
  check('an unreadable request day does not block a payment', noAsked.ok, noAsked);
}

console.log('\n\u2014 who may open a receipt \u2014');
check('the person paid', mayReadReceipt(SAM, 'u-sam'));
check('an admin, anybody\u2019s', mayReadReceipt(ADMIN, 'u-sam'));
check('another affiliate, nobody\u2019s but their own', !mayReadReceipt(SAM, 'u-other'));
check('an admin in Client View only sees what that affiliate would', mayReadReceipt(VIEWING, 'u-sam') && !mayReadReceipt(VIEWING, 'u-other'));
check('a blank id never matches a blank owner', !mayReadReceipt({ ...SAM, id: '' }, ''));

console.log('\n\u2014 house rules on every sentence \u2014');
check('there were sentences to check', said.length >= 20, said.length);
const AFFILIATE_WORDS = /\bshare\b|commission|gross|split|%/i;
for (const { text, affiliate } of said) {
  check(`no dash: ${text}`, !DASHES.test(text));
  check(`ends as a sentence: ${text}`, /[.?]$/.test(text));
  if (affiliate) check(`nothing about shares: ${text}`, !AFFILIATE_WORDS.test(text));
}

console.log('\n\u2014 the route files themselves \u2014');
/*
 * The strings in the routes that are not from lib/payout-api: the gate
 * messages, the receipt refusals. Comments are exempt from the dash rule, so
 * they are stripped before looking. What is left is code and the strings in it.
 */
function codeOf(path: string): string {
  const source = readFileSync(join(process.cwd(), path), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function literalsOf(code: string): string[] {
  const found: string[] = [];
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of code.matchAll(pattern)) found.push(match[1] ?? match[2] ?? match[3] ?? '');
  return found;
}
const ROUTES = {
  payslips: 'src/app/api/payslips/route.ts',
  payouts: 'src/app/api/payouts/route.ts',
  receipt: 'src/app/api/payouts/receipt/route.ts',
};
const LIBS = ['src/lib/payout-api.ts', 'src/lib/receipt-file.ts'];
for (const path of [...Object.values(ROUTES), ...LIBS]) {
  let code = '';
  try {
    code = codeOf(path);
  } catch {
    code = '';
  }
  check(`${path} is on disk`, code !== '', path);
  if (!code) continue;
  check(`${path}: no dash outside comments`, !DASHES.test(code), code.split('\n').filter((line) => DASHES.test(line)));
  check(`${path}: CRLF`, readFileSync(join(process.cwd(), path), 'utf8').split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r')));
}
for (const path of [ROUTES.payslips, ROUTES.receipt]) {
  let code = '';
  try {
    code = codeOf(path);
  } catch {
    continue;
  }
  const words = literalsOf(code).filter((text) => AFFILIATE_WORDS.test(text));
  check(`${path}: no string an affiliate could see names a share`, words.length === 0, words);
}
{
  let code = '';
  try {
    code = codeOf(ROUTES.receipt);
  } catch {
    code = '';
  }
  if (code) {
    /*
     * Order is the point of this route: who owns it, then whether they may,
     * and only then the bytes. Checked on the text, since there is no harness
     * that could count the queries.
     */
    const owner = code.indexOf('readPayoutRequestOwner(');
    const allowed = code.indexOf('mayReadReceipt(');
    const bytes = code.indexOf('readPayoutRequestProof(');
    check('receipt: reads the owner', owner !== -1);
    check('receipt: checks the viewer against it', allowed !== -1);
    check('receipt: reads the bytes', bytes !== -1);
    check('receipt: owner before permission before bytes', owner < allowed && allowed < bytes, { owner, allowed, bytes });
    check('receipt: headers come from receiptHeaders, which sets nosniff', code.includes('receiptHeaders('));
    /*
     * Somebody else's request answers exactly as a missing one does. Request
     * ids are sequential, so a 403 of its own would let any signed-in
     * affiliate walk them and learn which exist, and so how many requests
     * there are. The payslip page gives the same 404 for the same reason.
     */
    check(
      'receipt: a request that is not yours reads as one that does not exist',
      /if\s*\(\s*!mayReadReceipt\([^)]*\)\s*\)\s*\{?\s*return\s+refuse\(\s*noSuchRequest\(\)\s*\)/.test(code),
    );
    check('receipt: no answer of its own for somebody else’s request', !/status:\s*403/.test(code) && !/not yours/i.test(code));
  }
  let payouts = '';
  try {
    payouts = codeOf(ROUTES.payouts);
  } catch {
    payouts = '';
  }
  if (payouts) {
    check('payouts: admin only', payouts.includes('requireApiAdmin('));
    check('payouts: the upload is checked by its bytes', payouts.includes('checkReceiptUpload('));
    check('payouts: no old period re-derivation', !payouts.includes('periodFor') && !payouts.includes('payout-store\''));
  }
  let payslips = '';
  try {
    payslips = codeOf(ROUTES.payslips);
  } catch {
    payslips = '';
  }
  if (payslips) {
    check('payslips: ids go through validateRequestedIds', payslips.includes('validateRequestedIds('));
    check('payslips: the gate is the session', payslips.includes('viewerFromRequest(') && payslips.includes('payslipGate('));
    check('payslips: whose request comes from the viewer, not the body', /userId:\s*viewer\.id/.test(payslips) && /usr:\s*viewer\.usr/.test(payslips));
    check('payslips: the body is never asked who it is', !/body\.(userId|usr|user|requestedBy)/.test(payslips));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
