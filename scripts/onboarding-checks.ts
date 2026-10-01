// The onboarding gate, the field rules, and the sealing of the two numbers
// that must never be readable from a database dump.
//
// These are the decisions a type check cannot catch: which step comes next,
// whether the app is barred, whether a redirect loops, whether a nine-digit
// number survives a round trip through AES-256-GCM. The pages are wiring
// around this; this is the part that can be wrong.
//
//   npx tsx scripts/onboarding-checks.ts

import {
  agreementProblems,
  bankProblems,
  isRoutingNumber,
  canOpen,
  firstMissingRequired,
  gateFor,
  isBlocked,
  isComplete,
  isLocked,
  keepsAccountNumber,
  keepsPassword,
  keepsTin,
  looksLikeEmail,
  looksLikePhone,
  looksSigned,
  needsForeignPartnersQuestion,
  nextStep,
  NOTHING_DONE,
  previousStep,
  profileProblems,
  progressOf,
  STEPS,
  stepPosition,
  stepsFor,
  w9Problems,
  WAIVED_HOME,
  waivedSteps,
  type OnboardingState,
  type W9Input,
} from '../src/lib/onboarding';
import {
  digitsOf,
  formatTin,
  formatTinAsTyped,
  last4,
  maskAccount,
  maskTin,
  tinMaxLength,
  validTin,
} from '../src/lib/mask';
import { open, seal, sealedMatches, SecretBoxError, secretsConfigured } from '../src/lib/secret-box';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

function state(over: Partial<OnboardingState> = {}): OnboardingState {
  return { ...NOTHING_DONE, ...over };
}

const ALL_DONE = state({ profile: true, agreement: true, w9: true, bank: true });
/** The realistic middle: everything required is signed, the bank step is not. */
const DOCS_DONE = state({ profile: true, agreement: true, w9: true });

console.log('— the order of things —');
check('a fresh account starts at the details', nextStep(NOTHING_DONE)?.key === 'profile');
check('and is barred from the app', isBlocked(NOTHING_DONE));
check('the details come first', STEPS[0]!.key === 'profile');
check('the bank step comes last', STEPS[STEPS.length - 1]!.key === 'bank');
check('and it is the only optional one', STEPS.filter((s) => !s.required).length === 1);
check(
  'the three documents are all required',
  ['profile', 'agreement', 'w9'].every((k) => STEPS.find((s) => s.key === k)!.required),
);

check('after the details comes the agreement', nextStep(state({ profile: true }))?.key === 'agreement');
check(
  'after the agreement comes the W-9',
  nextStep(state({ profile: true, agreement: true }))?.key === 'w9',
);
check('after the W-9 comes the bank', nextStep(DOCS_DONE)?.key === 'bank');
check('and then nothing', nextStep(ALL_DONE) === null);

console.log('\n— what bars the app —');
check('the signed documents lift the bar', !isBlocked(DOCS_DONE));
check('even though onboarding is not finished', !isComplete(DOCS_DONE));
check('only all four count as finished', isComplete(ALL_DONE));
check('a missing W-9 bars it', isBlocked(state({ profile: true, agreement: true })));
check('a missing agreement bars it', isBlocked(state({ profile: true, w9: true })));
check('and names the earliest missing one', firstMissingRequired(state({ profile: true, w9: true }))?.key === 'agreement');
check('nothing is missing once the documents are in', firstMissingRequired(DOCS_DONE) === null);

console.log('\n— progress —');
check('nothing done is zero of four', progressOf(NOTHING_DONE).done === 0);
check('and four is the total', progressOf(NOTHING_DONE).total === STEPS.length);
check('the documents are three of four', progressOf(DOCS_DONE).done === 3);
check('everything is four of four', progressOf(ALL_DONE).done === 4);

console.log('\n— which steps can be opened —');
check('the first is always open', canOpen(NOTHING_DONE, 'profile'));
check('the agreement is not, before the details', !canOpen(NOTHING_DONE, 'agreement'));
check('the W-9 is not, before the agreement', !canOpen(state({ profile: true }), 'w9'));
check('the agreement opens once the details are in', canOpen(state({ profile: true }), 'agreement'));
check('the bank step opens once the W-9 is in', canOpen(DOCS_DONE, 'bank'));
// Signing an agreement on an account whose password an admin still knows is
// signing as somebody else, which is the whole reason for the ordering.
check('a signed W-9 does not unlock a skipped agreement', !canOpen(state({ profile: true, w9: true }), 'w9'));

