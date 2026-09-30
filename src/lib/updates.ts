/**
 * Update notes: what changed, in words an affiliate reads.
 *
 * One list, newest first, read by three things: the /updates page, the pop-up
 * that shows the latest note once a day, and the banner on the overview. A new
 * note is one entry at the top of UPDATES; nothing else needs touching.
 *
 * A note is announced (pop-up and banner) for ANNOUNCE_DAYS after its date and
 * then only lives on the /updates page, so an old change does not nag forever.
 *
 * Client-safe: no node imports, because the pop-up runs in the browser.
 */

export type Update = {
  /** Stable key, also what the pop-up remembers having shown. */
  id: string;
  /** YYYY-MM-DD, the day the change took effect. */
  date: string;
  title: string;
  /** One sentence, for the banner and the top of the pop-up. */
  summary: string;
  /** What changed, one point per line. */
  points: string[];
  /** Who it is announced to. Everybody can still read it on /updates. */
  audience: 'everyone' | 'affiliates';
};

export const ANNOUNCE_DAYS = 30;

export const UPDATES: Update[] = [
  {
    id: '2026-10-01-net-15',
    date: '2026-10-01',
    title: 'You get paid sooner: payouts now 15 days after approval',
    summary: 'Payment terms have changed from Net 45 to Net 15. You can request payment for a card 15 days after it is approved.',
    points: [
      'A card can now be requested 15 days after it is approved, instead of 45.',
      'Cards approved 15 or more days ago are ready to request right away. Find them on your Payslip page.',
      'The affiliate agreement now says Net 15 (version 2026-10-01). The agreement you signed stays on file, and the 15 days applies to everyone.',
      'Payment is still by ACH to the bank account on your profile.',
    ],
    audience: 'everyone',
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest note this viewer should be told about today, or null. */
export function currentAnnouncement(
  isAdmin: boolean,
  today: Date = new Date(),
  updates: Update[] = UPDATES,
): Update | null {
  const latest = updates[0];
  if (!latest) return null;
  if (latest.audience === 'affiliates' && isAdmin) return null;
  // From the moment its date has begun anywhere (UTC+14), so a note dated
  // today is live for somebody ahead of UTC too, not only after UTC midnight.
  // It ends ANNOUNCE_DAYS after its UTC midnight.
  const now = today.getTime();
  const starts = Date.parse(`${latest.date}T00:00:00+14:00`);
  const ends = Date.parse(`${latest.date}T00:00:00Z`) + ANNOUNCE_DAYS * DAY_MS;
  return now >= starts && now < ends ? latest : null;
}

/** "1 Oct 2026", the way the rest of the app prints a day. */
export function updateDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(m ?? 1) - 1];
  return `${d} ${month} ${y}`;
}
