/**
 * Approving a lead by hand: the rate card the card is picked from, what the
 * approval's notes say, what the affiliate is shown they earn, and what the
 * report sync does when it later finds the same approval in QMP.
 *
 *   npx tsx scripts/manual-approval-checks.ts
 */
import {
  affiliateCut,
  amountFor,
  manualApprovalNotes,
  manualSwapNote,
  preselectChoice,
  rateChoices,
} from '../src/lib/manual-approval';
import {
  approvedCards,
  approvedLeadIds,
  cardFromNotes,
  isManualApproval,
  leadRefIn,
  planManualSwaps,
  planSync,
  visibleNotes,
  type PlannedConversion,
} from '../src/lib/qmp-sync';
import type { AffiliateLink, Conversion, CpaRate } from '../src/lib/types';
import { manualApprovalSchema } from '../src/lib/validate';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

function rate(issuer: string, card: string, tier: string, current: number | null): CpaRate {
  return { placement: 'P', issuer, card, tier, current, previous: null, change: null, changedOn: '' };
}

console.log('— the cards an approval can be for —');
const rows: CpaRate[] = [
  rate('AmEx Business', 'Business Gold', '', 540),
  rate('AmEx Consumer', 'Gold Card', 'Tier 1', 420),
  rate('AmEx Consumer', 'Gold Card', 'Tier 2', 540),
  rate('AmEx Consumer', 'Gold Card', 'Tier 3', 660),
  rate('Chase', 'Sapphire Preferred', '', 270),
  rate('Chase', 'Retired Card', '', null),
  rate('Chase', 'Paused Card', '', 0),
];
const choices = rateChoices(rows);
check(
  'one choice per card, in rate-card order',
  choices.map((c) => c.card),
  ['Business Gold', 'Gold Card', 'Sapphire Preferred', 'Paused Card'],
);
check(
  'a tiered card carries each tier and what it pays',
  choices[1]!.tiers,
  [
    { tier: 'Tier 1', amount: 420 },
    { tier: 'Tier 2', amount: 540 },
    { tier: 'Tier 3', amount: 660 },
  ],
);
check('a one-rate card carries one untiered rate', choices[0]!.tiers, [{ tier: '', amount: 540 }]);
check('each choice keeps its issuer, for grouping', choices.map((c) => c.issuer), [
  'AmEx Business',
  'AmEx Consumer',
  'Chase',
  'Chase',
]);
check('no rate card is no choices', rateChoices([]), []);

console.log('\n— the amount a choice fills in —');
check('a one-rate card fills in its rate', amountFor(choices[0], ''), 540);
check('a tiered card fills in the tier picked', amountFor(choices[1], 'Tier 2'), 540);
check('a tiered card with no tier picked fills in nothing', amountFor(choices[1], ''), null);
check('a tier the card does not have fills in nothing', amountFor(choices[1], 'Tier 9'), null);
check('no card picked fills in nothing', amountFor(undefined, ''), null);
check('a card switched off at $0 fills in 0, not nothing', amountFor(choices[3], ''), 0);

console.log('\n— the card the form starts on —');
check('the card the sync recorded, as QMP spells it', preselectChoice('Sapphire Preferred', choices), 2);
check('matched whatever the case and spacing', preselectChoice('  gold CARD ', choices), 1);
check('the first of several recorded cards that is on the rate card', preselectChoice('Unknown Card, Gold Card', choices), 1);
check('nothing recorded starts on nothing', preselectChoice('', choices), -1);
check('a card not on the rate card starts on nothing', preselectChoice('Discover It', choices), -1);

console.log('\n— what the affiliate is shown they earn —');
const shares = [
  { from: '', rate: 0.5 },
  { from: '2026-09-01', rate: 0.6 },
];
check('their share at the rate in force on the approval day', affiliateCut(270, '2026-09-22', shares), 162);
check('an earlier day answers the earlier rate', affiliateCut(270, '2026-08-15', shares), 135);
check('rounded to the cent', affiliateCut(99.99, '2026-08-15', shares), 50);

console.log('\n— the notes a manual approval carries —');
const notes = manualApprovalNotes('Gold Card', 'abc123def456', 'k3m9x2q7hz04');
check('card, marker, lead tag', notes, 'Gold Card · manual:k3m9x2q7hz04 · lead:abc123def456');
check('it reads as manual', isManualApproval(notes), true);
check('a synced approval does not', isManualApproval('Gold Card · qmp:07jt4uv#1/1 · lead:abc123def456'), false);
check('a note typed by hand does not', isManualApproval('manually checked'), false);
check('it names its lead', leadRefIn(notes), 'abc123def456');
check('the card reads back off it', cardFromNotes(notes), 'Gold Card');
check('and the lead reads approved with that card', [
  [...approvedLeadIds([{ notes }])],
  approvedCards([{ notes }]).get('abc123def456'),
], [['abc123def456'], ['Gold Card']]);
check('the marker and tag are hidden on screen', visibleNotes(notes), 'Gold Card');

console.log('\n— what may be sent to approve a lead —');
check(
  'card, amount and day',
  manualApprovalSchema.safeParse({ card: ' Gold Card ', amount: '540', approvedOn: '2026-09-22' }).data,
  { card: 'Gold Card', amount: 540, approvedOn: '2026-09-22' },
);
check('no card is refused', manualApprovalSchema.safeParse({ card: '  ', amount: 1, approvedOn: '2026-09-22' }).success, false);
check('a negative amount is refused', manualApprovalSchema.safeParse({ card: 'X', amount: -5, approvedOn: '2026-09-22' }).success, false);
check('a day that does not exist is refused', manualApprovalSchema.safeParse({ card: 'X', amount: 5, approvedOn: '2026-02-31' }).success, false);
check(
  'a card carrying a machine tag is refused, so it cannot pass as synced',
  manualApprovalSchema.safeParse({ card: 'X · qmp:abc1234#1/1', amount: 5, approvedOn: '2026-09-22' }).success,
  false,
);