console.log('\n— the gate —');
check('a barred affiliate is sent to their first step', gateFor('/', NOTHING_DONE) === '/welcome');
check('from anywhere in the app', gateFor('/links', NOTHING_DONE) === '/welcome');
check('and to the earliest one still missing', gateFor('/links', state({ profile: true })) === '/welcome/agreement');
check('once the documents are in, the app opens', gateFor('/', DOCS_DONE) === null);
check('including the pages behind it', gateFor('/cpa', DOCS_DONE) === null);
check('a finished account is never gated', gateFor('/links', ALL_DONE) === null);

// The loop this function exists to avoid: the welcome pages must never send
// somebody back to a welcome page they are already allowed to be on.
check('the current step is not redirected away from', gateFor('/welcome', NOTHING_DONE) === null);
check('nor the agreement once it is reachable', gateFor('/welcome/agreement', state({ profile: true })) === null);
check('nor the W-9', gateFor('/welcome/w9', state({ profile: true, agreement: true })) === null);
check('nor the bank step', gateFor('/welcome/bank', DOCS_DONE) === null);

check('a step reached too early moves them back', gateFor('/welcome/w9', NOTHING_DONE) === '/welcome');

/*
 * Going back is the point of the Back button, so these two say the opposite of
 * what they used to. A completed step is a page, not a closed door: the flow is
 * still ordered forwards — nothing above lets anybody skip ahead — but a step
 * already done can be opened and read.
 */
check('a step already done can be opened again', gateFor('/welcome', state({ profile: true })) === null);
check('including the last one, with everything finished', gateFor('/welcome/bank', ALL_DONE) === null);
check('and a signed agreement', gateFor('/welcome/agreement', ALL_DONE) === null);
check('an unknown welcome path lands on the next real one', gateFor('/welcome/nope', DOCS_DONE) === '/welcome/bank');

/*
 * The one that would be a real bug: an affiliate who has signed everything
 * required but skipped the bank step must not be bounced between the app and
 * the bank form. Walking both directions proves the two rules agree.
 */
check('a soft-skipped bank step does not trap them in the app', gateFor('/', DOCS_DONE) === null);
check('and does not trap them in the form', gateFor('/welcome/bank', DOCS_DONE) === null);

console.log('\n— the details step —');
const goodProfile = {
  fullName: 'Arthur Reyes',
  email: 'arthur@example.com',
  position: 'Affiliate',
  mobile: '+1 415 555 0123',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};
check('a filled form has no problems', Object.keys(profileProblems(goodProfile)).length === 0);
check('a missing name is caught', Boolean(profileProblems({ ...goodProfile, fullName: ' ' }).fullName));
check('a missing position is caught', Boolean(profileProblems({ ...goodProfile, position: '' }).position));
check('a bad email is caught', Boolean(profileProblems({ ...goodProfile, email: 'arthur' }).email));
check('a short password is caught', Boolean(profileProblems({ ...goodProfile, password: 'short', confirmPassword: 'short' }).password));
check(
  'a mismatch is caught',
  Boolean(profileProblems({ ...goodProfile, confirmPassword: 'something-else-entirely' }).confirmPassword),
);
// A short password is already wrong; saying so twice reads as two mistakes.
check(
  'and a short password is not also blamed for mismatching',
  !profileProblems({ ...goodProfile, password: 'short', confirmPassword: 'other' }).confirmPassword,
);

check('an email needs a dot in the domain', !looksLikeEmail('arthur@example'));
check('a plus address is fine', looksLikeEmail('arthur+ledger@example.com'));
check('a seven-digit number is a number', looksLikePhone('5550123'));
check('six digits is not', !looksLikePhone('555012'));
check('sixteen digits is not', !looksLikePhone('12345678901234567'));
check('punctuation is not counted', looksLikePhone('(415) 555-0123'));

