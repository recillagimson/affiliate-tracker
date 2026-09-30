// The agreement text, and the archive of what it used to say.
//
// This file exists because of one property of the design: a signed row records
// which version somebody agreed to and nothing else, and the text is read out
// of lib/agreement every time a copy is drawn. That is the right trade (there
// is no blob store to keep in step with a correction) but it has a sharp edge:
// revise a sentence without archiving the old one and every agreement already
// signed silently re-renders under the new wording, over a real signature.
//
// So the checks here are less about formatting than about that. What the
// current version says, what each superseded version said, that the two differ
// only where the archive says they differ, and that every entry in the archive
// still points at a paragraph that exists.
//
//   npx tsx scripts/agreement-checks.ts
import {
  AGREEMENT_VERSION,
  PAYMENT_DAYS,
  allParagraphs,
  CLAUSES,
  clausesFor,
  clauseText,
  SUMMARY,
  summaryFor,
  SUPERSEDED,
  wordingKnown,
} from '../src/lib/agreement';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra ? `:: ${extra}` : '');
  }
}

const OLD = '2026-08';
/** Net 45, from 27 August until 1 October 2026. */
const NET45 = '2026-08-27';
const payment = (version: string) =>
  summaryFor(version).find((row) => row.term === 'Payment Terms')?.details ?? '';
const clause4 = (version: string) =>
  clausesFor(version).find((clause) => clause.n === 4)?.paras[1] ?? '';

console.log('— what the agreement says now —');
check('payment is Net 15', payment(AGREEMENT_VERSION).startsWith('Net 15'), payment(AGREEMENT_VERSION).slice(0, 40));
check('and it is 15 calendar days', payment(AGREEMENT_VERSION).includes('15 calendar days'));
check('section 4 says the same', clause4(AGREEMENT_VERSION).includes('net fifteen (15) days'), clause4(AGREEMENT_VERSION).slice(0, 60));
check('and names the term the same way', clause4(AGREEMENT_VERSION).includes('"Net 15"'));
check('and gives the same number of days', clause4(AGREEMENT_VERSION).includes('fifteen (15) calendar days'));
/*
 * The payment term is written here in words and counted in days by the payout
 * schedule, which reads PAYMENT_DAYS. If the two ever disagree, somebody is
 * paid on a date their own contract does not describe, so the number is read
 * back out of the clause that promises it.
 */
check('the schedule counts the days this clause promises', clause4(AGREEMENT_VERSION).includes(`(${PAYMENT_DAYS}) calendar days`));
check('and the summary names the same term', SUMMARY.find((row) => row.term === 'Payment Terms')!.details.startsWith(`Net ${PAYMENT_DAYS}`));
check('which is 15', PAYMENT_DAYS === 15);
/*
 * The half-update this is really guarding: a summary table that says one thing
 * and the clause underneath it that says another. Both are in the same
 * document and a reader will take whichever they read first.
 */
check(
  'the summary and the clause cannot disagree about the term',
  payment(AGREEMENT_VERSION).includes('15') && clause4(AGREEMENT_VERSION).includes('(15)') && !clause4(AGREEMENT_VERSION).includes('(45)') && !clause4(AGREEMENT_VERSION).includes('(30)'),
);
check('nothing in force still says Net 30', !JSON.stringify([SUMMARY, CLAUSES]).includes('Net 30'));
check('nor Net 45', !JSON.stringify([SUMMARY, CLAUSES]).includes('Net 45') && !JSON.stringify([SUMMARY, CLAUSES]).includes('forty-five'));

console.log('\n— and what it used to say —');
/*
 * Not "the version changed", which the compiler can see is true from two
 * literals and refuses to compile. The invariant worth holding is that the
 * wording in force is never itself in the archive, and sorts after everything
 * that is: these keys are compared as text wherever they are read back.
 */
check(
  'the version in force is not one of the superseded ones',
  !SUPERSEDED.some((revision) => revision.version === AGREEMENT_VERSION),
  AGREEMENT_VERSION,
);
check(
  'and sorts after all of them',
  SUPERSEDED.every((revision) => revision.version < AGREEMENT_VERSION),
  SUPERSEDED.map((revision) => revision.version).join(),
);
check('the wording in force is known to be on file', wordingKnown(AGREEMENT_VERSION));
check('so is the version four people signed under', wordingKnown(OLD));
check('a version this file has never heard of is not', !wordingKnown('2099-01'));
check('and neither is no version at all', !wordingKnown(''));

check('the old summary still says Net 30', payment(OLD).startsWith('Net 30'), payment(OLD).slice(0, 40));
check('and its 30 calendar days', payment(OLD).includes('30 calendar days'));
check('the old section 4 says net thirty', clause4(OLD).includes('net thirty (30) days'), clause4(OLD).slice(0, 60));
check('with none of the later wording in it', !clause4(OLD).includes('forty-five') && !clause4(OLD).includes('fifteen'));

check('the Net 45 version is on file too', wordingKnown(NET45));
check('its summary still says Net 45', payment(NET45).startsWith('Net 45'), payment(NET45).slice(0, 40));
check('and its 45 calendar days', payment(NET45).includes('45 calendar days'));
check('its section 4 says net forty-five', clause4(NET45).includes('net forty-five (45) days'), clause4(NET45).slice(0, 60));
check('with none of the new wording in it', !clause4(NET45).includes('fifteen') && !payment(NET45).includes('Net 15'));
check('and every other paragraph is today\u2019s', clausesFor(NET45).every((clause) => clause.paras.every((para, at) => (clause.n === 4 && at === 1) || para === CLAUSES.find((c) => c.n === clause.n)!.paras[at])));

