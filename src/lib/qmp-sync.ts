/**
 * Turning a QMP report into Ledger approvals.
 *
 * The shapes do not line up, and pretending they do is how money goes wrong.
 * A QMP row is a daily aggregate:
 *
 *   Date-Daily, Placement Name, Advertiser, Card Name, Device Type, Var2,
 *   Var3, Sub ID, Referring Session URL, State  +  Approvals, Total Earnings
 *
 * so one row can say "3 approvals, $412.50" for a card on a day. A Ledger
 * conversion is one approved application with one amount. Three decisions
 * follow, and all three are deliberate:
 *
 *  1. A row with N approvals becomes N conversions, not one. The dashboard
 *     counts conversions to show "approved", so collapsing a row to a single
 *     conversion would report 1 approval where QMP reports 3.
 *
 *  2. The earnings are split evenly across those N, in whole cents, with the
 *     remainder handed out one cent at a time so the total is exact. QMP does
 *     not say what each individual approval paid, so the split is an average
 *     and is labelled as one. The sum is what is true.
 *
 *  3. Var2 is the join back to a person. It is matched to a link's `usr`.
 *     Nothing is guessed: a var2 with no link, or with several links and no way
 *     to tell them apart, is reported as unresolved rather than attributed to
 *     somebody.
 *
 *     This used to read Sub ID, and Sub ID turned out to carry QuinStreet's own
 *     widget identifier ("JavaScriptTransition_JSWidget") on every row of the
 *     live report, which is nobody's key. Var2 is where the tracking key
 *     actually travels: it is written into each link's destination URL as
 *     `var2=<usr>`, so QMP hands it straight back on the report.
 *
 *  4. Var3 carries the lead reference, minted before the visitor was forwarded
 *     (see lib/lead-id.ts). It is kept on the conversion so an approval can be
 *     traced to the exact person who filled the form, weeks later. It is a
 *     label, never a join key for attribution — the money follows var2.
 *
 * Re-running is safe. Every conversion carries a marker in its notes derived
 * from the row's dimensions, and anything already carrying that marker is left
 * alone. The notes also keep the card name, which an approval has no column
 * for; it is read back out of them onto the lead (see cardFromNotes).
 *
 * Applications move leads, never money. A row with an application and no
 * approval writes nothing here, but the lead its var3 names is marked applied,
 * with the card, and an approval moves it on to approved. Nothing moves a lead
 * backwards. See leadUpdates.
 */

import { isLeadId } from './lead-id';
import { statusRank } from './status';
import { StoreConfigError } from './store/errors';
import type { AffiliateLink, Conversion, LeadStatus, NewConversion } from './types';

/** Strip case, spaces and punctuation so "Total Earnings($)" meets "totalearnings". */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * QMP's JSON field names are not documented, and the UI labels are not
 * necessarily what comes back. Each field is therefore looked up by a list of
 * normalized aliases rather than one exact name.
 */
const FIELDS = {
  date: ['datedaily', 'date', 'day', 'processdate', 'reportdate'],
  // `source_name` is what the live API calls the column the UI labels
  // "Placement Name". The UI labels and the JSON names do not match, which is
  // the whole reason these are lists.
  placement: ['sourcename', 'placementname', 'placement'],
  advertiser: ['advertiser', 'advertisername'],
  card: ['cardname', 'card', 'productname', 'product'],
  device: ['devicetype', 'device'],
  var2: ['var2'],
  var3: ['var3'],
  subId: ['subid', 'sub', 'subid1', 'sub1'],
  referrer: ['sessionrefurl', 'referringsessionurl', 'referringurl', 'referrer'],
  state: ['state'],
  approvals: ['approvals', 'approval', 'approvedapplications'],
  earnings: ['totalearnings', 'earnings', 'revenue', 'totalrevenue', 'payout'],
  clicks: ['clicks', 'click'],
  applications: ['applications', 'apps', 'application'],
} as const;

type FieldName = keyof typeof FIELDS;

/**
 * The most approvals a single report row is allowed to mean.
 *
 * Deliberately generous: a genuinely busy day on one card should still sync
 * without a complaint. This is a guard against a column being read as
 * "approvals" when it is really an id, a restatement or a currency figure —
 * the count drives both a loop and an array allocation, so a mis-mapped column
 * is the difference between a wrong number and a dead process.
 */
const MAX_APPROVALS_PER_ROW = 1_000;