console.log('\n— the agreement —');
const inked = 'data:image/png;base64,' + 'A'.repeat(900);
const goodAgreement = {
  affiliateName: 'Arthur Reyes',
  affiliateEmail: 'arthur@example.com',
  address: { line1: '1 Example Street', line2: '', city: 'Austin', state: 'TX', postalCode: '78701' },
  effectiveDate: '2026-08-24',
  signaturePng: inked,
  affirmed: true,
};
check('a signed agreement has no problems', Object.keys(agreementProblems(goodAgreement)).length === 0);
check('an unticked box is caught', Boolean(agreementProblems({ ...goodAgreement, affirmed: false }).affirmed));
check(
  'a missing street is caught',
  Boolean(agreementProblems({ ...goodAgreement, address: { ...goodAgreement.address, line1: '' } }).addressLine1),
);
check(
  'an unpicked state is caught',
  Boolean(agreementProblems({ ...goodAgreement, address: { ...goodAgreement.address, state: '' } }).addressState),
);
check(
  'and a state that is not one is caught',
  Boolean(agreementProblems({ ...goodAgreement, address: { ...goodAgreement.address, state: 'XX' } }).addressState),
);
check(
  'a four-digit ZIP is caught',
  Boolean(agreementProblems({ ...goodAgreement, address: { ...goodAgreement.address, postalCode: '7870' } }).addressPostalCode),
);
// Most addresses have no second line, and requiring one would be requiring
// people to invent an apartment number.
check(
  'no apartment is not a problem',
  Object.keys(agreementProblems({ ...goodAgreement, address: { ...goodAgreement.address, line2: '' } })).length === 0,
);
check('a half-typed date is caught', Boolean(agreementProblems({ ...goodAgreement, effectiveDate: '2026-08' }).effectiveDate));
// An untouched signature pad still exports a PNG, so a short one is a blank one.
check('an untouched pad is not a signature', Boolean(agreementProblems({ ...goodAgreement, signaturePng: 'data:image/png;base64,AAAA' }).signaturePng));
check('nor is a jpeg', !looksSigned('data:image/jpeg;base64,' + 'A'.repeat(900)));
check('nor an empty string', !looksSigned(''));
check('a real one is', looksSigned(inked));

console.log('\n— the W-9 —');
const goodW9: W9Input = {
  line1Name: 'Arthur Reyes',
  line2Business: '',
  classification: 'individual',
  llcCode: '',
  otherText: '',
  foreignPartners: false,
  exemptPayeeCode: '',
  fatcaCode: '',
  address: '1 Example Street',
  cityStateZip: 'Austin, TX 78701',
  accountNumbers: '',
  tinType: 'ssn',
  tin: '123-45-6789',
  signaturePng: inked,
  certified: true,
};
check('a filled W-9 has no problems', Object.keys(w9Problems(goodW9)).length === 0);
check('line 1 is required, as the form says', Boolean(w9Problems({ ...goodW9, line1Name: '' }).line1Name));
check('line 2 is genuinely optional', Object.keys(w9Problems({ ...goodW9, line2Business: '' })).length === 0);
check('a box must be checked', Boolean(w9Problems({ ...goodW9, classification: '' }).classification));
check('line 5 is required', Boolean(w9Problems({ ...goodW9, address: '' }).address));
check('line 6 is required', Boolean(w9Problems({ ...goodW9, cityStateZip: '' }).cityStateZip));
check('line 7 is optional', Object.keys(w9Problems({ ...goodW9, accountNumbers: '' })).length === 0);

check('the LLC box needs its letter', Boolean(w9Problems({ ...goodW9, classification: 'llc', llcCode: '' }).llcCode));
check('and only C, S or P', Boolean(w9Problems({ ...goodW9, classification: 'llc', llcCode: 'X' }).llcCode));
check('C is fine', Object.keys(w9Problems({ ...goodW9, classification: 'llc', llcCode: 'C' })).length === 0);
check('"other" needs saying what', Boolean(w9Problems({ ...goodW9, classification: 'other', otherText: '' }).otherText));

check('a TIN is nine digits', Boolean(w9Problems({ ...goodW9, tin: '123-45-678' }).tin));
check('formatting is not counted', Object.keys(w9Problems({ ...goodW9, tin: '123 45 6789' })).length === 0);
check('an EIN works too', Object.keys(w9Problems({ ...goodW9, tinType: 'ein', tin: '12-3456789' })).length === 0);
check('one of the two must be chosen', Boolean(w9Problems({ ...goodW9, tinType: '' }).tinType));
check('an unsigned W-9 is caught', Boolean(w9Problems({ ...goodW9, signaturePng: '' }).signaturePng));
// Part II is signed under penalties of perjury. The database refuses a row
// without it too — this is the half that says so before the round trip.
check('an uncertified W-9 is caught', Boolean(w9Problems({ ...goodW9, certified: false }).certified));

check('line 3b applies to a partnership', needsForeignPartnersQuestion('partnership', ''));
check('and to a trust or estate', needsForeignPartnersQuestion('trust_estate', ''));
check('and to an LLC taxed as one', needsForeignPartnersQuestion('llc', 'P'));
check('but not to an LLC taxed as a corporation', !needsForeignPartnersQuestion('llc', 'C'));
check('nor to an individual', !needsForeignPartnersQuestion('individual', ''));

