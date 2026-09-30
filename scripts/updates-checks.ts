/**
 * Update notes: who is told about the latest one, and for how long.
 *
 *   npx tsx scripts/updates-checks.ts
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { UpdateBanner } from '../src/components/UpdateBanner';
import { ANNOUNCE_DAYS, currentAnnouncement, UPDATES, updateDay } from '../src/lib/updates';
import { PAYMENT_DAYS } from '../src/lib/agreement';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const latest = UPDATES[0]!;

console.log('— the list —');
check('there is a note', UPDATES.length > 0, true);
check('newest first', UPDATES.every((u, i) => i === 0 || UPDATES[i - 1]!.date >= u.date), true);
check('ids are unique', new Set(UPDATES.map((u) => u.id)).size, UPDATES.length);
check('every note says something', UPDATES.every((u) => u.title && u.summary && u.points.length > 0), true);
check('the Net 15 note names the term in force', latest.summary.includes(`Net ${PAYMENT_DAYS}`), true);

console.log('\n— who is told, and when —');
check('an affiliate on the day', currentAnnouncement(false, at('2026-10-01'))?.id, latest.id);
check('and on the last day', currentAnnouncement(false, at('2026-10-30'))?.id, latest.id);
check(`not after ${ANNOUNCE_DAYS} days`, currentAnnouncement(false, at('2026-10-31')), null);
check('as soon as it is 1 Oct in Manila, though still 30 Sep in UTC', currentAnnouncement(false, new Date('2026-09-30T19:27:00Z'))?.id, latest.id);
check('not before its date has begun anywhere', currentAnnouncement(false, new Date('2026-09-30T09:00:00Z')), null);
check('an admin is told too', currentAnnouncement(true, at('2026-10-02'))?.id, latest.id);
check('an affiliates-only note is not announced to an admin', currentAnnouncement(true, at('2026-10-02'), [{ ...latest, audience: 'affiliates' }]), null);

console.log('\n— how it reads —');
check('a day as people read it', updateDay('2026-10-01'), '1 Oct 2026');
const banner = renderToStaticMarkup(createElement(UpdateBanner, { update: latest }));
check('the banner links to the notes', banner.includes('href="/updates"'), true);
check('and carries the summary', banner.includes('Net 15'), true);

console.log(`\nupdates: ${failed === 0 ? 'all passed' : `${failed} failed`}`);
process.exitCode = failed === 0 ? 0 : 1;
