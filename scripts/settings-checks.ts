// The two settings an admin owns, and the one promise that matters.
//
// The promise is that changing the commission percentage does not restate what
// has already been approved. That is the whole reason the share is a dated
// history rather than a number, and most of what is below is one way or another
// a test of it: an approval banked under the old rate has to keep answering the
// old rate, for ever, whatever anybody sets afterwards.
//
//   npx tsx scripts/settings-checks.ts
import {
  DEFAULT_SHARE,
  approvalsAffected,
  clearsFloor,
  currentShare,
  defaultSettings,
  floorFrom,
  formatShare,
  normaliseShares,
  orderShares,
  parseSettings,
  rateFromPercent,
  shareOn,
  shareProblems,
  type ShareRate,
  isCardKey,
  withCardStatus,
} from '../src/lib/settings';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra ? `:: ${extra}` : '');
  }
}

console.log('— before anybody sets anything —');
const fresh = defaultSettings();
check('the share is a half, as it always was', fresh.shares[0]!.rate === DEFAULT_SHARE);
check('and it applies from the beginning', fresh.shares[0]!.from === '');
check('there is exactly one rate', fresh.shares.length === 1);
check('and no floor on the rate card', fresh.cpaFloor === null);
check('an unset history still answers', shareOn('2026-08-27', []) === DEFAULT_SHARE);

console.log('\n— the rate in force on a day —');
/*
 * The history this whole feature exists for: half until the last day of
 * August, sixty percent from the first of September.
 */
const history: ShareRate[] = [
  { from: '', rate: 0.5 },
  { from: '2026-09-01', rate: 0.6 },
];
check('an approval before the change pays the old rate', shareOn('2026-08-31', history) === 0.5);
check('one long before it does too', shareOn('2024-01-15', history) === 0.5);
check('the first day of the new rate pays the new one', shareOn('2026-09-01', history) === 0.6);
check('and so does the day after', shareOn('2026-09-02', history) === 0.6);
check('and next year', shareOn('2027-06-01', history) === 0.6);
/*
 * A row whose approval date is missing falls to the opening rate, not the
 * newest one. An undated row is an old row that lost its date rather than one
 * approved this morning, and guessing the other way would quietly reprice it.
 */
check('a row with no date at all falls to the opening rate', shareOn('', history) === 0.5);
check('a timestamp is read as its day', shareOn('2026-09-01T18:30:00Z', history) === 0.6);

const three: ShareRate[] = [
  { from: '2027-01-01', rate: 0.7 },
  { from: '', rate: 0.5 },
  { from: '2026-09-01', rate: 0.6 },
];
check('three rates put themselves in order', orderShares(three).map((s) => s.rate).join() === '0.5,0.6,0.7');
check('and the middle one covers the middle', shareOn('2026-12-31', three) === 0.6);
check('the last one covers the end', shareOn('2027-01-01', three) === 0.7);
check('and the first still covers the start', shareOn('2020-01-01', three) === 0.5);
check('today is whatever today falls under', currentShare(three, '2026-09-15') === 0.6);

console.log('\n— a history that can be relied on —');
check('an opening rate is added when there is none', normaliseShares([{ from: '2026-09-01', rate: 0.6 }])[0]!.from === '');
check('and it is the default', normaliseShares([{ from: '2026-09-01', rate: 0.6 }])[0]!.rate === DEFAULT_SHARE);
check('so every old approval still has an answer', shareOn('2020-01-01', normaliseShares([{ from: '2026-09-01', rate: 0.6 }])) === DEFAULT_SHARE);
// Two entries starting the same day is what a double-submitted form makes.
const doubled = normaliseShares([
  { from: '', rate: 0.5 },
  { from: '2026-09-01', rate: 0.6 },
  { from: '2026-09-01', rate: 0.65 },
]);
check('two rates on one day collapse to one', doubled.filter((s) => s.from === '2026-09-01').length === 1);
check('and the later one wins', shareOn('2026-09-01', doubled) === 0.65);
check('a rate over 100% is dropped', normaliseShares([{ from: '', rate: 0.5 }, { from: '2026-09-01', rate: 4 }]).length === 1);
check('a negative one too', normaliseShares([{ from: '', rate: 0.5 }, { from: '2026-09-01', rate: -0.2 }]).length === 1);
check('and one that is not a number', normaliseShares([{ from: '', rate: 0.5 }, { from: '2026-09-01', rate: Number.NaN }]).length === 1);
/*
 * Zero is allowed. Somebody whose arrangement has ended is on nothing, and
 * refusing to record that only means it gets recorded as something else.
 */