/** Which dimensions identify a row. Measures are excluded: they are the payload. */
const DIMENSIONS: FieldName[] = [
  'date', 'placement', 'advertiser', 'card', 'device', 'var2', 'var3', 'subId', 'referrer', 'state',
];

export function readField(row: Record<string, unknown>, field: FieldName): unknown {
  const wanted = FIELDS[field] as readonly string[];
  for (const key of Object.keys(row)) {
    if (wanted.includes(normalizeKey(key))) return row[key];
  }
  return undefined;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** "1,234" / "$1,234.50" / 1234.5 / "(12.30)" as a negative. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = asText(value);
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()]/g, '').replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

/** Whatever QMP calls a day, as YYYY-MM-DD. Returns '' if it is not a date. */
export function parseDate(value: unknown): string {
  const text = asText(value);
  if (!text) return '';

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // 08/13/2026 and 08-13-2026. Month first: QMP is a US platform and its own
  // UI renders 08/13/2026 for the 13th of August.
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (slash) {
    const month = slash[1]!.padStart(2, '0');
    const day = slash[2]!.padStart(2, '0');
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return `${slash[3]}-${month}-${day}`;
    }
  }

  // "13 Aug 2026" / "Aug 13, 2026"
  const parsed = Date.parse(`${text} UTC`);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return '';
}

/** FNV-1a, base36. Short, stable, and no crypto import for a non-secret. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

/**
 * Identity of a QMP row, over every dimension it carries.
 *
 * Sorted by field name so reordering columns in QMP does not change it. It
 * does change if a dimension is added or removed, which would make previously
 * imported rows look new. That is a deliberate trade: the alternative is
 * hashing a subset, which silently merges two rows that differ only in a
 * dimension left out of the hash, and drops one of them.
 */
export function rowIdentity(row: Record<string, unknown>, reportKey: string): string {
  const parts = [`report=${reportKey}`];
  for (const field of [...DIMENSIONS].sort()) {
    parts.push(`${field}=${asText(readField(row, field))}`);
  }
  return shortHash(parts.join('|'));
}

/** `qmp:ab12cd3#2/3` — the marker a re-run looks for. */
export function markerFor(identity: string, index: number, count: number): string {
  return `qmp:${identity}#${index + 1}/${count}`;
}

const MARKER_PATTERN = /qmp:([a-z0-9]+)#(\d+)\/(\d+)/i;

export function markerIn(notes: string): string | null {
  const match = MARKER_PATTERN.exec(notes ?? '');
  return match ? `qmp:${match[1]}#${match[2]}/${match[3]}` : null;
}

/**
 * The lead reference, carried in the notes beside the marker.
 *
 * Notes rather than a column of its own, for the same reason the card is there:
 * the conversions table is also a Google Sheet with a fixed set of headers, and
 * a column added to one adapter is a column missing from the other. The tag is
 * machine-readable and stripped back out before any of it is shown.
 */
export function leadTag(ref: string): string {
  return `lead:${ref}`;
}

const LEAD_PATTERN = /\blead:([a-z0-9]+)/i;

export function leadRefIn(notes: string): string {
  const match = LEAD_PATTERN.exec(notes ?? '');
  return match ? match[1]! : '';
}

/**
 * `manual:k3m9x2q7hz04` — the marker on an approval an admin recorded with
 * Approve on the leads list, in the place a synced one carries its qmp marker.
 *
 * It is what lets the sync find that approval again when QMP reports the real
 * one, and swap it out (see planManualSwaps). An approval typed in through
 * Record an approval carries no marker, names no lead, and is never swapped.
 */
export function manualMarker(id: string): string {
  return `manual:${id}`;
}

const MANUAL_PATTERN = /\bmanual:([a-z0-9]+)/i;

export function isManualApproval(notes: string): boolean {
  return MANUAL_PATTERN.test(notes ?? '');
}

/**
 * The leads the approvals name.
 *
 * The reference is the submission's own id: the capture form puts it in var3,
 * the merchant carries it through, and the report hands it back, which is how
 * an approval knows whose it is. An approval typed in by hand carries no
 * reference and names nobody, so it is not in here.
 */
export function approvedLeadIds(conversions: { notes: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const conversion of conversions) {
    const ref = leadRefIn(conversion.notes ?? '');
    if (ref) ids.add(ref);
  }
  return ids;
}