console.log('\n— bank details —');
// 021000021 is a real, published routing number (JPMorgan Chase, New York): 3·0+7·2+1·1+3·0+7·0+1·0+3·0+7·2+1·1 = 30.
const goodBank = { accountName: 'Arthur Reyes', bankName: 'Example Bank', routingNumber: '021000021', accountNumber: '000123456789' };
check('a filled form has no problems', Object.keys(bankProblems(goodBank)).length === 0);
check('a missing name is caught', Boolean(bankProblems({ ...goodBank, accountName: '' }).accountName));
check('a missing bank is caught', Boolean(bankProblems({ ...goodBank, bankName: '' }).bankName));
check('three digits is not an account', Boolean(bankProblems({ ...goodBank, accountNumber: '123' }).accountNumber));
check('eighteen is not either', Boolean(bankProblems({ ...goodBank, accountNumber: '1'.repeat(18) }).accountNumber));
check('four is', Object.keys(bankProblems({ ...goodBank, accountNumber: '1234' })).length === 0);
check('and dashes do not count against it', Object.keys(bankProblems({ ...goodBank, accountNumber: '0001-2345-6789' })).length === 0);
check('a missing routing number is caught', Boolean(bankProblems({ ...goodBank, routingNumber: '' }).routingNumber));
check('eight digits is not a routing number', !isRoutingNumber('02100002'));
check('nor is ten', !isRoutingNumber('0210000210'));
check('a valid one passes', isRoutingNumber('021000021'));
check('so does another real one', isRoutingNumber('011000015'));
check('spaces and dashes are ignored', isRoutingNumber('0210-0002 1'));
check('one digit off fails the checksum', !isRoutingNumber('021000022'));
check('two digits swapped fail it too', !isRoutingNumber('201000021'));
check('a typo is reported on the field', Boolean(bankProblems({ ...goodBank, routingNumber: '021000022' }).routingNumber));
check('the routing number is required even when an account is on file', Boolean(bankProblems({ ...goodBank, routingNumber: '', accountNumber: '' }, { accountOnFile: true }).routingNumber));

console.log('\n— masking —');
check('digits are pulled out of formatting', digitsOf('(415) 555-0123') === '4155550123');
check('the last four are the last four', last4('123-45-6789') === '6789');
check('a short number gives what there is', last4('12') === '12');
check('an SSN mask keeps the SSN shape', maskTin('6789', 'ssn') === '•••-••-6789');
check('an EIN mask keeps the EIN shape', maskTin('6789', 'ein') === '••-•••6789');
check('an empty SSN still masks', maskTin('', 'ssn') === '•••-••-••••');
check('an account mask claims no length', maskAccount('6789') === '••••6789');
check('a mask never leaks more than four', !maskTin('123456789', 'ssn').includes('12345'));
check('nine digits is a TIN', validTin('123456789'));
check('eight is not', !validTin('12345678'));
check('ten is not', !validTin('1234567890'));
check('an SSN reads back with dashes', formatTin('123456789', 'ssn') === '123-45-6789');
check('an EIN reads back with its own dash', formatTin('123456789', 'ein') === '12-3456789');
check('anything else is handed back untouched', formatTin('12345', 'ssn') === '12345');

console.log('\n— sealing —');
/*
 * The key is set here rather than assumed. These checks have to run on a
 * machine with no .env, and the alternative — skipping when the key is absent —
 * is a suite that silently tests nothing on exactly the machine where a
 * mistake would ship.
 */
process.env.ONBOARDING_SECRET_KEY = 'a-test-key-that-is-long-enough-to-be-accepted';
check('a key makes sealing available', secretsConfigured());

const ssn = '123456789';
const sealed = seal(ssn);
check('a sealed value does not contain the plaintext', !sealed.includes(ssn));
check('it is versioned', sealed.startsWith('v1.'));
check('it opens back to what went in', open(sealed) === ssn);
check('two seals of the same number differ', seal(ssn) !== seal(ssn));
check('and both still open', open(seal(ssn)) === ssn && open(seal(ssn)) === ssn);
check('a long value round trips', open(seal('x'.repeat(4000))) === 'x'.repeat(4000));
check('so does one with unicode in it', open(seal('Ítem — ñ 東京')) === 'Ítem — ñ 東京');

check('comparing without printing works', sealedMatches(sealed, ssn));
check('and says no to the wrong number', !sealedMatches(sealed, '987654321'));

// GCM is authenticated, which is the whole reason for choosing it: an edited
// ciphertext must fail rather than decrypt to something else.
const parts = sealed.split('.');
const tampered = [parts[0], parts[1], parts[2], Buffer.from('999999999').toString('base64url')].join('.');
let refusedTamper = false;
try {
  open(tampered);
} catch (error) {
  refusedTamper = error instanceof SecretBoxError;
}
check('an edited ciphertext is refused, not decrypted', refusedTamper);

let refusedShape = false;
try {
  open('not-a-sealed-value');
} catch (error) {
  refusedShape = error instanceof SecretBoxError;
}
check('so is something that was never sealed', refusedShape);