console.log('\n— the sync meeting a manual approval —');
const LEAD = 'abc123def456';
const OTHER = 'zzz999yyy888';
function manual(id: string, card: string, lead: string, amount = 540): Conversion {
  return {
    id,
    createdAt: '2026-09-20T00:00:00Z',
    approvedOn: '2026-09-20',
    slug: 'cash-back',
    usr: 'arthur',
    amount,
    notes: manualApprovalNotes(card, lead, `m${id.padStart(11, '0')}`),
  };
}
function planned(marker: string, card: string, leadRef: string): PlannedConversion {
  return {
    slug: 'cash-back',
    usr: 'arthur',
    approvedOn: '2026-09-21',
    amount: 660,
    notes: `${card} · ${marker} · lead:${leadRef}`,
    marker,
    card,
    trackingKey: 'arthur',
    leadRef,
  };
}

let swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'Gold Card', LEAD)],
  existing: [manual('1', 'Gold Card', LEAD)],
  committed: new Set(),
});
check('QMP replaces the manual approval for the same lead', swaps, {
  replace: [{ marker: 'qmp:aaaaaaa#1/1', manualId: '1' }],
  kept: [],
});

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'Gold Card', LEAD)],
  existing: [manual('1', 'Gold Card', LEAD)],
  committed: new Set(['1']),
});
check('one already on a payout request is kept, and QMP is skipped', swaps, {
  replace: [],
  kept: [{ marker: 'qmp:aaaaaaa#1/1', manualId: '1' }],
});

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'gold card ', LEAD)],
  existing: [manual('1', 'Sapphire Preferred', LEAD), manual('2', 'Gold Card', LEAD)],
  committed: new Set(),
});
check('the same card is preferred, however QMP spaces or cases it', swaps.replace, [
  { marker: 'qmp:aaaaaaa#1/1', manualId: '2' },
]);

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'Platinum', LEAD)],
  existing: [manual('1', 'Gold Card', LEAD)],
  committed: new Set(),
});
check('with no same card, the lead’s manual approval is still replaced', swaps.replace, [
  { marker: 'qmp:aaaaaaa#1/1', manualId: '1' },
]);

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/2', 'Gold Card', LEAD), planned('qmp:aaaaaaa#2/2', 'Gold Card', LEAD)],
  existing: [manual('1', 'Gold Card', LEAD)],
  committed: new Set(),
});
check('one manual approval is replaced once, not by every QMP row', swaps, {
  replace: [{ marker: 'qmp:aaaaaaa#1/2', manualId: '1' }],
  kept: [],
});

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'Gold Card', OTHER), planned('qmp:bbbbbbb#1/1', 'Gold Card', '')],
  existing: [manual('1', 'Gold Card', LEAD)],
  committed: new Set(),
});
check('another lead, or no lead, touches nothing', swaps, { replace: [], kept: [] });

swaps = planManualSwaps({
  create: [planned('qmp:aaaaaaa#1/1', 'Gold Card', LEAD)],
  existing: [
    { ...manual('1', 'Gold Card', LEAD), notes: `Gold Card · qmp:ccccccc#1/1 · lead:${LEAD}` },
    { ...manual('2', 'Gold Card', LEAD), notes: `typed by hand · lead:${LEAD}` },
  ],
  committed: new Set(),
});
check('only approvals recorded with Approve are replaced', swaps, { replace: [], kept: [] });

// The sync never treats a manual approval as one it imported: a manual
// approval with no QMP row behind it yet must not stop the row being planned.
const links: AffiliateLink[] = [
  {
    id: 'l1',
    createdAt: '',
    slug: 'cash-back',
    usr: 'arthur',
    assignee: 'Arthur',
    assigneeEmail: '',
    campaign: '',
    destination: '',
    headline: '',
    subheadline: '',
    ctaLabel: '',
    requirePhone: false,
    passUsrParam: '',
    active: true,
    notes: '',
  },
];
const plan = planSync({
  rows: [{ Date: '2026-09-21', 'Card Name': 'Gold Card', Var2: 'arthur', Var3: LEAD, Approvals: 1, 'Total Earnings': 660 }],
  reportKey: 'r',
  links,
  existing: [manual('1', 'Gold Card', LEAD)],
});
check('the QMP row is still planned beside a manual approval', [plan.create.length, plan.skipped], [1, 0]);

console.log('\n— what the sync screen says about them —');
check('nothing to say when no manual approval is met', manualSwapNote({ manualToReplace: 0, manualKept: 0 }, false), '');
check(
  'a plan names what it will replace',
  manualSwapNote({ manualToReplace: 2, manualKept: 0 }, false),
  "2 approvals recorded by hand will be replaced by QMP's, at what QMP paid.",
);
check(
  'and what it will leave, and why',
  manualSwapNote({ manualToReplace: 1, manualKept: 1 }, false),
  "1 approval recorded by hand will be replaced by QMP's, at what QMP paid. 1 is on a payout request, so it stays and QMP's is not written.",
);
check(
  'a run that applied says what it did',
  manualSwapNote({ manualToReplace: 1, manualKept: 0, replaced: 1 }, true),
  "1 approval recorded by hand was replaced by QMP's, at what QMP paid.",
);
check(
  'kept alone reads on its own',
  manualSwapNote({ manualToReplace: 0, manualKept: 2 }, false),
  "2 QMP approvals match approvals recorded by hand that are on a payout request, so those stay and QMP's are not written.",
);

console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