/**
 * The leads an approval proves have signed up.
 *
 * A lead starts pending and is marked registered by hand once somebody has
 * confirmed they signed up. An approval is that confirmation, and a stronger
 * one: the merchant has agreed to pay for this person. So a lead sitting at
 * pending under an approval is not a state anybody chose, it is one nothing
 * ever got round to updating.
 *
 * Every approval is considered, not only the ones a run has just written. That
 * is deliberate and it is what makes this fix the backlog: a second sync skips
 * rows it imported the first time, so if this only looked at new approvals, the
 * leads behind everything already imported would stay pending forever.
 *
 * Already-registered leads are left alone rather than rewritten — there is
 * nothing to change, and a write per row would cost a call to the spreadsheet
 * for every lead on every sync.
 *
 * The sync itself now asks leadUpdates below, which makes this same move and
 * the applied one before it. This stays as the narrower question, and the two
 * are checked against each other.
 */
export function leadsToRegister(
  conversions: { notes: string }[],
  submissions: { id: string; status: string }[],
): string[] {
  const approved = approvedLeadIds(conversions);
  return submissions
    .filter((row) => row.status !== 'registered' && approved.has(row.id))
    .map((row) => row.id);
}

/**
 * A lead reference as it stands, or '' when it is the placeholder the report
 * puts where there is none.
 *
 * The live report writes the word "Unknown" into var3 (and into var2, and the
 * session URL) on widget traffic that never came through a form here. That is
 * not a reference to anybody, so it reads as no lead rather than as a lead
 * nobody can find.
 */
function namedLead(ref: string): string {
  const trimmed = (ref ?? '').trim();
  return trimmed.toLowerCase() === 'unknown' ? '' : trimmed;
}

/** Note a lead in a reference → cards map, adding its card once when it has one. */
function noteCard(byLead: Map<string, string[]>, ref: string, card: string): void {
  const cards = byLead.get(ref) ?? [];
  if (card && !cards.includes(card)) cards.push(card);
  byLead.set(ref, cards);
}

/**
 * The leads the report shows applying, and the cards each applied for.
 *
 * A row counts when it carries an application or an approval. QMP counts the
 * two in separate columns, and an approved application was still an
 * application, so a row with an approval and a blank Applications cell names
 * its lead all the same. Which of the two a lead has got to is decided by
 * leadUpdates; this only says who applied, and for what.
 *
 * Keyed by var3 as the report wrote it, the same way approvals are matched to
 * leads, so the two cannot disagree about who a reference is. A lead whose rows
 * carry no card name is still in here, with no cards: that it applied is the
 * fact, and the card is a detail on top of it.
 *
 * Only a var3 shaped like a reference Ledger mints (lib/lead-id.ts) names a
 * lead. The report's "Unknown" on widget traffic is not one, and neither is
 * the id of a lead captured before references existed, which never travelled
 * in a var3 at all, so no row can honestly name it.
 *
 * What this cannot do is prove a reference honest. var3 rides in the URL the
 * visitor follows to the merchant, and a visitor can edit that URL, so
 * somebody holding another lead's reference could apply with it and mark that
 * lead applied, with the card they applied for. It is the trust approvals
 * already put in var3, bounded the same way: a reference is 12 random
 * characters that only the lead, an admin and the lead's own affiliate ever
 * see; each forgery costs a real application at the merchant; the card is
 * QuinStreet's name for a real product; and nothing here moves money, which
 * follows var2 through planSync. Checking var2 against the lead's owner would
 * not close it, because var2 rides in the same editable URL.
 */
export function applicationsByLead(rows: Record<string, unknown>[]): Map<string, string[]> {
  const byLead = new Map<string, string[]>();
  for (const row of rows) {
    const applications = parseNumber(readField(row, 'applications')) ?? 0;
    const approvals = parseNumber(readField(row, 'approvals')) ?? 0;
    if (applications < 1 && approvals < 1) continue;

    const ref = leadRefOf(row);
    if (!isLeadId(ref)) continue;
    noteCard(byLead, ref, asText(readField(row, 'card')));
  }
  return byLead;
}

/** How planSync separates the card, the marker and the lead tag in a note. */
const NOTE_SEPARATOR = /\s*·\s*/;

/**
 * The card an approval was for, read off the notes the sync wrote on it.
 *
 * planSync writes the card first, then the marker, then the lead tag, so on a
 * synced approval the card is whatever stands before the first separator. Only
 * on a synced one: the marker is the proof the sync wrote the notes, and
 * without it the first words are whatever somebody typed. A synced approval
 * with no card starts with its marker, and gives nothing back.
 *
 * An approval recorded with Approve is written in the same shape with its own
 * marker, from a card picked off the rate card, so it reads back the same way.
 */
