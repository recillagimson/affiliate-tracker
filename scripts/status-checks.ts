/**
 * Everything about the Status and Card columns that can be checked without a
 * Google account: the header-row migration decision, the A1 target of a
 * status write, how a hand-typed cell is read back, and the rules a lead moves
 * between its three states by.
 *
 *   npx tsx scripts/status-checks.ts
 */
import { buildStats } from '../src/lib/analytics';
import { SHEET_HEADERS } from '../src/lib/config';
import {
  planHeaderRow,
  planSubmissionWrite,
  submissionFromRow,
  submissionToRow,
} from '../src/lib/store/sheets';
import {
  LEAD_STATUSES,
  displayStatus,
  nextManualStatus,
  normalizeLeadStatus,
  statusLabel,
  statusRank,
} from '../src/lib/status';
import type { Submission } from '../src/lib/types';
import { submissionPatchSchema } from '../src/lib/validate';

const SUB = SHEET_HEADERS.submissions;
/** The 13-column header every sheet written before the Status column has. */
const LEGACY = SUB.slice(0, SUB.indexOf('status'));
/** The 14-column header of a sheet that has Status but was written before Card. */
const BEFORE_CARD = SUB.slice(0, SUB.indexOf('card'));

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

console.log('— header migration —');
check('the legacy header is the 13 columns before status', LEGACY.length, 13);
check(
  'the pre-card header is 14 columns, ending at status',
  [BEFORE_CARD.length, BEFORE_CARD[BEFORE_CARD.length - 1]],
  [14, 'status'],
);
check('blank tab is stamped', planHeaderRow([], SUB).action, 'write');
check(
  'a 13-column sheet with neither status nor card gains both',
  planHeaderRow([...LEGACY], SUB).action,
  'write',
);
check(
  'a 14-column sheet with status but no card gains card',
  planHeaderRow([...BEFORE_CARD], SUB).action,
  'write',
);
check('already migrated: nothing to do', planHeaderRow([...SUB], SUB).action, 'ok');
check(
  'header typed by hand as "Created At" still matches',
  planHeaderRow(['id', 'Created At', ...SUB.slice(2)], SUB).action,
  'ok',
);
check(
  'user column sitting in our status slot is refused, not overwritten',
  planHeaderRow([...LEGACY, 'my notes'], SUB),
  { action: 'conflict', index: 13, found: 'my notes' },
);
/*
 * The sheet somebody kept their own column in, just right of Status, is
 * standing where Card now goes. Stamping the header would retitle their column
 * and every later sync would write card names over whatever they keep there,
 * so it is refused exactly like the status slot above.
 */
check(
  'user column sitting in our card slot is refused, not overwritten',
  planHeaderRow([...BEFORE_CARD, 'my notes'], SUB),
  { action: 'conflict', index: 14, found: 'my notes' },
);
check(
  'an inserted column (everything shifted) is refused',
  planHeaderRow(['id', 'owner', 'created_at', ...LEGACY.slice(2)], SUB),
  { action: 'conflict', index: 1, found: 'owner' },
);
check(
  'extra user columns to the RIGHT of ours are fine',
  planHeaderRow([...SUB, 'my notes', 'called?'], SUB).action,
  'ok',
);
check(
  'a legacy sheet with extra columns to the right still migrates',
  planHeaderRow([...LEGACY], SUB).action,
  'write',
);

