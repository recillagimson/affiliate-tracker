/**
 * Approval texts: who is texted, what it says, and how GoHighLevel is asked to
 * send it. Nothing here reaches GHL or a phone: the transport runs against a
 * stubbed fetch.
 *
 *   npx tsx scripts/sms-checks.ts
 */
import { toE164 } from '../src/lib/phone';
import {
  approvalText,
  planTexts,
  plainText,
  SKIP_BAD_NUMBER,
  SKIP_INACTIVE,
  SKIP_NO_ACCOUNT,
  SKIP_NO_OPT_IN,
  SMS_CARD_CAP,
  type ApprovalText,
  type TextRecipient,
} from '../src/lib/sms-messages';
import { ghlConfigured, GHL_AFFILIATE_TAG, resolveContact, sendSms } from '../src/lib/ghl';
import { smsSummary, textApprovals } from '../src/lib/sms';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

console.log('— numbers —');
check('a US number as typed', toE164('(415) 555-0123'), '+14155550123');
check('with the 1 in front', toE164('1 415 555 0123'), '+14155550123');
check('already international', toE164('+1 585-648-5732'), '+15856485732');
check('a PH mobile as typed locally', toE164('0917 123 4567'), '+639171234567');
check('a PH mobile with 63 in front', toE164('63 917 123 4567'), '+639171234567');
check('a PH mobile written internationally', toE164('+63 917 123 4567'), '+639171234567');
check('ten digits that are not a US number are not guessed at', toE164('0123456789'), '');
check('too short', toE164('555-0123'), '');
check('nothing', toE164(''), '');

const gimson: TextRecipient = {
  userId: 'u1',
  usr: 'gimson',
  username: 'gimson',
  fullName: 'Gimson Recilla',
  email: 'gimson@example.com',
  mobile: '(415) 555-0123',
  active: true,
  smsOptIn: true,
  ghlContactId: '',
};
const ana: TextRecipient = {
  ...gimson,
  userId: 'u2',
  usr: 'ana',
  username: 'ana',
  fullName: 'Ana Cruz',
  mobile: '+1 212 555 0199',
};
const chase: ApprovalText = {
  usr: 'gimson',
  card: 'Chase Freedom Unlimited®',
  campaign: 'Best Cards',
  approvedOn: '2026-09-28',
};
const venture: ApprovalText = { ...chase, card: 'Capital One Venture' };
const URL = 'https://ledger.example.com/';

console.log('\n— the text —');
check(
  'one approval: the card and the day',
  approvalText(gimson, [chase], URL),
  'LEDGER: Hi Gimson, you have a new approval: Chase Freedom Unlimited(R) (28 Sept 2026).\n' +
    'View: https://ledger.example.com/\n' +
    'Reply STOP to opt out.',
);
check(
  'two approvals: one text, counted, cards named',
  approvalText(gimson, [chase, venture], URL),
  'LEDGER: Hi Gimson, you have 2 new approvals: Chase Freedom Unlimited(R), Capital One Venture.\n' +
    'View: https://ledger.example.com/\n' +
    'Reply STOP to opt out.',
);
check(
  'the same card twice is named once, with a count',
  approvalText(gimson, [chase, chase, venture], URL).split('\n')[0],
  'LEDGER: Hi Gimson, you have 3 new approvals: Chase Freedom Unlimited(R) (x2), Capital One Venture.',
);
const many = Array.from({ length: SMS_CARD_CAP + 2 }, (_, index) => ({ ...chase, card: `Card ${index + 1}` }));
check(
  'past the cap the rest are counted, not listed',
  approvalText(gimson, many, URL).split('\n')[0],
  'LEDGER: Hi Gimson, you have 5 new approvals: Card 1, Card 2, Card 3 + 2 more.',
);
check(
  'no card on record: the campaign stands in',
  approvalText(gimson, [{ ...chase, card: '' }], URL).split('\n')[0],
  'LEDGER: Hi Gimson, you have a new approval: Best Cards (28 Sept 2026).',
);
check(
  'no base URL: no View line, rather than a broken link',
  approvalText(gimson, [chase], ''),
  'LEDGER: Hi Gimson, you have a new approval: Chase Freedom Unlimited(R) (28 Sept 2026).\nReply STOP to opt out.',
);
check(
  'no name on the account: the username',
  approvalText({ ...gimson, fullName: '' }, [chase], '').startsWith('LEDGER: Hi gimson,'),
  true,
);
check('no money in it', /\$|payout|share|commission|%/i.test(approvalText(gimson, [chase, venture], URL)), false);
check(
  'plain SMS characters only, so it is not billed as Unicode',
  /[^\x20-\x7e\n]/.test(approvalText(gimson, [{ ...chase, card: 'Card™ – “Plus”' }], URL)),
  false,
);
check('the swaps', plainText('A® B™ ‘c’ “d” e–f…'), `A(R) B(TM) 'c' "d" e-f...`);

console.log('\n— who is texted —');
const everyone = new Map([
  ['gimson', gimson],
  ['ana', ana],
]);
const live = { dashboardUrl: URL, testNumber: '' };

const sync = planTexts(
  [chase, { ...chase, usr: 'ana' }, venture],
  everyone,
  live,
);
check('a sync with two of Gimson\'s and one of Ana\'s is two texts', sync.send.length, 2);
check('Gimson\'s is one text for both', sync.send[0]!.approvals, 2);
check('in the order they came', sync.send.map((text) => text.recipient.usr), ['gimson', 'ana']);
check('to the number on their account', sync.send.map((text) => text.to), ['+14155550123', '+12125550199']);
check('nobody skipped', sync.skipped, []);