export function cardFromNotes(notes: string): string {
  const text = notes ?? '';
  if (!markerIn(text) && !isManualApproval(text)) return '';
  const first = (text.split(NOTE_SEPARATOR)[0] ?? '').trim();
  if (MARKER_PATTERN.test(first) || MANUAL_PATTERN.test(first) || LEAD_PATTERN.test(first)) return '';
  return first;
}

/**
 * Lead reference → the cards its approvals were for.
 *
 * Every approval on file, the same set approvedLeadIds reads, so a lead that
 * was approved before leads kept a card still has one to show. An approval
 * typed in by hand names no lead, so it adds nobody.
 */
export function approvedCards(conversions: { notes: string }[]): Map<string, string[]> {
  const byLead = new Map<string, string[]>();
  for (const conversion of conversions) {
    const ref = namedLead(leadRefIn(conversion.notes ?? ''));
    if (!ref) continue;
    noteCard(byLead, ref, cardFromNotes(conversion.notes ?? ''));
  }
  return byLead;
}

/**
 * How much card text one lead carries: five names and 200 characters.
 *
 * The card on a lead only grows. Every sync merges what it sees into what is
 * there and nothing takes a name back out, so without a ceiling a lead could
 * keep collecting names for as long as syncs run, and one column mis-read as
 * the card could put a paragraph in it. It is read in a table column on the
 * leads list and sits in one spreadsheet cell. Five is past what a real person
 * applies for through one link. A name that would take the text past 200 is
 * left out rather than cut short: half a card name is a card nobody offers.
 */
const MAX_CARDS_PER_LEAD = 5;
const MAX_CARD_TEXT = 200;

/** How the cards on a lead are joined into one field, and split back apart. */
const CARD_SEPARATOR = ', ';

/**
 * The cards on record with the ones just seen added after them.
 *
 * A name is added only when it is not there already, compared exactly as QMP
 * spells it once the spaces are trimmed. When nothing is added the record
 * comes back exactly as it was, spacing and all, not re-joined: the sync
 * compares the result with what is stored to decide whether there is anything
 * to write, and tidying a cell is not a reason to write it on every sync.
 */
export function mergeCards(existing: string, incoming: string[]): string {
  const record = existing ?? '';
  const names = record
    .split(CARD_SEPARATOR)
    .map((name) => name.trim())
    .filter(Boolean);
  const kept = [...names];
  for (const raw of incoming) {
    const name = (raw ?? '').trim();
    if (!name) continue;
    // Looked for as a run of whole names rather than as one of them, so a card
    // whose own name has a comma in it, which the split above cuts in two, is
    // still found instead of being added again on every sync.
    const joined = kept.join(CARD_SEPARATOR);
    if (`${CARD_SEPARATOR}${joined}${CARD_SEPARATOR}`.includes(`${CARD_SEPARATOR}${name}${CARD_SEPARATOR}`)) {
      continue;
    }
    if (kept.length >= MAX_CARDS_PER_LEAD) break;
    const length = kept.length === 0 ? name.length : joined.length + CARD_SEPARATOR.length + name.length;
    if (length > MAX_CARD_TEXT) continue;
    kept.push(name);
  }
  return kept.length === names.length ? record : kept.join(CARD_SEPARATOR);
}

/**
 * The card a lead shows on the leads list.
 *
 * Its own, when it has one. A lead approved before leads kept a card has none
 * on record, and its card survives only on the notes of its approvals, so for
 * that lead it is read from there. Merged the way the sync merges, so the cell
 * shows what a sync would record from the same approvals, capped the same way,
 * rather than a second spelling of it that changes when the sync catches up.
 */
export function cardForLead(
  lead: { id: string; card: string },
  cardsApproved: Map<string, string[]>,
): string {
  if ((lead.card ?? '').trim() !== '') return lead.card;
  return mergeCards('', cardsApproved.get(lead.id) ?? []);
}

/** What an update does: move a lead to approved, move it to applied, or only add a card. */
export type LeadUpdateKind = 'registered' | 'applied' | 'card';

/** What a sync writes to one lead. */
export type LeadUpdate = {
  id: string;
  /** The status on record before this sync. */
  from: LeadStatus;
  /** The status after it. Never behind `from`. */
  status: LeadStatus;
  /** The cards after it: the ones on record with any new ones added. */
  card: string;
};