// The key changing is the same failure as tampering, on purpose: telling them
// apart would tell an attacker which of the two they had got wrong.
process.env.ONBOARDING_SECRET_KEY = 'a-completely-different-key-of-sufficient-length';
let refusedKey = false;
try {
  open(sealed);
} catch (error) {
  refusedKey = error instanceof SecretBoxError;
}
check('a value sealed under another key will not open', refusedKey);

// Without a key there is nowhere safe to put an SSN, so the app refuses rather
// than quietly storing one in the clear.
process.env.ONBOARDING_SECRET_KEY = '';
check('no key means sealing is unavailable', !secretsConfigured());
let refusedMissing = false;
try {
  seal(ssn);
} catch (error) {
  refusedMissing = error instanceof SecretBoxError;
}
check('and sealing refuses rather than storing in the clear', refusedMissing);

console.log('\n— going back —');
check('the first step has nothing behind it', previousStep('profile') === null);
check('the agreement goes back to the details', previousStep('agreement')?.path === '/welcome');
check('the W-9 goes back to the agreement', previousStep('w9')?.path === '/welcome/agreement');
check('and the bank step goes back to the W-9', previousStep('bank')?.path === '/welcome/w9');
// Back and next are inverses everywhere the pair exists, which is what stops a
// Back button from landing somewhere the flow would immediately bounce off.
check(
  'back then forward is where you started',
  STEPS.slice(1).every((step, index) => previousStep(step.key)?.key === STEPS[index]?.key),
);

console.log('\n— what a revisit is allowed to leave alone —');
// A password already chosen: both boxes empty means keep it, and only then.
const revisitProfile = { ...goodProfile, password: '', confirmPassword: '' };
check(
  'a first visit still demands a password',
  Boolean(profileProblems(revisitProfile).password),
);
check(
  'a revisit with both boxes empty does not',
  Object.keys(profileProblems(revisitProfile, { passwordSet: true })).length === 0,
);
check('and that counts as keeping it', keepsPassword(revisitProfile, { passwordSet: true }));
check(
  'a revisit that types one still has to type it twice',
  Boolean(
    profileProblems(
      { ...goodProfile, password: 'a-long-enough-one', confirmPassword: '' },
      { passwordSet: true },
    ).confirmPassword,
  ),
);
check(
  'and a half-filled password is not mistaken for keeping it',
  !keepsPassword({ ...goodProfile, password: 'x', confirmPassword: '' }, { passwordSet: true }),
);

// A sealed taxpayer number: same idea, with the extra rule that the kind of
// number has to match, or nine digits end up filed as the wrong sort.
const blankTin: W9Input = { ...goodW9, tin: '' };
check('an empty taxpayer field is normally a problem', Boolean(w9Problems(blankTin).tin));
check(
  'but not when the same kind of number is already sealed away',
  Object.keys(w9Problems(blankTin, { tinOnFile: 'ssn' })).length === 0,
);
check('and that counts as keeping it', keepsTin(blankTin, { tinOnFile: 'ssn' }));
check(
  'switching SSN to EIN with an empty field is refused',
  Boolean(w9Problems({ ...blankTin, tinType: 'ein' }, { tinOnFile: 'ssn' }).tin),
);
check(
  'and is not mistaken for keeping it',
  !keepsTin({ ...blankTin, tinType: 'ein' }, { tinOnFile: 'ssn' }),
);
check(
  'a number typed in replaces rather than keeps',
  !keepsTin({ ...goodW9, tin: '987-65-4321' }, { tinOnFile: 'ssn' }),
);
check(
  'and is still checked for length',
  Boolean(w9Problems({ ...goodW9, tin: '12345' }, { tinOnFile: 'ssn' }).tin),
);

// The account number, which has no kind to match.
const blankAccount = { accountName: 'Arthur Reyes', bankName: 'Example Bank', routingNumber: '021000021', accountNumber: '' };
check('an empty account number is normally a problem', Boolean(bankProblems(blankAccount).accountNumber));
check(
  'but not when one is already on file',
  Object.keys(bankProblems(blankAccount, { accountOnFile: true })).length === 0,
);
check('and that counts as keeping it', keepsAccountNumber(blankAccount, { accountOnFile: true }));
check(
  'the name is still required either way',
  Boolean(bankProblems({ ...blankAccount, accountName: '' }, { accountOnFile: true }).accountName),
);
check(
  'and a number typed in is still checked',
  Boolean(
    bankProblems({ ...blankAccount, accountNumber: '12' }, { accountOnFile: true }).accountNumber,
  ),
);