check(
  'a key nobody holds is skipped and said',
  planTexts([{ ...chase, usr: 'nobody' }], everyone, live).skipped.map((row) => row.reason),
  [SKIP_NO_ACCOUNT],
);
check(
  'an approval with no key texts nobody',
  planTexts([{ ...chase, usr: '' }], everyone, live),
  { send: [], skipped: [] },
);
check(
  'a disabled account is not texted',
  planTexts([chase], new Map([['gimson', { ...gimson, active: false }]]), live).skipped[0]!.reason,
  SKIP_INACTIVE,
);
check(
  'no opt-in, no text',
  planTexts([chase], new Map([['gimson', { ...gimson, smsOptIn: false }]]), live).skipped[0]!.reason,
  SKIP_NO_OPT_IN,
);
check(
  'a number that cannot be read is not guessed at',
  planTexts([chase], new Map([['gimson', { ...gimson, mobile: '555-0123' }]]), live).skipped[0]!.reason,
  SKIP_BAD_NUMBER,
);

const test = planTexts(
  [chase, venture],
  new Map([['gimson', { ...gimson, smsOptIn: false, mobile: '' }]]),
  { dashboardUrl: URL, testNumber: '+15856485732' },
);
check('test mode: to the test number, whoever it was for', test.send.map((text) => text.to), ['+15856485732']);
check('still one text for both', test.send[0]!.approvals, 2);
check('marked with who it was for', test.send[0]!.message.startsWith('[TEST for Gimson Recilla] LEDGER: Hi Gimson'), true);
check('without needing their opt-in or their number', test.skipped, []);

async function transportChecks() {
  console.log('\n— GoHighLevel —');
  type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  function stub(reply: (call: Sent) => Response) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Sent = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      sent.push(call);
      return reply(call);
    }) as typeof fetch;
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  process.env.GHL_PRIVATE_TOKEN = '';
  process.env.GHL_LOCATION_ID = '';
  check('no token means off', ghlConfigured(), false);
  stub(() => json({}));
  check('and an approval texts nobody', await textApprovals([chase]), {
    enabled: false,
    sent: 0,
    skipped: [],
    failed: [],
    test: false,
  });
  check('not even a request', sent.length, 0);
  check('and says nothing on screen', smsSummary(await textApprovals([chase])), '');

  process.env.GHL_PRIVATE_TOKEN = 'pit-test';
  process.env.GHL_LOCATION_ID = 'loc123';
  check('a token and a location switch it on', ghlConfigured(), true);

  sent.length = 0;
  stub((call) =>
    call.url.includes('/search/duplicate')
      ? json({ contact: { id: 'c-existing', firstName: 'Gimson', lastName: 'Recilla' } })
      : json({ tags: [GHL_AFFILIATE_TAG] }, 201),
  );
  const existing = await resolveContact({ fullName: 'Gimson Recilla', email: '', phone: '+14155550123' });
  check('an existing contact is found by the number', existing, { id: 'c-existing', name: 'Gimson Recilla', created: false });
  check(
    'looked up in this location, by the number',
    sent[0]!.url,
    'https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=loc123&number=%2B14155550123',
  );
  check('with the token', sent[0]!.headers.authorization, 'Bearer pit-test');
  check('on the contacts API version', sent[0]!.headers.version, '2021-07-28');
  check('then tagged, and nothing else about it changed', [sent[1]!.url.endsWith('/contacts/c-existing/tags'), sent[1]!.body], [true, { tags: [GHL_AFFILIATE_TAG] }]);
  check('two calls, no create', sent.length, 2);

  sent.length = 0;
  stub((call) =>
    call.url.includes('/search/duplicate') ? json({ contact: null }) : json({ contact: { id: 'c-new' } }, 201),
  );
  const created = await resolveContact({ fullName: 'Ana Maria Cruz', email: 'ana@example.com', phone: '+12125550199' });
  check('no contact: one is made', created.id, 'c-new');
  check('named, tagged, in this location', sent[1]!.body, {
    locationId: 'loc123',
    firstName: 'Ana',
    lastName: 'Maria Cruz',
    email: 'ana@example.com',
    phone: '+12125550199',
    tags: [GHL_AFFILIATE_TAG],
    source: 'Ledger',
  });

  sent.length = 0;
  stub((call) =>
    call.url.includes('/search/duplicate')
      ? json({ contact: null })
      : json({ message: 'This location does not allow duplicated contacts.', meta: { contactId: 'c-dup' } }, 400),
  );
  check(
    'a create refused as a duplicate uses the contact GHL points at',
    (await resolveContact({ fullName: 'Ana', email: 'ana@example.com', phone: '+12125550199' })).id,
    'c-dup',
  );

  sent.length = 0;
  stub(() => json({ conversationId: 'conv1', messageId: 'm1', status: 'pending' }));
  check('a text comes back with its message id', await sendSms('c-new', 'hello'), 'm1');
  check('sent as an SMS to the contact', sent[0]!.body, { type: 'SMS', contactId: 'c-new', message: 'hello' });
  check('on the conversations API version', sent[0]!.headers.version, '2021-04-15');

  stub(() => json({ message: ['Contact is in DND for SMS'] }, 400));
  let refused = '';
  try {
    await sendSms('c-new', 'hello');
  } catch (error) {
    refused = error instanceof Error ? error.message : '';
  }
  check('a refusal says what GHL said', refused, 'GoHighLevel refused the request (HTTP 400: Contact is in DND for SMS).');

  globalThis.fetch = realFetch;
}

transportChecks().then(() => {
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
});