/**
 * What a sync should write to each lead, for the leads it changes and no others.
 *
 * The evidence, strongest first: an approval that names the lead takes it to
 * approved; failing that, an application on the report takes it to applied.
 * Every approval on file counts, not only the ones this run writes, for the
 * reason given on leadsToRegister: a second sync skips what it imported, so the
 * backlog is only reachable from the whole set.
 *
 * Forward only, by statusRank. A report shows an application on the day it was
 * made and the approval on another, and an approval may be on file by hand with
 * no application in the range at all; neither is the merchant taking an
 * approval back. So a lead approved by hand stays approved while its card is
 * still recorded, and a sync never moves anybody backwards. The toggle on the
 * leads list is how a person does that.
 *
 * One entry per lead, however many rows and approvals name it, and none for a
 * lead whose status and card would come out as they went in: each entry is a
 * write to the store, which on the Sheets adapter is a call to the spreadsheet.
 */
export function leadUpdates(options: {
  conversions: { notes: string }[];
  applications: Map<string, string[]>;
  submissions: { id: string; status: LeadStatus; card: string }[];
}): LeadUpdate[] {
  const { conversions, applications, submissions } = options;
  const approved = approvedLeadIds(conversions);
  const cardsApproved = approvedCards(conversions);

  const updates: LeadUpdate[] = [];
  const seen = new Set<string>();
  for (const row of submissions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const target: LeadStatus = approved.has(row.id)
      ? 'registered'
      : applications.has(row.id)
        ? 'applied'
        : row.status;
    const status = statusRank(target) > statusRank(row.status) ? target : row.status;

    const stored = row.card ?? '';
    const card = mergeCards(stored, [
      ...(applications.get(row.id) ?? []),
      ...(cardsApproved.get(row.id) ?? []),
    ]);

    if (status !== row.status || card !== stored) {
      updates.push({ id: row.id, from: row.status, status, card });
    }
  }
  return updates;
}

/**
 * Which of the three an update is, for counting them. A move carries its card
 * as well and is counted as the move; only a status that stands is a card.
 */
export function leadUpdateKind(update: LeadUpdate): LeadUpdateKind {
  if (update.status === update.from) return 'card';
  return update.status === 'registered' ? 'registered' : 'applied';
}

/** What writing a sync's lead updates came to. */
export type LeadWriteResult = {
  /** The updates that landed, by kind. */
  written: Record<LeadUpdateKind, number>;
  /** One line per lead that could not be written, or one for all that were left when the store is not set up. */
  failures: string[];
};

/**
 * Write a sync's lead updates one at a time, and count what landed.
 *
 * One at a time, like the approvals before them: on the Sheets adapter every
 * write finds its row by reading the tab, and writes in flight together would
 * race for it. A lead that fails is noted and the rest are still tried. A row
 * that moved in the sheet, or a lead deleted since the report was read, says
 * nothing about the others.
 *
 * A store that is not set up for the write is different. A missing column, a
 * missing table or the wrong key fails every lead the same way, so it is said
 * once, with how many were left and the fix, and the rest are not tried. The
 * case that matters is a database whose migrations are behind the code:
 * without this, every sync would list the same database error once per lead.
 */
export async function writeLeadUpdates(
  updates: LeadUpdate[],
  write: (update: LeadUpdate) => Promise<unknown>,
): Promise<LeadWriteResult> {
  const written: Record<LeadUpdateKind, number> = { registered: 0, applied: 0, card: 0 };
  const failures: string[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index]!;
    try {
      await write(update);
      written[leadUpdateKind(update)] += 1;
    } catch (error) {
      if (error instanceof StoreConfigError) {
        const left = updates.length - index;
        failures.push(`${left} lead update${left === 1 ? ' was' : 's were'} not written: ${error.message}`);
        break;
      }
      failures.push(`lead ${update.id}: ${error instanceof Error ? error.message : 'could not be updated'}`);
    }
  }
  return { written, failures };
}

/**
 * The notes with the machine tags taken out, for showing to a person.
 *
 * `qmp:ab12cd3#1/3 · lead:rc7czk6xa61y` is bookkeeping. It has to be on the row
 * — it is what makes a re-run safe and what ties an approval to the lead behind
 * it — but putting it in front of somebody reading their earnings is noise.
 */