console.log('\n— the dashes, as they are typed —');
check('nothing yet', formatTinAsTyped('', 'ssn') === '');
check('three digits stand alone', formatTinAsTyped('123', 'ssn') === '123');
check('the fourth brings a dash with it', formatTinAsTyped('1234', 'ssn') === '123-4');
check('and the sixth brings the second', formatTinAsTyped('123456', 'ssn') === '123-45-6');
check('a whole one is the whole shape', formatTinAsTyped('123456789', 'ssn') === '123-45-6789');
check('an EIN splits after two', formatTinAsTyped('123', 'ein') === '12-3');
check('and only there', formatTinAsTyped('123456789', 'ein') === '12-3456789');
/*
 * The one that keeps backspace working. If three digits formatted as `123-`
 * then deleting the fourth digit would put the dash straight back, the caret
 * could never get past it and the field would be stuck.
 */
check('a separator is never left dangling', !formatTinAsTyped('123', 'ssn').endsWith('-'));
check('nor on an EIN', !formatTinAsTyped('12', 'ein').endsWith('-'));
check('dashes already typed are not doubled', formatTinAsTyped('123-45-6789', 'ssn') === '123-45-6789');
check('anything not a digit is dropped', formatTinAsTyped('abc123def45', 'ssn') === '123-45');
check('a tenth digit has nowhere to go', formatTinAsTyped('1234567890123', 'ssn') === '123-45-6789');
check('and the field stops where the shape does', tinMaxLength('ssn') === '123-45-6789'.length);
check('for an EIN too', tinMaxLength('ein') === '12-3456789'.length);
// Typed all the way through, the live formatter and the on-file formatter agree.
check(
  'live and final formatting agree on a whole number',
  formatTinAsTyped('123456789', 'ssn') === formatTin('123456789', 'ssn'),
);
check(
  'and on an EIN',
  formatTinAsTyped('123456789', 'ein') === formatTin('123456789', 'ein'),
);

console.log('\n— what a waiver drops —');
const OPEN = { bypassed: true };
check('two steps are left, not four', stepsFor(OPEN).length === 2);
check('their own details', stepsFor(OPEN).some((step) => step.key === 'profile'));
check('and their bank details', stepsFor(OPEN).some((step) => step.key === 'bank'));
check('the agreement is not one of them', !stepsFor(OPEN).some((step) => step.key === 'agreement'));
check('nor the W-9', !stepsFor(OPEN).some((step) => step.key === 'w9'));
check('and the two dropped can be named', waivedSteps(OPEN).map((step) => step.key).join() === 'agreement,w9');
check('without a waiver nothing is dropped', waivedSteps().length === 0);
check('and all four still apply', stepsFor().length === 4);

console.log('\n— what a waiver opens —');
check('the first step, as always', canOpen(NOTHING_DONE, 'profile', OPEN));
check('the bank step, with nothing else done', canOpen(NOTHING_DONE, 'bank', OPEN));
/*
 * A waiver shortens what is required, not what is available. The two documents
 * stop being asked for and stop appearing in the queue, the count and the
 * banner; they do not stop being forms this person may want to fill in.
 *
 * They used to be refused outright, which made a waiver a door locked from the
 * outside: somebody who wanted their agreement on file had no way to put it
 * there. Not required and not permitted are different things, and only the
 * first one was ever meant.
 */
check('the agreement, which nobody is asking them for', canOpen(NOTHING_DONE, 'agreement', OPEN));
check('and the W-9', canOpen(NOTHING_DONE, 'w9', OPEN));
check('while without a waiver the W-9 is still behind the agreement', !canOpen(NOTHING_DONE, 'w9'));
check('and in either order', canOpen(state({ w9: true }), 'agreement', OPEN));
check('one already signed still opens, to be read back', canOpen(state({ profile: true, agreement: true }), 'agreement', OPEN));
check('and a W-9 already filed', canOpen(state({ w9: true }), 'w9', OPEN));
/*
 * What the waiver does change is what anybody is waiting on. Filling one in
 * must not turn it into work outstanding, or the banner and the queue would
 * start counting a form nobody asked for.
 */
check('the agreement is still not something they owe', !stepsFor(OPEN).some((step) => step.key === 'agreement'));
check('so signing it leaves the bank step next', nextStep(state({ profile: true, agreement: true, w9: true }), OPEN)?.key === 'bank');
check('and nothing required is outstanding either way', firstMissingRequired(state({ profile: true, agreement: true }), OPEN) === null);
// Without a waiver the corridor is unchanged.
check('the queue still holds for everybody else', !canOpen(state({ profile: true }), 'w9'));
check('and the default is no waiver', canOpen(state({ profile: true }), 'agreement'));

