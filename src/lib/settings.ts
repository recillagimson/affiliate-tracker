/**
 * The two numbers an admin owns: what share of a payout an affiliate keeps, and
 * how little a card may pay before it stops being worth listing.
 *
 * Pure. No store, no node imports, no React, because both the settings form in
 * the browser and every server page that reads a figure need the same answers
 * and must not be able to give two.
 *
 * The share is the interesting half. It is not a number, it is a history:
 *
 *   [{ from: '', rate: 0.5 }, { from: '2026-09-01', rate: 0.6 }]
 *
 * An approval is paid at whatever rate was in force on the day it was approved,
 * so raising the rate tomorrow leaves every approval already banked exactly
 * where it was. Storing one number instead would mean that changing it silently
 * restated every figure the team has ever been shown, including the ones people
 * have already been paid against, and nobody would get a warning about it.
 *
 * Keyed on the approval date rather than on when the row was typed in, and that
 * distinction is load-bearing: approvals arrive late. An approval dated the 20th
 * that is entered on the 5th of the next month was still approved under the old
 * rate, and the person who earned it should be paid what it was worth then.
 *
 * scripts/settings-checks.ts holds all of that in place.
 */

/** The affiliate's cut before anybody sets one. Half, which is what it was. */
export const DEFAULT_SHARE = 0.5;

/** One rate, and the first day it applies to. */
export type ShareRate = {
  /**
   * The first approval day this rate covers, as YYYY-MM-DD. An empty string
   * means "from the beginning", which is what the opening rate always is: there
   * has to be an answer for every approval already in the table, including the
   * ones older than any rate anybody has set.
   */
  from: string;
  /** The affiliate's share of a payout, as a fraction between 0 and 1. */
  rate: number;
};

export type Settings = {
  /** Oldest first. Always at least one entry, always starting from ''. */
  shares: ShareRate[];
  /**
   * The least a card may pay the merchant and still be listed on the rate card.
   * Null means list everything.
   */
  cpaFloor: number | null;
  /**
   * Cards an admin has marked Inactive on the rate card, as `issuer|card`
   * (lib/cpa-groups groupRates' key). Kept here rather than on the rate rows
   * because an upload replaces those whole, and the mark has to outlive it.
   */
  inactiveCards: string[];
  updatedAt: string;
  updatedBy: string;
};

export function defaultSettings(): Settings {
  return {
    shares: [{ from: '', rate: DEFAULT_SHARE }],
    cpaFloor: null,
    inactiveCards: [],
    updatedAt: '',
    updatedBy: '',
  };
}

/* ------------------------------------------------------------- the share -- */

/**
 * The rate in force on a given approval day.
 *
 * The last entry whose start day has arrived. A row with no approval date at
 * all falls to the opening rate rather than to the newest one: an undated row
 * is an old row that lost its date, not one approved today.
 */
export function shareOn(day: string, shares: ShareRate[]): number {
  const ordered = orderShares(shares);
  if (ordered.length === 0) return DEFAULT_SHARE;

  const key = (day ?? '').slice(0, 10);
  let found = ordered[0]!;
  if (!key) return found.rate;
  for (const entry of ordered) {
    if (entry.from === '' || entry.from <= key) found = entry;
    else break;
  }
  return found.rate;
}

/** The rate a new approval would be paid at today. */
export function currentShare(shares: ShareRate[], today: string): number {
  return shareOn(today, shares);
}

/** Oldest first, with the opening rate first whatever order it arrived in. */
export function orderShares(shares: ShareRate[]): ShareRate[] {
  return [...shares].sort((a, b) => {
    if (a.from === b.from) return 0;
    if (a.from === '') return -1;
    if (b.from === '') return 1;
    return a.from < b.from ? -1 : 1;
  });
}

/**
 * A history that can be relied on: ordered, one entry per day, always covering
 * every approval that could ever be looked up.
 *
 * Two entries starting the same day is the shape a double-submitted form makes.
 * The later one in the list wins, because that is the one the person meant.
 * A history with no opening entry gets one at the default rate rather than
 * leaving older approvals with no answer at all.
 */
export function normaliseShares(shares: ShareRate[]): ShareRate[] {
  const byDay = new Map<string, number>();
  for (const entry of shares) {
    const rate = clampRate(entry.rate);
    if (rate === null) continue;
    byDay.set(dayOf(entry.from), rate);
  }

  const ordered = orderShares([...byDay].map(([from, rate]) => ({ from, rate })));
  if (ordered.length === 0 || ordered[0]!.from !== '') {
    return [{ from: '', rate: DEFAULT_SHARE }, ...ordered];
  }
  return ordered;
}

/** A percentage as a fraction: 60 becomes 0.6. Null for anything unusable. */
export function rateFromPercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  return clampRate(Math.round(percent * 100) / 10000);
}