export function visibleNotes(notes: string): string {
  return (notes ?? '')
    .replace(MARKER_PATTERN, '')
    .replace(MANUAL_PATTERN, '')
    .replace(LEAD_PATTERN, '')
    // Separators left stranded by the removals: a trailing one, a leading one,
    // or two that have collapsed together.
    .replace(/·\s*(?=·)/g, '')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export type ParsedMarker = { identity: string; index: number; count: number };

export function parseMarker(notes: string): ParsedMarker | null {
  const match = MARKER_PATTERN.exec(notes ?? '');
  if (!match) return null;
  return { identity: match[1]!, index: Number(match[2]), count: Number(match[3]) };
}

/**
 * Split a total into `count` whole-cent amounts that add back up to it.
 * The remainder goes one cent at a time to the earliest amounts.
 */
export function splitAmount(total: number, count: number): number[] {
  if (count <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, index) => (index < remainder ? base + 1 : base) / 100);
}

export type PlannedConversion = NewConversion & {
  marker: string;
  card: string;
  /**
   * var2 exactly as the report wrote it, which is not always `usr`: `usr` is
   * the matched link's own key, the same thing in different letters most of the
   * time and nothing like it when QMP_DEFAULT_SLUG placed a row that carried no
   * key at all. Kept so a plan can show what it read as well as what it decided.
   */
  trackingKey: string;
  /** var3, the lead this approval came from. Empty when the row carries none. */
  leadRef: string;
};

export type SyncIssue = {
  kind:
    | 'no-link'
    | 'ambiguous-link'
    | 'no-date'
    | 'negative-earnings'
    | 'no-approvals-column'
    | 'restated'
    | 'implausible-count';
  detail: string;
  /** How many QMP rows hit this. */
  rows: number;
  /** Approvals sitting behind the issue, so the cost of ignoring it is visible. */
  approvals: number;
};

export type SyncPlan = {
  create: PlannedConversion[];
  /** Already imported on an earlier run. */
  skipped: number;
  issues: SyncIssue[];
  /** Rows that carried at least one approval. */
  rowsWithApprovals: number;
  totalApprovals: number;
  totalEarnings: number;
  /** True when the report has no Approvals column at all. */
  unusable: boolean;
};

/** The tracking key a row carries: var2, as written into the link's destination. */
export function trackingKeyOf(row: Record<string, unknown>): string {
  return asText(readField(row, 'var2'));
}

/** The lead reference a row carries: var3, appended when the form was filled in. */
export function leadRefOf(row: Record<string, unknown>): string {
  return asText(readField(row, 'var3'));
}

function linkFor(
  trackingKey: string,
  row: Record<string, unknown>,
  links: AffiliateLink[],
  defaultSlug: string,
): { link: AffiliateLink } | { error: SyncIssue['kind']; detail: string } {
  const wanted = trackingKey.trim().toLowerCase();
  const matches = links.filter((link) => link.usr.trim().toLowerCase() === wanted);

  if (matches.length === 1) return { link: matches[0]! };
  if (matches.length === 0) {
    // Not every row comes back with a key in it. QMP_DEFAULT_SLUG names one
    // link to put those on; it is off unless set, because guessing an owner is
    // worse than saying nothing.
    if (defaultSlug) {
      const fallback = links.find((link) => link.slug === defaultSlug);
      if (fallback) return { link: fallback };
      return {
        error: 'no-link',
        detail: `QMP_DEFAULT_SLUG is set to "${defaultSlug}" but no link has that slug.`,
      };
    }
    return {
      error: 'no-link',
      detail: wanted
        ? `var2 "${trackingKey}" matches no link. Create one with usr=${trackingKey}, or correct the var2 in that link's destination URL.`
        : 'Rows with an empty var2 carry no tracking key. Add var2=<usr> to the destination URL of the link they came through.',
    };
  }

  // Several links share the tracking key. The card or placement may tell them
  // apart through the link's campaign; if not, say so rather than pick one.
  const card = asText(readField(row, 'card')).toLowerCase();
  const placement = asText(readField(row, 'placement')).toLowerCase();
  const byCampaign = matches.filter((link) => {
    const campaign = link.campaign.trim().toLowerCase();
    if (!campaign) return false;
    return card.includes(campaign) || campaign.includes(card) || placement.includes(campaign);
  });
  if (byCampaign.length === 1) return { link: byCampaign[0]! };

  return {
    error: 'ambiguous-link',
    detail: `var2 "${trackingKey}" matches ${matches.length} links (${matches
      .map((link) => link.slug)
      .join(', ')}) and the card name does not single one out.`,
  };
}

