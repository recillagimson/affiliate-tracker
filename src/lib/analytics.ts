import { leadRefIn, visibleNotes } from './qmp-sync';
import { DEFAULT_SHARE, shareOn, type ShareRate } from './settings';
import type { AffiliateLink, Conversion, Submission, Visit } from './types';

export type DayBucket = { date: string; label: string; submissions: number; visits: number };

export type PerformanceRow = {
  key: string;
  label: string;
  sublabel: string;
  visits: number;
  submissions: number;
  conversion: number;
};

export type Insight = {
  campaign: string;
  slug: string;
  visitShare: number;
  conversion: number;
} | null;

export type DashboardStats = {
  totalSubmissions: number;
  /** Leads someone has marked registered, here or in the sheet. */
  registered: number;
  /** Leads the merchant's report shows applying, not approved yet. */
  applied: number;
  /** Everything nothing has moved yet — the working list. */
  pending: number;
  /** Share of all leads that reached registered. */
  registrationRate: number;
  totalVisits: number;
  conversion: number;
  activeLinks: number;
  totalLinks: number;
  totalPeople: number;
  submissionsToday: number;
  submissionsYesterday: number;
  visitsToday: number;
  submissionsLast7: number;
  submissionsPrev7: number;
  trend7: number | null;
  /** Change vs yesterday, null when yesterday was empty. */
  trendDay: number | null;
  series: DayBucket[];
  byAssignee: PerformanceRow[];
  byCampaign: PerformanceRow[];
  /** The campaign taking a big share of traffic and returning the least. */
  insight: Insight;
};

function dayKey(iso: string): string {
  // ISO timestamps are stored in UTC; bucket on the date portion.
  return iso.slice(0, 10);
}

function daysAgoKey(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Visits are a best-effort beacon, so a blocked beacon can leave submissions >
 * visits. Clamping keeps "142% conversion" off the dashboard.
 */
function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(1, numerator / denominator);
}

export function buildStats(
  links: AffiliateLink[],
  submissions: Submission[],
  visits: Visit[],
  days = 30,
): DashboardStats {
  const today = daysAgoKey(0);
  const yesterday = daysAgoKey(1);
  const start7 = daysAgoKey(6);
  const startPrev7 = daysAgoKey(13);

  let submissionsToday = 0;
  let submissionsYesterday = 0;
  let visitsToday = 0;
  let submissionsLast7 = 0;
  let submissionsPrev7 = 0;
  let registered = 0;
  let applied = 0;

  const submissionsByDay = new Map<string, number>();
  const visitsByDay = new Map<string, number>();

  for (const row of submissions) {
    const key = dayKey(row.createdAt);
    submissionsByDay.set(key, (submissionsByDay.get(key) ?? 0) + 1);
    if (row.status === 'registered') registered += 1;
    else if (row.status === 'applied') applied += 1;
    if (key === today) submissionsToday += 1;
    if (key === yesterday) submissionsYesterday += 1;
    if (key >= start7) submissionsLast7 += 1;
    else if (key >= startPrev7) submissionsPrev7 += 1;
  }

  for (const row of visits) {
    const key = dayKey(row.createdAt);
    visitsByDay.set(key, (visitsByDay.get(key) ?? 0) + 1);
    if (key === today) visitsToday += 1;
  }

  const series: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = daysAgoKey(i);
    const date = new Date(`${key}T00:00:00Z`);
    series.push({
      date: key,
      label: date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      submissions: submissionsByDay.get(key) ?? 0,
      visits: visitsByDay.get(key) ?? 0,
    });
  }

  // Assignee rollup — keyed on the `usr` value so visits (which only carry usr)
  // line up with submissions.
  // Newest link wins, independent of the order the caller happened to pass in:
  // renaming an assignee on a new link shouldn't leave the dashboard showing the
  // name from their oldest one.
  const newestFirst = [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const assigneeNames = new Map<string, string>();
  for (const link of newestFirst) {
    if (link.usr && !assigneeNames.has(link.usr)) {
      assigneeNames.set(link.usr, link.assignee || link.usr);
    }
  }
  for (const row of submissions) {
    if (row.usr && row.assignee && !assigneeNames.has(row.usr)) {
      assigneeNames.set(row.usr, row.assignee);
    }
  }

  const byAssignee = rollup(
    submissions,
    visits,
    (row) => row.usr || '(house)',
    (key) => ({
      label: key === '(house)' ? 'Unassigned / house' : assigneeNames.get(key) ?? key,
      sublabel: key === '(house)' ? 'no usr param' : `usr=${key}`,
    }),
  );

  const campaignNames = new Map<string, string>();
  for (const link of newestFirst) {
    if (!campaignNames.has(link.slug)) campaignNames.set(link.slug, link.campaign || link.slug);
  }

  const byCampaign = rollup(
    submissions,
    visits,
    (row) => row.slug,
    (key) => ({ label: campaignNames.get(key) ?? key, sublabel: `/${key}` }),
  );

  const people = new Set(links.filter((l) => l.usr).map((l) => l.usr));

  return {
    totalSubmissions: submissions.length,
    registered,
    applied,
    pending: submissions.length - registered - applied,
    registrationRate: safeRate(registered, submissions.length),
    totalVisits: visits.length,
    conversion: safeRate(submissions.length, visits.length),
    activeLinks: links.filter((l) => l.active).length,
    totalLinks: links.length,
    totalPeople: people.size,
    submissionsToday,
    submissionsYesterday,
    visitsToday,
    submissionsLast7,
    submissionsPrev7,
    trend7:
      submissionsPrev7 === 0
        ? submissionsLast7 > 0
          ? null
          : 0
        : (submissionsLast7 - submissionsPrev7) / submissionsPrev7,
    trendDay:
      submissionsYesterday === 0
        ? null
        : (submissionsToday - submissionsYesterday) / submissionsYesterday,
    series,
    byAssignee,
    byCampaign,
    insight: findInsight(byCampaign, visits.length),
  };
}