console.log('\n— counted over what is left —');
check('the bank step is the second of two', stepPosition('bank', OPEN).index === 2);
check('out of two', stepPosition('bank', OPEN).total === 2);
check('and the fourth of four without a waiver', stepPosition('bank').index === 4);
check('back from the bank step is their own details', previousStep('bank', OPEN)?.key === 'profile');
check('rather than the W-9 it sits behind normally', previousStep('bank')?.key === 'w9');
check('and there is nothing before the first', previousStep('profile', OPEN) === null);
check('onward from nothing is their own details', nextStep(NOTHING_DONE, OPEN)?.key === 'profile');
check('then the bank step, skipping both documents', nextStep(state({ profile: true }), OPEN)?.key === 'bank');
check('and nothing once the two are in', nextStep(state({ profile: true, bank: true }), OPEN) === null);
check('progress is out of two', progressOf(state({ profile: true }), OPEN).total === 2);
check('with one done', progressOf(state({ profile: true }), OPEN).done === 1);
check(
  'and a signature made before the waiver does not pad it',
  progressOf(state({ profile: true, agreement: true }), OPEN).done === 1,
);
check('nothing required is left once their details are in', firstMissingRequired(state({ profile: true }), OPEN) === null);
check('while the ordinary gate still wants the agreement', firstMissingRequired(state({ profile: true }))?.key === 'agreement');
check('complete means the two that apply', isComplete(state({ profile: true, bank: true }), OPEN));
check('which is not complete for anybody else', !isComplete(state({ profile: true, bank: true })));

console.log('\n— what a waiver lets past —');
check('the app is open with nothing filled in', gateFor('/', NOTHING_DONE, OPEN) === null);
check('and every page inside it', gateFor('/links', NOTHING_DONE, OPEN) === null);
check('without one, the same request is sent to step 1', gateFor('/links', NOTHING_DONE) === '/welcome');
// The two forms they can still fill in are still reachable, in either order.
check('the profile step is openable', gateFor('/welcome', NOTHING_DONE, OPEN) === null);
check('and the bank step, out of order', gateFor('/welcome/bank', NOTHING_DONE, OPEN) === null);
/*
 * Both documents are pages a waived account can walk to now, rather than
 * redirects. The profile list is still where an unknown path lands, because a
 * waived account has no "next step you owe" to be marched to.
 */
check('the waived home is their profile', WAIVED_HOME === '/profile');
check('the agreement opens with nothing signed', gateFor('/welcome/agreement', NOTHING_DONE, OPEN) === null);
check('and so does the W-9', gateFor('/welcome/w9', state({ profile: true }), OPEN) === null);
check('one they did sign opens too', gateFor('/welcome/agreement', state({ profile: true, agreement: true }), OPEN) === null);
check('an unknown welcome path lands on the list', gateFor('/welcome/nope', NOTHING_DONE, OPEN) === WAIVED_HOME);
// Without a waiver the corridor is unchanged: the W-9 sits behind the
// agreement, and the agreement behind the password.
check('the queue still holds for everybody else', gateFor('/welcome/w9', state({ profile: true })) === '/welcome/agreement');

console.log('\n- when a signed document settles -');
const SETTLED = { approved: true };
/*
 * Approving an account is a decision taken by reading two documents. If either
 * can be swapped out afterwards then what was approved and what is on file need
 * never be the same thing again, and there is nothing in the record to say so.
 */
check('the W-9 is fixed once the account is approved', isLocked('w9', ALL_DONE, SETTLED));
check('and the agreement with it', isLocked('agreement', ALL_DONE, SETTLED));
/*
 * A waiver settles a document by when it arrived, not by existing.
 *
 * Waiving the gate is a decision taken by reading what was on file, exactly
 * like approving, so what was on file is fixed by it. A document filed after
 * the waiver was not read by anybody before that decision, and a waived account
 * may now file one whenever it likes: locking it the instant it saved would
 * mean a mistyped name needed an admin, on a form nobody asked for.
 */
const WAIVED_AT = '2026-08-20T12:00:00.000Z';
const BEFORE = '2026-08-19T09:00:00.000Z';
const AFTER = '2026-08-21T09:00:00.000Z';
const SIGNED = state({ agreement: true, w9: true });
check(
  'a waiver settles what was already on file',
  isLocked('agreement', SIGNED, { bypassedAt: WAIVED_AT, signedAt: BEFORE }),
);
check(
  'but not one filed afterwards',
  !isLocked('agreement', SIGNED, { bypassedAt: WAIVED_AT, signedAt: AFTER }),
);
check(
  'so a waived account can correct what it just filed',
  !isLocked('w9', SIGNED, { bypassedAt: WAIVED_AT, signedAt: AFTER }),
);
// Signed in the same second the waiver was granted: on file when it was taken.
check(
  'the moment of the waiver counts as before it',
  isLocked('agreement', SIGNED, { bypassedAt: WAIVED_AT, signedAt: WAIVED_AT }),
);
/*
 * The two timestamps come from different places and one of them writes
 * "2026-08-20 12:00:00+00" where the other writes an ISO string. Compared as
 * strings those sort the wrong way round, which would unlock every document
 * signed on the day of its own waiver.
 */