check('nothing at all is a rate somebody can be on', shareOn('2026-09-01', normaliseShares([{ from: '2026-09-01', rate: 0 }])) === 0);
check('a nonsense start day becomes the opening rate', normaliseShares([{ from: 'soon', rate: 0.6 }]).some((s) => s.from === '' && s.rate === 0.6));

console.log('\n— percentages —');
check('sixty percent is six tenths', rateFromPercent(60) === 0.6);
check('and a half percent is a half percent', rateFromPercent(12.5) === 0.125);
check('nothing is nothing', rateFromPercent(0) === 0);
check('everything is everything', rateFromPercent(100) === 1);
check('more than everything is refused', rateFromPercent(101) === null);
check('so is less than nothing', rateFromPercent(-1) === null);
check('and so is a word', rateFromPercent(Number.NaN) === null);
check('a rate prints as a percentage', formatShare(0.6) === '60%');
check('a half prints as fifty', formatShare(0.5) === '50%');
check('and an awkward one keeps its point', formatShare(0.125) === '12.5%');
check('a percentage survives the round trip', formatShare(rateFromPercent(37.5)!) === '37.5%');

console.log('\n— the rate card floor —');
check('no floor lists everything', clearsFloor(50, null));
check('a card over the floor is listed', clearsFloor(720, 200));
check('a card exactly on it is listed', clearsFloor(200, 200));
check('a card under it is not', !clearsFloor(199.99, 200));
/*
 * A card with no rate does not clear a floor: the floor is there to keep the
 * card to what is worth quoting. It comes back the moment it is priced, and
 * this is the same rule the filter on the page already uses, so a floor of 200
 * and a filter of 200 cannot produce two different lists.
 */
check('a card with no rate at all does not clear it', !clearsFloor(null, 200));
check('but with no floor set it is listed like everything else', clearsFloor(null, null));
check('and a card at zero is not, which is the point of the floor', !clearsFloor(0, 200));

check('a typed floor reads as a number', floorFrom('200') === 200);
check('with a dollar sign and commas', floorFrom('$1,200.50') === 1200.5);
check('an empty box means no floor', floorFrom('') === null);
check('and so does nothing at all', floorFrom(null) === null && floorFrom(undefined) === null);
check('zero is no floor rather than a floor of zero', floorFrom('0') === null);
check('a word is no floor', floorFrom('lots') === null);
check('a number is taken as it is', floorFrom(200) === 200);

console.log('\n— reading what the store handed over —');
check('nothing at all comes back as the defaults', parseSettings(null).shares[0]!.rate === DEFAULT_SHARE);
check('so does a string', parseSettings('nope').cpaFloor === null);
check('so does an empty object', parseSettings({}).shares.length === 1);
const stored = parseSettings({
  shares: [{ from: '2026-09-01', rate: 0.6 }, { from: '', rate: 0.5 }],
  cpaFloor: 200,
  updatedAt: '2026-08-27T10:00:00.000Z',
  updatedBy: 'arthur',
});
check('a real blob comes back whole', stored.shares.length === 2 && stored.cpaFloor === 200);
check('in order', stored.shares[0]!.from === '' && stored.shares[1]!.from === '2026-09-01');
check('with who set it and when', stored.updatedBy === 'arthur' && stored.updatedAt.startsWith('2026-08-27'));
check('a blob with a broken rate still loads', parseSettings({ shares: [{ from: '', rate: 'half' }] }).shares[0]!.rate === DEFAULT_SHARE);
check('and one with a broken floor', parseSettings({ cpaFloor: 'two hundred' }).cpaFloor === null);

