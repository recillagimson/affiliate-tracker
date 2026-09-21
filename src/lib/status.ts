import type { LeadStatus } from './types';

/**
 * Where a lead is in the funnel, in order.
 *
 * `pending` is stamped automatically the first time someone submits the form —
 * nobody has to set it. `applied` is the step after: the merchant's report shows
 * an application from this lead and no approval yet, and the report sync writes
 * it. The last state is approved. It is set by hand, either from the dashboard
 * or by editing the Status column in the spreadsheet, written by the sync when
 * an approval names the lead, and also read off the approvals: see
 * `displayStatus` below.
 *
 * The stored word for approved is `registered`, which is what every row already
 * written and every cell already typed says. On screen it reads "Approved",
 * which is what the team calls it. Renaming the value as well would mean
 * rewriting history in a database and a spreadsheet to change a caption, so the
 * two meet in exactly one place — `statusLabel` — and nowhere else. `applied`
 * goes through the same place, so its caption can change the same way.
 */
export const LEAD_STATUSES = ['pending', 'applied', 'registered'] as const;

export const DEFAULT_LEAD_STATUS: LeadStatus = 'pending';

/**
 * Values a human might type into the Status column that plainly mean the lead
 * is through. Matched whole, after trimming and lowercasing — a partial match
 * would read "registration pending" as registered, which is the exact opposite
 * of what it says, and "not approved" as approved.
 *
 * Both vocabularies are here on purpose. The column has been filled in by hand
 * for months with "registered", and the screen now says "Approved", so somebody
 * typing what they read has to land in the same place as somebody typing what
 * they have always typed.
 */
const REGISTERED_SPELLINGS = new Set([
  'registered',
  'approved',
  'approve',
  'approval',
  'aprobado',
  'aprobada',
  'register',
  'registration',
  'registrado',
  'registro',
  'signed up',
  'signed-up',
  'signup',
  'done',
  'complete',
  'completed',
  'yes',
  'y',
  'true',
  '1',
  '✓',
  '✔',
]);

/**
 * Values that mean the lead has applied and is waiting on the merchant. Matched
 * whole, like the list above and for the same reason: "not applied" has to stay
 * pending.
 *
 * No word may appear in both lists. One that did would read as whichever list
 * happens to be checked first, which is a decision nobody made.
 */
const APPLIED_SPELLINGS = new Set([
  'applied',
  'apply',
  'application',
  'application submitted',
  'aplicado',
  'aplicada',
  'solicitado',
  'solicitada',
  'solicitud',
]);

/**
 * Coerce anything — a sheet cell, a legacy JSON row, an API body — to a status.
 *
 * Anything unrecognised (including an empty cell, which is what every row
 * written before this column existed has) counts as pending. A lead is only
 * further along when someone, or the merchant's report, has said so.
 */
export function normalizeLeadStatus(raw: unknown): LeadStatus {
  if (typeof raw !== 'string') return DEFAULT_LEAD_STATUS;
  const value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (REGISTERED_SPELLINGS.has(value)) return 'registered';
  if (APPLIED_SPELLINGS.has(value)) return 'applied';
  return DEFAULT_LEAD_STATUS;
}

/**
 * The caption for each stored word. A record rather than a conditional so that
 * a status added later cannot reach the screen without one: the compiler asks.
 */
const LABELS: Record<LeadStatus, string> = {
  pending: 'Pending',
  applied: 'Applied',
  registered: 'Approved',
};

export function statusLabel(status: LeadStatus): string {
  // Something that is not a status at all, from an untyped row, reads as
  // Pending, the way anything that was not "registered" always has.
  return LABELS[status] ?? LABELS.pending;
}

const RANKS: Record<LeadStatus, number> = { pending: 0, applied: 1, registered: 2 };

/**
 * How far along the funnel a status is, for moves that may only go forward.
 *
 * The report sync compares ranks before it writes, so a report showing an
 * application can never pull an approved lead back to applied. A report can
 * show a lead's application without the approval that followed it, because the
 * two are counted on different days and an approval may have been recorded by
 * hand; that is a narrower view of the same lead, not news that it was
 * un-approved. Only a person, with the toggle, moves a lead backwards.
 */
export function statusRank(status: LeadStatus): number {
  return RANKS[status] ?? 0;
}

/**
 * Where the admin's one-click toggle takes a lead, or null when it has nowhere
 * to go.
 *
 * The toggle never marks a lead approved. Approved is money, and money is
 * recorded with Approve on the leads list, which asks which card and what it
 * paid; a pill that said Approved with nothing behind it would be a lead nobody
 * gets paid for. So the toggle moves between pending and applied only.
 *
 * Nothing sends a lead with a card back to pending, which would contradict the
 * card shown beside it. An applied lead with a card therefore has no move.
 *
 * A lead marked approved by hand before Approve existed, with no approval
 * behind it, can still be taken back: to applied when a card is on record,
 * since the merchant did see an application, and to pending when nothing is.
 */
export function nextManualStatus(row: { status: LeadStatus; card: string }): LeadStatus | null {
  const hasCard = row.card.trim() !== '';
  if (row.status === 'registered') return hasCard ? 'applied' : 'pending';
  if (row.status === 'applied') return hasCard ? null : 'pending';
  return 'applied';
}

/**
 * What a lead reads as once the approvals are taken into account.
 *
 * An approval outranks the stored status, pending or applied. The merchant has
 * agreed to pay for this person, which is stronger evidence that they went
 * through than anybody's memory of ticking a box — and a lead left below
 * approved underneath one is not a state somebody chose, it is one nothing got
 * round to updating. Without an approval the stored status stands as it is,
 * applied included.
 *
 * Deriving it rather than only writing it is what keeps the two panels honest:
 * the approvals list and the leads list are reading the same fact, so they
 * cannot disagree, no matter who recorded the approval or whether anyone has
 * re-run a sync since. The sync still writes the status through (see the QMP
 * route) so that column N of the spreadsheet says the same thing.
 */
export function displayStatus(stored: LeadStatus, hasApproval: boolean): LeadStatus {
  return hasApproval ? 'registered' : stored;
}