export function planSync(options: {
  rows: Record<string, unknown>[];
  reportKey: string;
  links: AffiliateLink[];
  existing: Conversion[];
  /** Where to put approvals whose Sub ID matches no link. Off when empty. */
  defaultSlug?: string;
}): SyncPlan {
  const { rows, reportKey, links, existing, defaultSlug = '' } = options;

  const alreadyImported = new Set<string>();
  // What each already-imported row was worth last time, so a restatement is
  // caught instead of being written a second time alongside the first.
  const importedCount = new Map<string, number>();
  for (const conversion of existing) {
    const parsed = parseMarker(conversion.notes ?? '');
    if (!parsed) continue;
    alreadyImported.add(markerFor(parsed.identity, parsed.index - 1, parsed.count));
    importedCount.set(parsed.identity, parsed.count);
  }

  const create: PlannedConversion[] = [];
  const issueMap = new Map<string, SyncIssue>();
  const addIssue = (kind: SyncIssue['kind'], detail: string, approvals: number) => {
    const key = `${kind}|${detail}`;
    const found = issueMap.get(key);
    if (found) {
      found.rows += 1;
      found.approvals += approvals;
    } else {
      issueMap.set(key, { kind, detail, rows: 1, approvals });
    }
  };

  let skipped = 0;
  let rowsWithApprovals = 0;
  let totalApprovals = 0;
  let totalEarnings = 0;

  // A report with no Approvals column cannot be synced at all; say that once
  // rather than reporting every row as a problem.
  const hasApprovals = rows.some((row) => readField(row, 'approvals') !== undefined);
  if (rows.length > 0 && !hasApprovals) {
    return {
      create: [],
      skipped: 0,
      issues: [
        {
          kind: 'no-approvals-column',
          detail: 'This report has no Approvals column. Add Approvals and Total Earnings to it in QMP.',
          rows: rows.length,
          approvals: 0,
        },
      ],
      rowsWithApprovals: 0,
      totalApprovals: 0,
      totalEarnings: 0,
      unusable: true,
    };
  }

  // Rows that share an identity (same dimensions) get an occurrence suffix so
  // the second one cannot be mistaken for a repeat of the first.
  const seenIdentities = new Map<string, number>();

  for (const row of rows) {
    const approvals = Math.trunc(parseNumber(readField(row, 'approvals')) ?? 0);
    if (approvals <= 0) continue;

    // A row's approval count is the loop bound below, and columns are matched
    // by fuzzy alias — so a renamed column, a restatement, or an account id
    // that happens to normalise to "approvals" would be expanded into that many
    // conversion rows. At best that is a wildly wrong money record; at a large
    // enough value it is an allocation that takes the process down before
    // anyone sees the plan. Anything past a plausible day's work is reported
    // rather than expanded.
    if (approvals > MAX_APPROVALS_PER_ROW) {
      addIssue(
        'implausible-count',
        `A row claims ${approvals.toLocaleString()} approvals, which is past the ${MAX_APPROVALS_PER_ROW.toLocaleString()} a single row is allowed to mean. Check the report's columns before syncing it.`,
        0,
      );
      continue;
    }

    rowsWithApprovals += 1;
    totalApprovals += approvals;

    const earnings = parseNumber(readField(row, 'earnings')) ?? 0;
    totalEarnings += earnings;

    const approvedOn = parseDate(readField(row, 'date'));
    if (!approvedOn) {
      addIssue('no-date', `A row has no readable date (${asText(readField(row, 'date')) || 'empty'}).`, approvals);
      continue;
    }

    if (earnings < 0) {
      // A clawback. Ledger has no negative approval, and inventing one would
      // corrupt the count as well as the total.
      addIssue(
        'negative-earnings',
        `${approvedOn} has negative earnings (${earnings}), which looks like a reversal. Adjust it by hand.`,
        approvals,
      );
      continue;
    }

    const trackingKey = trackingKeyOf(row);
    const resolved = linkFor(trackingKey, row, links, defaultSlug);
    if ('error' in resolved) {
      addIssue(resolved.error, resolved.detail, approvals);
      continue;
    }

    const baseIdentity = rowIdentity(row, reportKey);
    const occurrence = seenIdentities.get(baseIdentity) ?? 0;
    seenIdentities.set(baseIdentity, occurrence + 1);
    const identity = occurrence === 0 ? baseIdentity : `${baseIdentity}${occurrence}`;

    const card = asText(readField(row, 'card'));
    const leadRef = leadRefOf(row);

    // QMP restates: a day's approvals can go up (or down) after the fact. The
    // markers of an already-imported row all carry the count it had then, so
    // a changed count would match none of them and the row would be written a
    // second time on top of the first. Refuse, and say what to do.
    const previousCount = importedCount.get(identity);
    if (previousCount !== undefined && previousCount !== approvals) {
      addIssue(
        'restated',
        `${approvedOn}${card ? ` ${card}` : ''} was imported with ${previousCount} approval${
          previousCount === 1 ? '' : 's'
        } and QMP now says ${approvals}. Remove the ${previousCount} old row${
          previousCount === 1 ? '' : 's'
        } from Approvals, then sync again.`,
        approvals,
      );
      continue;
    }

    const amounts = splitAmount(earnings, approvals);

    for (let index = 0; index < approvals; index += 1) {
      const marker = markerFor(identity, index, approvals);
      if (alreadyImported.has(marker)) {
        skipped += 1;
        continue;
      }
      create.push({
        slug: resolved.link.slug,
        usr: resolved.link.usr,
        trackingKey,
        approvedOn,
        amount: amounts[index]!,
        // Card first: it is the useful half for anyone reading the sheet, and
        // Ledger stores the card nowhere else. The lead tag rides along at the
        // end so an approval can be traced back to the person who filled the
        // form; visibleNotes takes both tags out again for display.
        notes: [card, marker, leadRef ? leadTag(leadRef) : ''].filter(Boolean).join(' · '),
        marker,
        card,
        leadRef,
      });
    }
  }

  return {
    create,
    skipped,
    issues: [...issueMap.values()].sort((a, b) => b.approvals - a.approvals),
    rowsWithApprovals,
    totalApprovals,
    totalEarnings,
    unusable: false,
  };
}