console.log('\n— inactive cards —');
check('nothing is inactive by default', defaultSettings().inactiveCards.length === 0);
check('saved marks are read back', parseSettings({ inactiveCards: ['Chase|Ink', 'Amex|Gold'] }).inactiveCards.join() === 'Chase|Ink,Amex|Gold');
check('junk in the list is dropped', parseSettings({ inactiveCards: ['Chase|Ink', 7, null, 'nobar', 'Chase|Ink'] }).inactiveCards.join() === 'Chase|Ink');
check('a list that is not a list is none', parseSettings({ inactiveCards: 'Chase|Ink' }).inactiveCards.length === 0);
check('marking a card inactive adds it', withCardStatus(['Amex|Gold'], 'Chase|Ink', true).join() === 'Amex|Gold,Chase|Ink');
check('marking it twice does not double it', withCardStatus(['Chase|Ink'], 'Chase|Ink', true).join() === 'Chase|Ink');
check('marking it active removes it', withCardStatus(['Amex|Gold', 'Chase|Ink'], 'Chase|Ink', false).join() === 'Amex|Gold');
check('marking an active card active changes nothing', withCardStatus(['Amex|Gold'], 'Chase|Ink', false).join() === 'Amex|Gold');
check('a card key needs a card', isCardKey('Chase|Ink') && isCardKey('|House card') && !isCardKey('Chase|') && !isCardKey('Chase') && !isCardKey(7));
check('an absurdly long key is refused', !isCardKey(`Chase|${'x'.repeat(400)}`));
check('a rate history is not lost by a round trip', JSON.stringify(parseSettings(JSON.parse(JSON.stringify(stored))).shares) === JSON.stringify(stored.shares));

console.log('\n— what the form refuses —');
check('a good change has nothing wrong with it', Object.keys(shareProblems({ percent: 60, from: '2026-09-01' }, history.slice(0, 1))).length === 0);
check('a percentage over a hundred is refused', 'percent' in shareProblems({ percent: 140, from: '2026-09-01' }, []));
check('a missing date is refused', 'from' in shareProblems({ percent: 60, from: '' }, []));
check('so is a half-typed one', 'from' in shareProblems({ percent: 60, from: '2026-09' }, []));
check('and a day that already has a rate', 'from' in shareProblems({ percent: 60, from: '2026-09-01' }, history));
check('zero percent is a real answer, not an error', Object.keys(shareProblems({ percent: 0, from: '2026-09-01' }, [])).length === 0);

console.log('\n— how much a change would restate —');
/*
 * The number the form shows before the button is pressed. Dating a rate from
 * tomorrow should touch nothing, and a mistyped year should be visible as the
 * two hundred approvals it would reprice rather than discovered afterwards.
 */
const days = [
  { day: '2026-08-20', count: 3 },
  { day: '2026-08-26', count: 5 },
  { day: '2026-09-02', count: 2 },
];
check('a rate starting tomorrow restates nothing', approvalsAffected(days, '2026-08-27').count === 2);
check('one starting today catches today', approvalsAffected(days, '2026-08-26').count === 7);
check('one starting last month catches the lot', approvalsAffected(days, '2026-08-01').count === 10);
check('a future date past everything catches none', approvalsAffected(days, '2027-01-01').count === 0);
check('and it names the first approval it would touch', approvalsAffected(days, '2026-08-01').earliest === '2026-08-20');
check('with nothing named when nothing is touched', approvalsAffected(days, '2027-01-01').earliest === '');
check('a row with no date is never counted', approvalsAffected([{ day: '', count: 9 }], '2020-01-01').count === 0);

console.log('\n— the promise, stated as one check —');
/*
 * Everything above in one line: an approval banked on 20 August under a half
 * share is still worth a half share after the rate is raised to sixty percent
 * from September, and after it is raised again to seventy in January.
 */
const banked = '2026-08-20';
let evolving: ShareRate[] = normaliseShares([{ from: '', rate: 0.5 }]);
const before = shareOn(banked, evolving);
evolving = normaliseShares([...evolving, { from: '2026-09-01', rate: 0.6 }]);
evolving = normaliseShares([...evolving, { from: '2027-01-01', rate: 0.7 }]);
check('an approval already banked is untouched by every later change', shareOn(banked, evolving) === before, `${before} became ${shareOn(banked, evolving)}`);
check('while a new one gets the rate in force', shareOn('2027-02-01', evolving) === 0.7);

console.log(`\nsettings: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