console.log('\n— where a status write lands —');
function columnLetter(index: number): string {
  let out = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
check('status writes to column N', columnLetter(SUB.indexOf('status') + 1), 'N');
check('card writes to column O', columnLetter(SUB.indexOf('card') + 1), 'O');
check('card is the last column', SUB[SUB.length - 1], 'card');
// The sync writes the two together as one range, which is only the two cells
// it means to write while nothing sits between them.
check(
  'card sits right after status, so the pair is one range',
  SUB.indexOf('card') - SUB.indexOf('status'),
  1,
);
check(
  'a status change writes one cell only, not the row',
  planSubmissionWrite(
    7,
    { status: 'registered', card: 'Chase Sapphire Preferred' },
    { status: 'registered' },
  ),
  { range: 'Submissions!N7:N7', values: [['registered']] },
);
check(
  'a change that carries the card writes status and card together',
  planSubmissionWrite(
    7,
    { status: 'applied', card: 'Chase Sapphire Preferred' },
    { status: 'applied', card: 'Chase Sapphire Preferred' },
  ),
  { range: 'Submissions!N7:O7', values: [['applied', 'Chase Sapphire Preferred']] },
);
check(
  'a card-only change still writes the pair, with the status as it stands',
  planSubmissionWrite(
    7,
    { status: 'registered', card: 'Chase Freedom' },
    { card: 'Chase Freedom' },
  ),
  { range: 'Submissions!N7:O7', values: [['registered', 'Chase Freedom']] },
);

console.log('\n— the card on a sheet row —');
const lead: Submission = {
  id: 'rc7czk6xa61y',
  createdAt: '2026-09-01T00:00:00.000Z',
  slug: 'best-cards',
  usr: 'mark',
  assignee: 'Mark',
  campaign: 'Best Cards',
  fullName: 'Priya Nair',
  email: 'priya@example.test',
  phone: '',
  destination: 'https://example.test/?var3=rc7czk6xa61y',
  referrer: '',
  userAgent: '',
  ip: '',
  status: 'applied',
  card: 'Chase Sapphire Preferred',
};
const cells = submissionToRow(lead);
check('a row is exactly as wide as the header', cells.length, SUB.length);
check('the status lands under its heading', cells[SUB.indexOf('status')], 'applied');
check('the card lands under its heading', cells[SUB.indexOf('card')], 'Chase Sapphire Preferred');
check('and the row reads back as it was written', submissionFromRow(cells), lead);
check(
  'a card typed with stray spaces reads without them',
  submissionFromRow([...cells.slice(0, -1), '  Chase Sapphire Preferred ']).card,
  'Chase Sapphire Preferred',
);
check(
  'a row logged before the card column reads as no card',
  submissionFromRow(cells.slice(0, SUB.indexOf('card'))).card,
  '',
);
const older = submissionFromRow(cells.slice(0, SUB.indexOf('status')));
check(
  'a row logged before either column reads as pending with no card',
  [older.status, older.card],
  ['pending', ''],
);

console.log('\n— reading a cell somebody typed —');
for (const [input, want] of [
  ['', 'pending'],
  [undefined, 'pending'],
  ['pending', 'pending'],
  ['registered', 'registered'],
  ['Registered', 'registered'],
  ['  REGISTERED  ', 'registered'],
  // The word on screen. Somebody typing what they read has to land in the same
  // place as somebody typing what they have always typed.
  ['approved', 'registered'],
  ['Approved', 'registered'],
  ['APPROVED', 'registered'],
  ['not approved', 'pending'],
  ['pending approval', 'pending'],
  ['yes', 'registered'],
  ['Done', 'registered'],
  ['✓', 'registered'],
  ['registration pending', 'pending'],
  ['not registered', 'pending'],
  // In between: the merchant has the application and has not approved it.
  ['applied', 'applied'],
  ['Applied', 'applied'],
  ['  APPLIED  ', 'applied'],
  ['application', 'applied'],
  ['Application submitted', 'applied'],
  ['aplicado', 'applied'],
  ['aplicada', 'applied'],
  ['solicitud', 'applied'],
  // Whole words only, or the one that says the opposite reads as applied.
  ['not applied', 'pending'],
  ['never applied', 'pending'],
  ['no', 'pending'],
  ['maybe next week', 'pending'],
  [42, 'pending'],
] as const) {
  check(`"${String(input)}" reads as ${want}`, normalizeLeadStatus(input), want);
}
// What the app itself writes must survive being read back, or a sync would
// mark a lead applied and the next page load would show it pending.
for (const status of LEAD_STATUSES) {
  check(`the stored word "${status}" reads back as itself`, normalizeLeadStatus(status), status);
}

console.log('\n— what it is called on screen —');
// The stored word and the shown word part company here and nowhere else, which
// is what lets the caption change without the database or the sheet changing.
check('the three statuses, in funnel order', LEAD_STATUSES, ['pending', 'applied', 'registered']);
check('registered reads as Approved', statusLabel('registered'), 'Approved');
check('applied reads as Applied', statusLabel('applied'), 'Applied');
check('pending reads as Pending', statusLabel('pending'), 'Pending');

console.log('\n— an approval outranks the stored status —');
/*
 * The rule the leads list and the approvals list share. A lead sitting at
 * pending under an approval is not a decision anybody made, so the approval
 * wins; without an approval the stored status is left exactly as it is.
 */
check('an approval lifts a pending lead', displayStatus('pending', true), 'registered');
check('an approval lifts an applied lead', displayStatus('applied', true), 'registered');
check('an approval leaves an approved lead alone', displayStatus('registered', true), 'registered');
check('no approval keeps pending pending', displayStatus('pending', false), 'pending');
check('no approval keeps an applied lead applied', displayStatus('applied', false), 'applied');
check(
  'no approval keeps a hand-marked lead approved',
  displayStatus('registered', false),
  'registered',
);

console.log('\n— a lead only moves forward on its own —');
check('pending is behind applied', statusRank('pending') < statusRank('applied'), true);
check('applied is behind approved', statusRank('applied') < statusRank('registered'), true);
check('the ranks follow the funnel', LEAD_STATUSES.map(statusRank), [0, 1, 2]);

console.log('\n— where the admin toggle takes a lead —');
/*
 * The toggle no longer marks a lead approved. An approval is money, and money
 * is recorded with Approve, which asks which card and what it paid. The pill
 * moves a lead between the two states that cost nothing.
 */
check(
  'a pending lead is marked applied',
  nextManualStatus({ status: 'pending', card: '' }),
  'applied',
);
check(
  'an applied lead with no card goes back to pending',
  nextManualStatus({ status: 'applied', card: '' }),
  'pending',
);
check(
  'an applied lead with a card on record has nowhere to go',
  nextManualStatus({ status: 'applied', card: 'Chase Sapphire Preferred' }),
  null,
);
/*
 * A lead marked approved by hand before Approve existed, with no approval
 * behind it, can still be taken back. It returns to where the evidence leaves
 * it: applied when a card is on record, pending when nothing is.
 */
check(
  'un-approving a lead with a card on record leaves it applied',
  nextManualStatus({ status: 'registered', card: 'Chase Sapphire Preferred' }),
  'applied',
);
check(
  'un-approving a lead with no card sends it back to pending',
  nextManualStatus({ status: 'registered', card: '' }),
  'pending',
);
check(
  'a card of nothing but spaces is no card',
  nextManualStatus({ status: 'registered', card: '   ' }),
  'pending',
);

console.log('\n— what the admin may send —');
check(
  'applied is a status the toggle may send',
  submissionPatchSchema.safeParse({ status: 'applied' }).success,
  true,
);
check(
  'approved is not something the toggle may send: that takes an approval',
  submissionPatchSchema.safeParse({ status: 'registered' }).success,
  false,
);
check(
  'the on-screen word is not a stored status, so it is refused',
  submissionPatchSchema.safeParse({ status: 'approved' }).success,
  false,
);
// The card is the merchant's record of what was applied for. It arrives from
// the report sync, and a hand-typed one would be a second version of it.
check(
  'a card sent by hand is dropped, not saved',
  submissionPatchSchema.parse({ status: 'applied', card: 'Anything' }),
  { status: 'applied' },
);

console.log('\n— counting leads by status —');
/*
 * Applied is a count of its own, not a kind of pending. Folded into pending it
 * would make the working list look longer than it is, by exactly the leads the
 * merchant has already heard from.
 */
const counted = buildStats(
  [],
  [
    { ...lead, id: 'p1', status: 'pending', card: '' },
    { ...lead, id: 'a1', status: 'applied' },
    { ...lead, id: 'a2', status: 'applied' },
    { ...lead, id: 'r1', status: 'registered' },
  ],
  [],
);
check(
  'each lead is counted under its own status',
  [counted.pending, counted.applied, counted.registered],
  [1, 2, 1],
);
check(
  'and the three add up to every lead',
  counted.pending + counted.applied + counted.registered,
  counted.totalSubmissions,
);
check('the approval rate still counts approved leads only', counted.registrationRate, 0.25);

console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