/** A QMP approval about to be written, and the manual approval it meets. */
export type ManualSwap = { marker: string; manualId: string };

/**
 * What the sync does with approvals an admin recorded by hand with Approve.
 *
 * When QMP reports the approval for a lead that already has a manual one, the
 * two are the same approval. QMP's is the record: it carries what the merchant
 * actually paid. So it `replace`s the manual one, which is deleted as QMP's is
 * written, and the approval is counted once at the real amount.
 *
 * Unless the manual approval is on a live payout request. Then it has been
 * asked for, or paid, at the amount it carries, and deleting it is refused
 * anyway. It is `kept`, and the QMP approval is left unwritten rather than
 * written beside it, which would pay the lead twice. Nothing marks QMP's as
 * imported, so every later sync reaches the same answer.
 *
 * Matched on the lead reference, which only a row that carries var3 has.
 * Among a lead's manual approvals the one for the same card goes first, as QMP
 * spells it give or take case and spacing, then any: a card mis-picked by hand
 * is still that lead's approval. Each manual approval meets one QMP approval
 * at most, so a lead QMP approved twice over one hand-recorded approval gets
 * the second written as new.
 */
export function planManualSwaps(options: {
  create: PlannedConversion[];
  existing: Conversion[];
  /** Conversion ids on a live payout request. */
  committed: ReadonlySet<string>;
}): { replace: ManualSwap[]; kept: ManualSwap[] } {
  const { create, existing, committed } = options;
  const sameCard = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const byLead = new Map<string, Conversion[]>();
  for (const conversion of existing) {
    if (!isManualApproval(conversion.notes)) continue;
    const ref = leadRefIn(conversion.notes);
    if (!ref) continue;
    byLead.set(ref, [...(byLead.get(ref) ?? []), conversion]);
  }

  const replace: ManualSwap[] = [];
  const kept: ManualSwap[] = [];
  for (const row of create) {
    const candidates = row.leadRef ? byLead.get(row.leadRef) : undefined;
    if (!candidates || candidates.length === 0) continue;
    const match =
      candidates.find((conversion) => sameCard(cardFromNotes(conversion.notes), row.card)) ?? candidates[0]!;
    byLead.set(
      row.leadRef,
      candidates.filter((conversion) => conversion !== match),
    );
    const swap = { marker: row.marker, manualId: match.id };
    (committed.has(match.id) ? kept : replace).push(swap);
  }
  return { replace, kept };
}