check(
  'a Postgres timestamp and an ISO one compare by instant, not by spelling',
  isLocked('agreement', SIGNED, { bypassedAt: '2026-08-20 12:00:00+00', signedAt: BEFORE }),
);
check(
  'and the same pair the other way round',
  !isLocked('agreement', SIGNED, { bypassedAt: '2026-08-20 12:00:00+00', signedAt: AFTER }),
);
// The exact shape this database writes: a space, microseconds, and a bare
// two-digit offset. Not an ISO string, so not something to hand an engine and
// hope, since an unreadable date locks.
check(
  'microseconds and a bare offset are read too',
  isLocked('agreement', SIGNED, {
    bypassedAt: '2026-08-20 12:00:00.308994+00',
    signedAt: BEFORE,
  }),
);
check(
  'and do not lock a later filing by failing to parse',
  !isLocked('agreement', SIGNED, {
    bypassedAt: '2026-08-20 12:00:00.308994+00',
    signedAt: '2026-08-21 09:00:00.123456+00',
  }),
);
// A row read without its date beside it: assume it was there, which is the
// direction that protects the record rather than the convenience.
check(
  'an unknown signing date under a waiver stays locked',
  isLocked('agreement', SIGNED, { bypassedAt: WAIVED_AT, signedAt: null }),
);
check(
  'and so does an unreadable one',
  isLocked('agreement', SIGNED, { bypassedAt: WAIVED_AT, signedAt: 'whenever' }),
);
/*
 * Approval works the same way, and has to: every account waived here is also
 * approved, so a rule that only understood waivers would settle their first
 * filing on the spot anyway.
 */
check(
  'approval settles what was on file when it was given',
  isLocked('agreement', SIGNED, { approved: true, reviewedAt: WAIVED_AT, signedAt: BEFORE }),
);
check(
  'and not a document filed after it',
  !isLocked('agreement', SIGNED, { approved: true, reviewedAt: BEFORE, signedAt: AFTER }),
);
// Which is the case that matters in practice: an account approved long ago,
// waived, and now filing an agreement nobody asked it for.
check(
  'so a waived and approved account can correct its own filing',
  !isLocked('agreement', SIGNED, {
    approved: true,
    reviewedAt: BEFORE,
    bypassedAt: WAIVED_AT,
    signedAt: AFTER,
  }),
);
check(
  'while either decision alone is enough to settle an older one',
  isLocked('agreement', SIGNED, {
    approved: true,
    reviewedAt: AFTER,
    bypassedAt: BEFORE,
    signedAt: BEFORE,
  }),
);
// An older caller that says only "approved": treated as a decision with no
// date, which locks. The behaviour this had before the dates existed.
check(
  'approval with no date recorded still settles it',
  isLocked('agreement', SIGNED, { approved: true, signedAt: AFTER }),
);
// The normal flow, which is the whole reason approval cannot be dated-out of:
// sign first, approve second, and it can never be swapped afterwards.
check(
  'a document signed before its approval is fixed for good',
  isLocked('agreement', SIGNED, { approved: true, reviewedAt: AFTER, signedAt: BEFORE }),
);
// The other two are not documents and do change: people move house and banks
// close accounts.
check('their own details stay editable', !isLocked('profile', ALL_DONE, SETTLED));
check('and their bank details', !isLocked('bank', ALL_DONE, SETTLED));
// Nothing is locked before it exists, or the first submission would be refused.
check('a W-9 that was never filed is not locked', !isLocked('w9', state({ profile: true }), SETTLED));
check(
  'nor an unsigned agreement under a waiver',
  !isLocked('agreement', state({ profile: true }), { bypassedAt: WAIVED_AT, signedAt: null }),
);
// Which is what lets a waived account file one at all: the first save is not
// refused by a lock on a document that does not exist yet.
check(
  'nor an unfiled W-9',
  !isLocked('w9', state({ profile: true }), { bypassedAt: WAIVED_AT, signedAt: null }),
);
// Waiting, and turned down, are both states somebody can still act on.
check('a pending account can still re-sign', !isLocked('agreement', ALL_DONE));
check('and so can a declined one', !isLocked('w9', ALL_DONE, { approved: false }));

console.log(`\nonboarding: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