/**
 * The campaign worth a second look: it takes a meaningful share of the traffic
 * and converts worse than the rest. Returns null until there is enough traffic
 * for the comparison to mean anything.
 */
function findInsight(byCampaign: PerformanceRow[], totalVisits: number): Insight {
  if (totalVisits < 20 || byCampaign.length < 2) return null;

  const candidates = byCampaign.filter((row) => row.visits >= 10);
  if (candidates.length < 2) return null;

  const worst = [...candidates].sort((a, b) => a.conversion - b.conversion)[0]!;
  const rest = candidates.filter((row) => row.key !== worst.key);
  const restRate = safeRate(
    rest.reduce((sum, row) => sum + row.submissions, 0),
    rest.reduce((sum, row) => sum + row.visits, 0),
  );

  // Only worth surfacing if it is meaningfully behind the others.
  if (worst.conversion >= restRate * 0.6) return null;

  return {
    campaign: worst.label,
    slug: worst.sublabel.replace(/^\//, ''),
    visitShare: safeRate(worst.visits, totalVisits),
    conversion: worst.conversion,
  };
}

function rollup(
  submissions: Submission[],
  visits: Visit[],
  keyOf: (row: { slug: string; usr: string }) => string,
  labelOf: (key: string) => { label: string; sublabel: string },
): PerformanceRow[] {
  const subCounts = new Map<string, number>();
  const visitCounts = new Map<string, number>();

  for (const row of submissions) {
    const key = keyOf(row);
    subCounts.set(key, (subCounts.get(key) ?? 0) + 1);
  }
  for (const row of visits) {
    const key = keyOf(row);
    visitCounts.set(key, (visitCounts.get(key) ?? 0) + 1);
  }

  const keys = new Set([...subCounts.keys(), ...visitCounts.keys()]);
  return [...keys]
    .map((key) => {
      const submissionCount = subCounts.get(key) ?? 0;
      const visitCount = visitCounts.get(key) ?? 0;
      return {
        key,
        ...labelOf(key),
        submissions: submissionCount,
        visits: visitCount,
        conversion: safeRate(submissionCount, visitCount),
      };
    })
    .sort((a, b) => b.submissions - a.submissions || b.visits - a.visits);
}

/**
 * Identity of a link for counting purposes. Exported so callers look rows up
 * with the exact same key the map was built with — constructing this key in two
 * places is how per-link stats silently render as zero.
 */
export function linkKey(row: { slug: string; usr: string }): string {
  return `${row.slug}::${row.usr}`;
}

/** Per-link counts for the links table. */
export function countsByLink(
  links: AffiliateLink[],
  submissions: Submission[],
  visits: Visit[],
): Map<string, { visits: number; submissions: number }> {
  const out = new Map<string, { visits: number; submissions: number }>();
  for (const link of links) {
    out.set(linkKey(link), { visits: 0, submissions: 0 });
  }
  for (const row of visits) {
    const entry = out.get(linkKey(row));
    if (entry) entry.visits += 1;
  }
  for (const row of submissions) {
    const entry = out.get(linkKey(row));
    if (entry) entry.submissions += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Performance: one row per person per card                            */
/* ------------------------------------------------------------------ */

/**
 * Rolling windows, not calendar ones. "Week" is the last 7 days including
 * today, not Monday-to-now — so a figure never collapses to almost nothing just
 * because it happens to be Monday morning. The labels say days for that reason.
 */
export type Period = 'day' | 'week' | 'month' | 'all';

export const PERIODS: { key: Period; label: string; days: number | null }[] = [
  { key: 'day', label: 'Today', days: 1 },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
  { key: 'all', label: 'All time', days: null },
];

/** Earliest day key included by a period, or '' for all time. */
export function periodStart(period: Period): string {
  const days = PERIODS.find((p) => p.key === period)?.days ?? null;
  if (days === null) return '';
  return daysAgoKey(days - 1);
}

/* --------------------------------------------------------- calendar months -- */

/**
 * A calendar month, `YYYY-MM`, read out of the URL, or '' for none.
 *
 * The periods above are rolling windows; a month is the other question people
 * ask of this data, "what did September come to", which is the unit a payout is
 * settled and a statement is checked in. It sits beside the periods rather than
 * replacing one, and outranks them when both are in the URL.
 */
export function parseMonth(raw: string): string {
  const value = (raw ?? '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Before the web had affiliate links is a transposed year, not a month.
  if (year < 2000 || month < 1 || month > 12) return '';
  return value;
}

/**
 * The first and last day a month covers, both included. Day 0 of the next
 * month is the last day of this one, so Date does the counting, February and
 * all.
 */
export function monthWindow(month: string): { start: string; end: string } {
  const [year, index] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, index! - 1, 1));
  const last = new Date(Date.UTC(year!, index!, 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

/** "September 2026". */
export function monthLabel(month: string): string {
  return longMonth(month);
}

/**
 * Every month with a visit or an approval in it, newest first: the month
 * filter's options. Visits by the click and approvals by their approval day,
 * as everywhere else. From every row rather than the filtered ones, for the
 * reason the person filter gives: options that vanish as you narrow the view
 * are no way to widen it again.
 */
export function activeMonths(visits: Visit[], conversions: Conversion[]): string[] {
  const months = new Set<string>();
  for (const visit of visits) months.add(dayKey(visit.createdAt).slice(0, 7));
  for (const row of conversions) months.add(row.approvedOn.slice(0, 7));
  return [...months].filter((month) => parseMonth(month) !== '').sort().reverse();
}

/**
 * The sales figures for a window: how many approvals, what they paid, the
 * affiliates' share of that, and what is kept.
 *
 * What is kept is the payout less the share, not a share of its own. The
 * share is worked out approval by approval at the rate on each one's day
 * (buildEarnings), so taking the rest from the total is what guarantees the
 * two add back up to the payout, to the cent, across a rate change.
 *
 * `gross` false is an affiliate, whose rows already are their share. They are
 * shown that and the count, and never the merchant's payout or the house's
 * cut, so both come back null rather than as a number to be hidden later.
 */
export function salesFigures(
  totals: { approved: number; earnings: number; affiliate: number },
  gross: boolean,
): { sales: number; payout: number | null; share: number; keep: number | null } {
  if (!gross) return { sales: totals.approved, payout: null, share: totals.affiliate, keep: null };
  const payout = Math.round(totals.earnings * 100) / 100;
  return {
    sales: totals.approved,
    payout,
    share: totals.affiliate,
    keep: Math.round((payout - totals.affiliate) * 100) / 100,
  };
}

export type EarningsRow = {
  key: string;
  usr: string;
  /** Display name for the assignee, or the house label. */
  person: string;
  /** The card, when grouping by card. Empty when grouping by person. */
  card: string;
  /** How many distinct cards are folded into this row. Person grouping only. */
  cardCount: number;
  visits: number;
  approved: number;
  earnings: number;
  /**
   * The affiliate's share of `earnings`, worked out one approval at a time.
   *
   * Kept beside the gross rather than derived from it, because it cannot be
   * derived from it any more: two approvals in the same row can have been
   * earned under two different commission rates, and half of the total is then
   * not the total of the halves. For a reader who is already being shown their
   * own share this is the same number as `earnings`.
   */
  affiliate: number;
  /** Approvals per visit, clamped — approvals can be logged without a tracked click. */
  approvalRate: number;
};

/**
 * Person rows on the dashboard, card rows on a person's own page. Same numbers,
 * one level apart — so the two views can never disagree about a total.
 */
export type GroupBy = 'person' | 'card';

/**
 * One bar group in the chart.
 *
 * A bucket is a day, a week or a calendar month — one step coarser than the
 * window that was asked for, so the chart is the context around the figure
 * rather than a second copy of it. Thirty daily bars on a traffic level of
 * single figures is thirty hairlines and one spike, which carries no
 * information you can read; half a dozen bars of a bigger unit does.
 */
export type EarningsBucket = {
  /** First day in the bucket, YYYY-MM-DD. */
  start: string;
  /** Last day in the bucket, inclusive. */
  end: string;
  /** The short label under the bar: "Tue 12", "Aug 12", "Mar". */
  label: string;
  /** The span spelled out, for the table behind the picture. */
  range: string;
  /** The bucket today falls in, which the chart draws in bold. */
  current: boolean;
  visits: number;
  approved: number;
};

/**
 * The chart's whole contents: the bars, and what they are.
 *
 * The heading, the span and the caption travel with the bars rather than being
 * written into the component, because they are the part that says what the bars
 * mean, and "Week by week" over a chart of months is worse than no heading at
 * all.
 */
export type EarningsSeries = {
  buckets: EarningsBucket[];
  /** "Day by day", "Week by week", "Month by month". */
  title: string;
  /**
   * What the bars cover: "last 7 days", "last 6 months".
   *
   * Shown next to the heading, and load-bearing rather than decoration. The
   * chart deliberately reaches back further than the filter does, so without
   * this a reader could add up the bars, get a bigger number than the figure
   * beside them, and conclude that one of the two is wrong.
   */
  span: string;
  /** The sentence read in place of the picture. */
  caption: string;
};

export type EarningsView = {
  rows: EarningsRow[];
  totals: { visits: number; approved: number; earnings: number; affiliate: number; approvalRate: number };
  /** Everyone who has a link, a visit or an approval — the filter's options. */
  people: { usr: string; name: string }[];
  series: EarningsSeries;
};

/**
 * Stands in for "no usr" wherever a key is needed — in a URL as well as in a
 * map. The underscore is what makes it collision-proof: normalizeKey turns any
 * non-alphanumeric into a dash, so no real tracking key can ever be `_house`.
 */
export const HOUSE_KEY = '_house';
const HOUSE_LABEL = 'Unassigned / house';

/** The URL for one person's own earnings page. */
export function affiliateHref(usr: string, period?: Period, month = ''): string {
  const base = `/affiliate/${encodeURIComponent(usr || HOUSE_KEY)}`;
  // A month outranks the period, on the person's page as on the dashboard.
  if (month) return `${base}?month=${month}`;
  return period && period !== 'month' ? `${base}?period=${period}` : base;
}

/**
 * usr → display name, newest link wins so a rename shows the current name.
 *
 * Links are the only source: a conversion stores just the tracking key, so a
 * person whose links have all been deleted shows as their bare `usr` rather
 * than a name frozen at the time of the sale. That is the honest reading — the
 * name lives in one place and one place only.
 */
export function nameIndex(links: AffiliateLink[]): Map<string, string> {
  const names = new Map<string, string>();
  const newestFirst = [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const link of newestFirst) {
    if (link.usr && link.assignee && !names.has(link.usr)) names.set(link.usr, link.assignee);
  }
  return names;
}

/**
 * slug+usr → card name. Falls back to any link on the same slug, so a click that
 * arrived with an unknown ?usr= (which the landing page serves from the house
 * row) still reports under the campaign it actually saw rather than a bare slug.
 */
function cardIndex(links: AffiliateLink[]): { exact: Map<string, string>; bySlug: Map<string, string> } {
  const exact = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const newestFirst = [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const link of newestFirst) {
    const card = link.campaign || link.slug;
    exact.set(linkKey(link), card);
    if (!bySlug.has(link.slug)) bySlug.set(link.slug, card);
  }
  return { exact, bySlug };
}

type CardIndex = ReturnType<typeof cardIndex>;

/** The card a row belongs to: its own link, else any link on the same slug, else the slug. */
function cardFor(cards: CardIndex, row: { slug: string; usr: string }): string {
  return cards.exact.get(linkKey(row)) ?? cards.bySlug.get(row.slug) ?? row.slug;
}

/**
 * What is shown when an approval names no client. A plain dash, deliberately:
 * "Unknown" reads as a fact about the client, and this is a fact about the row.
 */
export const UNKNOWN_CLIENT = '-';

/**
 * Lead reference → the name on that lead.
 *
 * The reference is the submission's own id (see lib/lead-id.ts), which is what
 * travels out as var3 and comes back on the QMP report. A lead with no name
 * still resolves, to its email, because knowing which address it was is better
 * than a dash; only a reference that matches no row at all is unknown.
 */
export function clientIndex(submissions: Submission[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of submissions) {
    const id = (row.id ?? '').trim();
    if (!id || names.has(id)) continue;
    const name = (row.fullName || row.email || '').trim();
    if (name) names.set(id, name);
  }
  return names;
}

/** A conversion with the person, card and client its row resolves to. */
export type ConversionView = Conversion & {
  person: string;
  card: string;
  /**
   * The affiliate's share of this one approval, at the rate in force on the day
   * it was approved. Already the amount itself for a reader who is being shown
   * their own share rather than the merchant's.
   */
  affiliate: number;
  /** The lead this approval came from, or a dash when it names nobody. */
  client: string;
  /** The notes with the machine tags stripped out. */
  note: string;
};

/**
 * Decorate raw conversions for listing. The name, card and client are resolved
 * through the links and leads here rather than stored on the row, so a list and
 * the table above it can never label the same sale differently.
 *
 * The client comes from the lead reference the sync kept in the notes (var3 on
 * the QMP row, which is the id of the submission). An approval recorded by hand
 * has no reference, and one whose lead has since been deleted has a reference
 * that resolves to nothing. Both are normal, and both read as a dash — the
 * alternative is inventing a name for a row that does not have one.
 *
 * `submissions` is optional so the callers that only list money do not have to
 * load leads to do it; without it, every client is a dash.
 */
export function describeConversions(
  links: AffiliateLink[],
  conversions: Conversion[],
  submissions: Submission[] = [],
  { shares = [], gross = true }: { shares?: ShareRate[]; gross?: boolean } = {},
): ConversionView[] {
  const names = nameIndex(links);
  const cards = cardIndex(links);
  const clients = clientIndex(submissions);
  return conversions.map((row) => {
    const notes = row.notes ?? '';
    return {
      ...row,
      affiliate: revenueFrom(row.amount, gross, shareOn(row.approvedOn, shares)),
      person: row.usr ? names.get(row.usr) ?? row.usr : 'House',
      card: cardFor(cards, row),
      client: clients.get(leadRefIn(notes)) ?? UNKNOWN_CLIENT,
      note: visibleNotes(notes),
    };
  });
}

/**
 * Visits, approvals and earnings rolled up per person per card.
 *
 * Visits are bucketed by when the click happened and approvals by their approval
 * date, which is the honest reading of each: an approval that lands three weeks
 * after the click belongs to the week it was approved, since that is when it was
 * earned. It also means a period can show approvals with no visits, so the rate
 * is clamped rather than allowed past 100%.
 */
export function buildEarnings(
  links: AffiliateLink[],
  visits: Visit[],
  conversions: Conversion[],
  {
    period = 'month',
    month = '',
    usr = '',
    groupBy = 'person',
    shares = [],
    gross = true,
  }: {
    period?: Period;
    /** A calendar month, `YYYY-MM`. When set it decides the window instead of `period`. */
    month?: string;
    usr?: string;
    groupBy?: GroupBy;
    /**
     * The commission history. Each approval is valued at the rate in force on
     * the day it was approved, so a rate set today leaves last month's rows
     * exactly where they were.
     */
    shares?: ShareRate[];
    /**
     * Whether `conversions` carry the merchant's gross payouts. False means
     * they are already this viewer's share (lib/load halves them on the way
     * out), in which case the share column is the amount itself and halving it
     * again would pay them a quarter.
     */
    gross?: boolean;
  } = {},
): EarningsView {
  const names = nameIndex(links);
  const cards = cardIndex(links);
  // A month is closed at both ends; a period only has a start, and runs to today.
  const { start, end } = month ? monthWindow(month) : { start: periodStart(period), end: '' };
  const inWindow = (day: string) => (!start || day >= start) && (!end || day <= end);
  const matchesPerson = (rowUsr: string) => !usr || (rowUsr || HOUSE_KEY) === usr;

  const rows = new Map<string, EarningsRow>();
  // Tracked per row rather than derived at the end, so a person's card count is
  // the number of cards that actually had activity in this window.
  const cardsSeen = new Map<string, Set<string>>();

  const rowFor = (rowUsr: string, card: string): EarningsRow => {
    const personKey = rowUsr || HOUSE_KEY;
    const key = groupBy === 'card' ? card : personKey;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        usr: rowUsr,
        person: rowUsr ? names.get(rowUsr) ?? rowUsr : HOUSE_LABEL,
        card: groupBy === 'card' ? card : '',
        cardCount: 0,
        visits: 0,
        approved: 0,
        earnings: 0,
        affiliate: 0,
        approvalRate: 0,
      };
      rows.set(key, row);
    }
    const seen = cardsSeen.get(key) ?? new Set<string>();
    seen.add(card);
    cardsSeen.set(key, seen);
    row.cardCount = seen.size;
    return row;
  };

  for (const visit of visits) {
    if (!matchesPerson(visit.usr)) continue;
    const day = dayKey(visit.createdAt);
    if (!inWindow(day)) continue;
    rowFor(visit.usr, cardFor(cards, visit)).visits += 1;
  }

  for (const conversion of conversions) {
    if (!matchesPerson(conversion.usr)) continue;
    const day = conversion.approvedOn.slice(0, 10);
    if (!inWindow(day)) continue;
    // The card comes from the link the sale came through — the row itself only
    // stores (slug, usr). Renaming a campaign therefore renames its historic
    // earnings too, which is the trade for having one name in one place.
    const card = cardFor(cards, conversion);
    const row = rowFor(conversion.usr, card);
    row.approved += 1;
    row.earnings += conversion.amount;
    /*
     * Row by row, at that row's own rate. Adding the gross up and taking a
     * share of the total would be the same answer only while there has never
     * been more than one rate; the first time the percentage changes it starts
     * quietly repricing every approval banked before it.
     */
    row.affiliate += revenueFrom(conversion.amount, gross, shareOn(day, shares));
  }

  const list = [...rows.values()];
  for (const row of list) {
    row.approvalRate = safeRate(row.approved, row.visits);
    // Rounded once, at the end of the row, so the column and the total under it
    // are the same arithmetic rather than two accumulations of the same cents.
    row.affiliate = Math.round(row.affiliate * 100) / 100;
  }
  // Earnings first — the column the table is read for.
  list.sort(
    (a, b) =>
      b.earnings - a.earnings ||
      b.approved - a.approved ||
      b.visits - a.visits ||
      (groupBy === 'card' ? a.card.localeCompare(b.card) : a.person.localeCompare(b.person)),
  );

  const totals = list.reduce(
    (acc, row) => ({
      visits: acc.visits + row.visits,
      approved: acc.approved + row.approved,
      earnings: acc.earnings + row.earnings,
      affiliate: acc.affiliate + row.affiliate,
      approvalRate: 0,
    }),
    { visits: 0, approved: 0, earnings: 0, affiliate: 0, approvalRate: 0 },
  );
  totals.approvalRate = safeRate(totals.approved, totals.visits);
  totals.affiliate = Math.round(totals.affiliate * 100) / 100;

  // Everyone selectable, independent of the period — a filter whose options
  // vanish when you narrow the dates is worse than useless.
  const peopleKeys = new Set<string>();
  for (const link of links) peopleKeys.add(link.usr || HOUSE_KEY);
  for (const visit of visits) peopleKeys.add(visit.usr || HOUSE_KEY);
  for (const row of conversions) peopleKeys.add(row.usr || HOUSE_KEY);
  const people = [...peopleKeys]
    .map((key) => ({
      usr: key,
      name: key === HOUSE_KEY ? HOUSE_LABEL : names.get(key) ?? key,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows: list,
    totals,
    people,
    // The chart follows both filters. It used to follow only the person, which
    // left the picture sitting still while every figure around it moved — and a
    // chart that ignores the control directly above it reads as a broken chart.
    // A month is drawn among the months around it, the way the 30-day
    // window already is.
    series: buildEarningsSeries(visits, conversions, { period: month ? 'month' : period, usr }),
  };
}

/** "Jul 16" — UTC, to match every other date in the app. */
function shortDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Tue 16" — for a chart of single days, where the month repeats on every bar.
 *
 * Composed rather than asked for as one format, because a request for a weekday
 * and a day number comes back as "16 Tue" in some ICU builds and "Tue 16" in
 * others, and an axis label should not depend on which one the server has.
 */
function weekdayDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${date.getUTCDate()}`;
}

/** "Tue 16 Aug" — the same day spelled out for the table behind the chart. */
function longDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "Mar", or "Dec '25" once the chart reaches back into another year. */
function shortMonth(key: string, thisYear: number): string {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, 1));
  const name = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return year === thisYear ? name : `${name} '${String(year).slice(2)}`;
}

/** "March 2026" — the same month spelled out for the table behind the chart. */
function longMonth(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Whole days from one day key to another, counting both ends. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

/** About half a dozen bars: enough to be a shape, few enough to label. */
const TARGET_BUCKETS = 6;

/**
 * The bars around the selected window.
 *
 * Each filter is drawn one step coarser than it asks for: today in days, a week
 * in weeks, a month in months. So the chart is not a second copy of the figure
 * beside it — it is what that figure sits inside. Reading "3 visits today" is
 * one fact; seeing that yesterday was 12 and the day before was 16 is what
 * makes it mean something.
 *
 * That does mean the bars add up to more than the figure they sit next to, on
 * purpose, which is why every series carries a span that says how far back it
 * reaches.
 *
 * Visits are bucketed by the click and approvals by their approval date, the
 * same split the tables use, so a bar and a row can never disagree.
 */
export function buildEarningsSeries(
  visits: Visit[],
  conversions: Conversion[],
  { period = 'month', usr = '' }: { period?: Period; usr?: string } = {},
): EarningsSeries {
  const matchesPerson = (rowUsr: string) => !usr || (rowUsr || HOUSE_KEY) === usr;

  const visitsByDay = new Map<string, number>();
  const approvedByDay = new Map<string, number>();
  for (const visit of visits) {
    if (!matchesPerson(visit.usr)) continue;
    const key = dayKey(visit.createdAt);
    visitsByDay.set(key, (visitsByDay.get(key) ?? 0) + 1);
  }
  for (const row of conversions) {
    if (!matchesPerson(row.usr)) continue;
    const key = row.approvedOn.slice(0, 10);
    approvedByDay.set(key, (approvedByDay.get(key) ?? 0) + 1);
  }

  if (period === 'month') return monthSeries(visitsByDay, approvedByDay);

  const { size, count } = bucketPlan(period, visitsByDay, approvedByDay);

  const buckets: EarningsBucket[] = [];
  // Built from the newest backwards, so the last bar always ends today rather
  // than on whatever boundary the calendar happens to offer. That is what makes
  // "this week" mean the last seven days on a Monday as well as on a Friday.
  for (let index = count - 1; index >= 0; index -= 1) {
    const firstOffset = index * size + (size - 1);
    const lastOffset = index * size;
    const start = daysAgoKey(firstOffset);
    const end = daysAgoKey(lastOffset);
    let visitCount = 0;
    let approvedCount = 0;
    for (let day = firstOffset; day >= lastOffset; day -= 1) {
      const key = daysAgoKey(day);
      visitCount += visitsByDay.get(key) ?? 0;
      approvedCount += approvedByDay.get(key) ?? 0;
    }
    buckets.push({
      start,
      end,
      label: bucketLabel(size, index, start),
      range: size === 1 ? longDay(start) : `${shortDay(start)} to ${shortDay(end)}`,
      current: index === 0,
      visits: visitCount,
      approved: approvedCount,
    });
  }

  const title = size === 1 ? 'Day by day' : size === 7 ? 'Week by week' : `${size} days at a time`;
  const span =
    size === 1
      ? `last ${count} days`
      : size === 7
        ? `last ${count} weeks`
        : `last ${size * count} days`;

  return {
    buckets,
    title,
    span,
    caption: `Visits and approvals over the ${span}, ${
      size === 1 ? 'one bar per day' : size === 7 ? 'one bar per week' : `${size} days at a time`
    }.`,
  };
}

/** "Today", "This week", or the date the bar starts on. */
function bucketLabel(size: number, index: number, start: string): string {
  if (index === 0) return size === 1 ? 'Today' : size === 7 ? 'This week' : shortDay(start);
  return size === 1 ? weekdayDay(start) : shortDay(start);
}

/**
 * How wide each bar is and how many there are, for everything but months.
 *
 * Today is drawn in days and a week in weeks, both fixed, so that the two are
 * read against each other without a bar quietly changing meaning between them.
 * All time is the only one that has to be worked out, since the history behind
 * it is a day old in a new account and years old in an old one.
 */
function bucketPlan(
  period: Period,
  visitsByDay: Map<string, number>,
  approvedByDay: Map<string, number>,
): { size: number; count: number } {
  if (period === 'day') return { size: 1, count: 7 };
  if (period === 'week') return { size: 7, count: TARGET_BUCKETS };

  const days = [...visitsByDay.keys(), ...approvedByDay.keys()].sort();
  // Nothing recorded at all: six empty days, which says "nothing yet" more
  // honestly than one flat bar spanning an imaginary history.
  if (days.length === 0) return { size: 1, count: TARGET_BUCKETS };

  const historyDays = daysBetween(days[0]!, daysAgoKey(0));
  const size = Math.max(1, Math.ceil(historyDays / TARGET_BUCKETS));
  return { size, count: Math.min(TARGET_BUCKETS, Math.ceil(historyDays / size)) };
}

/**
 * Six calendar months, the last one being this one.
 *
 * Calendar months rather than blocks of thirty days: a month is the unit
 * everything else about this business is settled in, and "August" is a thing a
 * person can check against a statement in a way that "the 20th to the 18th"
 * never is. The current bar is therefore a part-month, and says so by being the
 * one labelled "This month".
 */
function monthSeries(
  visitsByDay: Map<string, number>,
  approvedByDay: Map<string, number>,
): EarningsSeries {
  const today = new Date(`${daysAgoKey(0)}T00:00:00Z`);
  const thisYear = today.getUTCFullYear();

  const visitsByMonth = new Map<string, number>();
  const approvedByMonth = new Map<string, number>();
  for (const [day, count] of visitsByDay) {
    const key = day.slice(0, 7);
    visitsByMonth.set(key, (visitsByMonth.get(key) ?? 0) + count);
  }
  for (const [day, count] of approvedByDay) {
    const key = day.slice(0, 7);
    approvedByMonth.set(key, (approvedByMonth.get(key) ?? 0) + count);
  }

  const buckets: EarningsBucket[] = [];
  for (let back = TARGET_BUCKETS - 1; back >= 0; back -= 1) {
    const first = new Date(Date.UTC(thisYear, today.getUTCMonth() - back, 1));
    // Day 0 of the next month is the last day of this one, which is the whole
    // reason to let Date do the counting rather than carrying a table of 31s
    // and a February rule.
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const key = first.toISOString().slice(0, 7);
    buckets.push({
      start: first.toISOString().slice(0, 10),
      end: last.toISOString().slice(0, 10),
      // The month's own name, even for the current one: "This month" is the
      // only label in any of these charts that does not fit its column, and a
      // truncated "This mo…" is worse than the word August. The bold says
      // which one we are in; the range says it is only part-run so far.
      label: shortMonth(key, thisYear),
      range: back === 0 ? `${longMonth(key)}, so far` : longMonth(key),
      current: back === 0,
      visits: visitsByMonth.get(key) ?? 0,
      approved: approvedByMonth.get(key) ?? 0,
    });
  }

  return {
    buckets,
    title: 'Month by month',
    span: `last ${TARGET_BUCKETS} months`,
    caption: `Visits and approvals over the last ${TARGET_BUCKETS} calendar months, one bar per month. The last is the month so far.`,
  };
}

/**
 * The affiliate's share of an approval before anybody sets one.
 *
 * Half, which is what this app paid for its whole life before the share became
 * a setting. It is the fallback, not the rule: what an approval is actually
 * worth is whatever rate was in force on the day it was approved, which is
 * `shareOn` in lib/settings. Everything here takes a rate and defaults to this
 * one, so a caller that has not been given the history still produces the
 * number the app has always produced.
 */
export const AFFILIATE_SHARE = DEFAULT_SHARE;

/**
 * The affiliate's revenue on one approval, rounded to the cent.
 *
 * Rounded here rather than at the point it is printed, so that a column of them
 * and the total under it are the same arithmetic. Halving the total instead
 * would be a cent out from the sum of the rows above it often enough to be
 * noticed, and the reader can only check the version that adds up.
 */
export function affiliateRevenueOf(amount: number, rate: number = DEFAULT_SHARE): number {
  return Math.round(amount * rate * 100) / 100;
}

/**
 * The affiliate's half of a figure that may already be it.
 *
 * Every payout reaches a screen as one of two things: the merchant's gross, or
 * the affiliate's share of it. Which one depends on who is reading — see
 * `loadAll`, where an affiliate's rows are halved before they ever leave the
 * server — and every place that prints the share has to know which it was
 * handed, or it halves a half.
 *
 * One function so that question is answered the same way everywhere. `gross`
 * is the answer to "is this the merchant's number?", not "may I see it".
 */
export function revenueFrom(
  earnings: number,
  gross: boolean,
  rate: number = DEFAULT_SHARE,
): number {
  return gross ? affiliateRevenueOf(earnings, rate) : earnings;
}

/** Whole-unit currency for dense table cells: 1250 → "$1,250". */
export function formatMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `$${rounded.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** "MS" from "Mark Salvador", "A" from "Arthur". Falls back to a question mark. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Compact age for dense rows ("4 min ago"). Falls back to the absolute UTC
 * timestamp once something is older than a week, where "8 days ago" stops
 * being more useful than the date.
 */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDateTime(iso);
}

/**
 * "13 Aug 2026" from a YYYY-MM-DD day key. An approval date is read, not
 * sorted, so it is spelled out rather than left as an ISO string.
 */
export function formatDay(key: string): string {
  const date = new Date(`${key.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // UTC to match the day buckets and the "Since 00:00 UTC" label — rendering
  // this one field in server-local time made rows look like they landed on a
  // different day from the one they were counted in.
  return `${date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}