/** A fraction as a percentage for display: 0.6 becomes "60%". */
export function formatShare(rate: number): string {
  const percent = Math.round(rate * 10000) / 100;
  return `${percent}%`;
}

/**
 * A rate that could be a share of a payout, or null.
 *
 * Zero is allowed. An affiliate on 0% is somebody whose arrangement has ended
 * but whose history has to keep adding up, and refusing to record that would
 * only mean it got recorded as something else. Anything over 100% is refused:
 * paying out more than came in is a typo every time.
 */
function clampRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  return Math.round(rate * 10000) / 10000;
}

function dayOf(value: string): string {
  const day = (value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/* ------------------------------------------------------- the rate floor --- */

/**
 * Whether a card pays enough to be listed.
 *
 * Judged on the merchant's rate rather than on anybody's share, so that the
 * rate card holds the same cards for every reader. A floor that hid different
 * cards from different people would have an affiliate and an admin quoting from
 * two different price lists.
 *
 * A card with no rate at all does not clear a floor. A floor exists to keep the
 * rate card to the cards worth quoting, and a card with no figure is not one of
 * them; when it is given a rate it comes back on its own. This is the same rule
 * the search filter on the page uses, so setting the floor to 200 and typing
 * 200 into the filter cannot produce two different lists.
 */
export function clearsFloor(current: number | null, floor: number | null): boolean {
  if (floor === null) return true;
  if (current === null) return false;
  return current >= floor;
}

/** A floor a person typed, or null for "list everything". */
export function floorFrom(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

/* ------------------------------------------------------------- storage --- */

/**
 * Settings read back out of whatever the store handed over.
 *
 * Forgiving on purpose. This parses a blob that may have been written by an
 * older version of this file, edited by hand in a spreadsheet cell, or not
 * written at all. Anything it cannot make sense of falls back to the default,
 * because a settings page that will not load is a settings page nobody can use
 * to fix the setting that broke it.
 */
export function parseSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Record<string, unknown>;

  const shares = Array.isArray(value.shares)
    ? value.shares
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({ from: String(entry.from ?? ''), rate: Number(entry.rate) }))
    : [];

  return {
    shares: normaliseShares(shares),
    cpaFloor: floorFrom(value.cpaFloor as string | number | null | undefined),
    inactiveCards: Array.isArray(value.inactiveCards)
      ? [...new Set(value.inactiveCards.filter((key): key is string => typeof key === 'string' && key.includes('|')))]
      : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
  };
}

/* --------------------------------------------------------- the changes --- */

/** What the settings form sends when somebody adds a rate. */
export type ShareChange = { percent: number; from: string };

/**
 * What is wrong with a proposed rate change, if anything.
 *
 * Returned as a map of field to message, the same shape the onboarding forms
 * use, so the form can put each complaint under the box it belongs to.
 */
export function shareProblems(change: ShareChange, existing: ShareRate[]): Record<string, string> {
  const problems: Record<string, string> = {};

  const rate = rateFromPercent(change.percent);
  if (rate === null) {
    problems.percent = 'A percentage between 0 and 100.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.from ?? '')) {
    problems.from = 'Pick the first day it applies to.';
  } else if (existing.some((entry) => entry.from === change.from)) {
    // Replacing a rate that starts the same day is a legitimate correction, but
    // it is not what somebody adding a rate expects to have happened, so it is
    // said rather than done silently.
    problems.from = 'There is already a rate starting that day. Remove it first.';
  }

  return problems;
}

/**
 * How many approvals a change would restate, and the first one it touches.
 *
 * The whole point of dating a rate is that the answer is nought. This is what
 * lets the form say so before the button is pressed rather than after, and what
 * makes a mistyped year visible instead of quietly repricing two years of work.
 */
export function approvalsAffected(
  days: { day: string; count: number }[],
  from: string,
): { count: number; earliest: string } {
  let count = 0;
  let earliest = '';
  for (const entry of days) {
    if (!entry.day || entry.day < from) continue;
    count += entry.count;
    if (!earliest || entry.day < earliest) earliest = entry.day;
  }
  return { count, earliest };
}

/* ------------------------------------------------------- inactive cards --- */

/** Longer than any `issuer|card` the rate card has held, short enough to refuse junk. */
const MAX_CARD_KEY = 300;

/** A card key worth storing: `issuer|card` with a card name after the bar. */
export function isCardKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= MAX_CARD_KEY && key.indexOf('|') >= 0 && key.split('|').slice(1).join('|').trim() !== '';
}

/** The list with one card marked inactive or active again. Order kept, no duplicates. */
export function withCardStatus(inactiveCards: string[], key: string, inactive: boolean): string[] {
  const rest = inactiveCards.filter((entry) => entry !== key);
  return inactive ? [...rest, key] : rest;
}