/*
 * The strong one. Everything except the two archived paragraphs has to come
 * back identical, or "only the paragraphs that changed are kept" is not true
 * and the archive is quietly rewriting more than it claims.
 */
const differing: string[] = [];
for (const clause of clausesFor(AGREEMENT_VERSION)) {
  const before = clausesFor(OLD).find((entry) => entry.n === clause.n)!;
  clause.paras.forEach((para, at) => {
    if (before.paras[at] !== para) differing.push(`${clause.n}.${at}`);
  });
}
check('exactly one clause paragraph differs between the two', differing.join() === '4.1', differing.join() || 'none');
const summaryDiffers = SUMMARY.filter((row) => payment(OLD) !== row.details && row.term === 'Payment Terms');
check('and exactly one summary row', summaryDiffers.length === 1);
check(
  'every other summary row is untouched',
  summaryFor(OLD)
    .filter((row) => row.term !== 'Payment Terms')
    .every((row) => SUMMARY.find((now) => now.term === row.term)?.details === row.details),
);
check('the clause titles and numbering are the same in both', clausesFor(OLD).map((c) => `${c.n}${c.title}`).join() === CLAUSES.map((c) => `${c.n}${c.title}`).join());

console.log('\n— the archive itself —');
/*
 * A revision is addressed by clause number and paragraph position. That is
 * readable, and it is also exactly the kind of address a later edit can break
 * without touching this file: insert a paragraph into section 4 and entry 4.1
 * silently starts archiving the wrong sentence. These are the checks that make
 * that loud.
 */
check('there is an archive at all', SUPERSEDED.length >= 1);
for (const revision of SUPERSEDED) {
  check(`${revision.version} is not the version in force`, revision.version !== AGREEMENT_VERSION);
  check(`${revision.version} says what changed`, revision.note.trim().length > 0);

  for (const entry of revision.paras) {
    const clause = CLAUSES.find((c) => c.n === entry.clause);
    check(`${revision.version} names a section that exists`, Boolean(clause), `section ${entry.clause}`);
    check(
      `${revision.version} names a paragraph that exists`,
      Boolean(clause) && entry.at >= 0 && entry.at < clause!.paras.length,
      `${entry.clause}.${entry.at}`,
    );
    // Archiving text identical to the current text means either the revision
    // did nothing or the address has drifted onto the wrong paragraph.
    check(
      `${revision.version} archives text that actually differs`,
      Boolean(clause) && clause!.paras[entry.at] !== entry.text,
      `${entry.clause}.${entry.at}`,
    );
  }

  for (const term of Object.keys(revision.summary)) {
    check(`${revision.version} names a summary row that exists`, SUMMARY.some((row) => row.term === term), term);
    check(
      `${revision.version} archives a summary row that differs`,
      SUMMARY.find((row) => row.term === term)?.details !== revision.summary[term],
      term,
    );
  }
}

console.log('\n— every paragraph, in order —');
const now = allParagraphs();
const then = allParagraphs(OLD);
check('the two versions run to the same length', now.length === then.length, `${now.length} vs ${then.length}`);
check('today reads as Net 15', now.some((line) => line.text.includes('net fifteen (15) days')));
check('and never as Net 45', !now.some((line) => line.text.includes('net forty-five (45) days')));
check('and never as Net 30', !now.some((line) => line.text.includes('net thirty (30) days')));
check('the signed version reads as Net 30', then.some((line) => line.text.includes('net thirty (30) days')));
check('and never as Net 45 or Net 15', !then.some((line) => line.text.includes('net forty-five (45) days') || line.text.includes('net fifteen (15) days')));
check('the headings are the same either way', now.map((l) => l.heading).join() === then.map((l) => l.heading).join());
/*
 * The governing state is filled in on the way out of allParagraphs, so it has
 * to survive being routed through a superseded version as well.
 */
check('section 12 still resolves its blank in both', now.some((l) => l.text.includes('____________________')) && then.some((l) => l.text.includes('____________________')));
check('and clauseText is what does it', clauseText('governed by the laws of the State of {{STATE}}').includes('____________________'));

console.log('\n— an unknown version —');
/*
 * What an older deployment sees in a row signed under a later revision. It
 * still draws the agreement, because refusing somebody their own signed copy
 * is worse, and the PDF says on its face that the text is today's. Here that
 * is only the fallback: the saying-so is in pdf-checks.
 */
check('falls back to the wording in force', payment('2099-01') === payment(AGREEMENT_VERSION));
check('rather than to nothing at all', clausesFor('2099-01').length === CLAUSES.length);
check('and is reported as not on file', !wordingKnown('2099-01'));

console.log('\n— nothing is mutated on the way through —');
const before = JSON.stringify(CLAUSES);
clausesFor(OLD);
summaryFor(OLD);
allParagraphs(OLD);
check('reading an old version leaves the current one alone', JSON.stringify(CLAUSES) === before);
check('and the summary too', SUMMARY.find((row) => row.term === 'Payment Terms')!.details.startsWith('Net 15'));

console.log(`\nagreement: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
