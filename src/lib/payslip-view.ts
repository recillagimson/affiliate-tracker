/**
 * What the affiliate's payslip pages draw, shaped before any of it is drawn.
 *
 * The pages themselves read the session and the store, so neither can be
 * rendered outside a Next request. Everything they decide about what to show
 * lives here instead, as plain functions of plain rows, so it can be checked
 * without a database (scripts/payslip-view-checks.ts), and so the client
 * component that draws the ready list is handed rows already cut down to what
 * it draws.
 *
 * That last part is the reason for the file as much as the tidiness is. A
 * client component's props are shipped to the browser whole, and a conversion
 * row carries notes, a slug and a tracking key that nobody needs on this page.
 * Each shape below lists exactly the fields its table draws, and the checks
 * hold that list, so nothing extra can reach the page by riding along on a row.
 *
 * Every figure here is the reader's own money. A load that carries the
 * merchant's figures shapes to nothing: these pages are never meant to be
 * reached by an admin, and if one ever is, an empty list is the safe wrong
 * answer.
 *
 * Pure and client-safe: no store, no React, no session. The request store is
 * imported for its types only.
 */

import { describeConversions, formatMoney } from './analytics';
import { dayOf, PAYOUT_DAYS, shortDay } from './payout';
import {
  describeCountdown,
  describeReadyDay,
  splitByReadiness,
  type CommittedIds,
} from './payout-request';
import type {
  PayoutRequestItem,
  PayoutRequestRecord,
  PayoutRequestStatus,
} from './payout-request-store';
import { BLANK } from './report-table';
import type { AffiliateLink, Conversion, Submission } from './types';

/** The part of loadAll's answer these pages read. */
export type Loaded = {
  links: AffiliateLink[];
  conversions: Conversion[];
  submissions: Submission[];
  /** Whether the amounts are the merchant's rather than the reader's. See lib/load.ts. */
  gross: boolean;
};

/* ------------------------------------------------------------------ words --- */

/** What the live region says once a request has gone through. */
export const SUCCESS_MESSAGE = 'Payment requested. You can track it below.';

/** The ready list with nothing on it, which says when there will be. */
export function nothingReadyText(): string {
  return `Nothing is ready yet. Cards become requestable ${PAYOUT_DAYS} days after they are approved.`;
}

/** "1 card", "3 cards". */
export function cardCount(count: number): string {
  return count === 1 ? '1 card' : `${count} cards`;
}

/**
 * A name worth printing, or the blank the rest of the app prints.
 *
 * describeConversions already answers a missing customer with a dash and a
 * missing card with the slug, which can itself be empty. Both come out of here
 * as the one blank, so a table never shows two different placeholders.
 */
function named(text: string): string {
  const trimmed = (text ?? '').trim();
  return trimmed && trimmed !== BLANK ? trimmed : BLANK;
}

/* ------------------------------------------------------------------ cards --- */

/** One ready card, as the table draws it. */
export type CardRow = {
  id: string;
  card: string;
  customer: string;
  /** The day key, for anything that has to order or compare. */
  approvedOn: string;
  /** The same day as people read it. */
  approved: string;
  /** The reader's own money for this card. */
  amount: number;
  /** What a screen reader hears for this card's checkbox. */
  label: string;
};

/** One card still counting down, with the count and the day it ends. */
export type CountdownRow = CardRow & { daysLeft: number; countdown: string; readyDay: string };

/**
 * The checkbox's name: the card, the customer, the day and the money.
 *
 * A row of identical "Select" checkboxes is a list a screen reader cannot tell
 * apart, and the only way to find out which is which is to tick one and listen
 * to the total change. A blank is said in words, because a lone hyphen is read
 * aloud as "dash", which tells nobody anything.
 */
function checkboxLabel(card: string, customer: string, approved: string, amount: number): string {
  const cardWords = card === BLANK ? 'Card not on file' : card;
  const customerWords = customer === BLANK ? 'customer not on file' : `customer ${customer}`;
  return `${cardWords}, ${customerWords}, approved ${approved}, ${formatMoney(amount)}`;
}

function toCardRow(row: { id: string; approvedOn: string; amount: number; card: string; client: string }): CardRow {
  const card = named(row.card);
  const customer = named(row.client);
  const day = dayOf(row.approvedOn);
  const approved = shortDay(day);
  return {
    id: row.id,
    card,
    customer,
    approvedOn: day,
    approved,
    amount: row.amount,
    label: checkboxLabel(card, customer, approved, row.amount),
  };
}

/**
 * The reader's own cards, split into what can be requested today and what is
 * still counting down.
 *
 * The rules of the split are splitByReadiness's, so this page and the admin's
 * Pending tab cannot disagree about which card is ready. What this adds is the
 * reader: only rows under their own tracking key, and nothing at all for an
 * account with no key or for a load priced for the merchant. loadAll already
 * scopes an affiliate to their own rows, so the key filter is a second lock on
 * the same door rather than the only one, and it means a card is never offered
 * that the request route would refuse as somebody else's.
 *
 * The amount is `affiliate` from describeConversions, which for a load that is
 * not gross is the row's own amount: the same figure the request route records.
 */
export function cardsFor(
  load: Loaded,
  usr: string,
  today: string,
  committed: CommittedIds,
): { ready: CardRow[]; countingDown: CountdownRow[] } {
  if (load.gross || !usr) return { ready: [], countingDown: [] };

  const own = load.conversions.filter((row) => row.usr === usr);
  const views = describeConversions(load.links, own, load.submissions, { gross: false });
  const candidates = views.map((view) => ({
    id: view.id,
    usr: view.usr,
    approvedOn: view.approvedOn,
    amount: view.affiliate,
    card: view.card,
    client: view.client,
  }));

  const split = splitByReadiness(candidates, today, committed);
  return {
    ready: split.ready.map(toCardRow),
    countingDown: split.countingDown.map((row) => ({
      ...toCardRow(row),
      daysLeft: row.daysLeft,
      countdown: describeCountdown(row.approvedOn, today),
      readyDay: describeReadyDay(row.approvedOn),
    })),
  };
}

/* -------------------------------------------------------------- selection --- */

/** Whether the select-all box is empty, part way, or full. */
export type SelectAll = 'none' | 'some' | 'all';

/**
 * Counted against the list on screen, not against the size of the set.
 *
 * The set can hold an id that has left the list: a card put on a request from
 * another tab disappears on refresh, and the selection outlives the render. A
 * count of the set would call that "part way" with nothing visibly ticked.
 */
export function selectAllState(selected: ReadonlySet<string>, ids: readonly string[]): SelectAll {
  if (ids.length === 0) return 'none';
  let chosen = 0;
  for (const id of ids) if (selected.has(id)) chosen += 1;
  if (chosen === 0) return 'none';
  return chosen === ids.length ? 'all' : 'some';
}

/** Tick or untick one card. A new set, so React sees the change. */
export function toggleOne(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * The select-all box: full clears it, anything else fills it.
 *
 * Part way fills rather than clears, which is what every mail client does, and
 * what somebody who has ticked two of five and then reaches for "all" means.
 */
export function toggleAll(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return selectAllState(selected, ids) === 'all' ? new Set() : new Set(ids);
}

/**
 * The selection without anything that is no longer listed.
 *
 * Hands back the very same set when nothing went, so a component can run this
 * after every refresh and React skips the render when it changed nothing.
 */
export function keepListed(selected: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  const listed = new Set(ids);
  for (const id of selected) {
    if (!listed.has(id)) return new Set([...selected].filter((kept) => listed.has(kept)));
  }
  return selected;
}

/** The chosen rows, in the order the list shows them, whatever order they were ticked in. */
export function chosenRows<T extends { id: string }>(rows: readonly T[], selected: ReadonlySet<string>): T[] {
  return rows.filter((row) => selected.has(row.id));
}

/* --------------------------------------------------------------- requests --- */

/** Where a request's payslip lives. */
export function payslipHref(requestId: string): string {
  return `/payslips/${encodeURIComponent(requestId)}`;
}

/** Where its receipt is served, once an admin has attached one. */
export function receiptHref(requestId: string): string {
  return `/api/payouts/receipt?request=${encodeURIComponent(requestId)}`;
}

/**
 * Whether a URL segment can be a request at all: a positive whole number, with
 * no leading zero, small enough to be exact.
 *
 * The same rule the store applies before it queries. Asked here first so a
 * typed address like /payslips/2026-08-15 (a bookmark from the old pay periods)
 * is a plain 404 before anything is read.
 */
export function isRequestId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

export type StatusChip = { label: string; className: 'chip-gold' | 'chip-live' | 'chip-quiet' };

/**
 * The chip for where a request stands. Gold is a request waiting on somebody,
 * green is money that has been sent and nothing else, and a cancelled one is
 * quiet because there is nothing left to do about it.
 */
export function statusChip(status: PayoutRequestStatus): StatusChip {
  if (status === 'paid') return { label: 'Paid', className: 'chip-live' };
  if (status === 'cancelled') return { label: 'Cancelled', className: 'chip-quiet' };
  return { label: 'Requested', className: 'chip-gold' };
}

/* -------------------------------------------------------- payment history --- */

/** Where one approved card stands: paid, on a payment being processed, or waiting for the next monthly payout. */
export type HistoryStatus = 'paid' | 'processing' | 'unpaid';

export type HistoryRow = CardRow & {
  status: HistoryStatus;
  chip: StatusChip;
  /** "Paid 8 Oct 2026", or what happens next. */
  when: string;
  /** The payslip it was paid on, or '' when there is none yet. */
  href: string;
};

/**
 * Every approved card of the reader's, newest approval first, each with where
 * its money stands.
 *
 * A card is paid when it is on a paid payout, processing when it is on a
 * request still waiting to be paid (filed before payouts went monthly), and
 * otherwise waiting for the next monthly payout. A cancelled request does not
 * count: its cards were released and are unpaid again.
 */
export function approvalHistory(load: Loaded, usr: string, requests: readonly Listable[]): HistoryRow[] {
  if (load.gross || !usr) return [];

  // Each card's payout, and the amount that payout recorded for it. A card on
  // a payout shows that amount, not today's price: it is what was (or will be)
  // sent, even if the commission rate or the person's role has changed since.
  const onRequest = new Map<string, { request: Listable; amount: number }>();
  for (const request of requests) {
    if (request.status === 'cancelled') continue;
    for (const item of request.items) {
      if (!item.conversionId) continue;
      const seen = onRequest.get(item.conversionId);
      // A paid request wins over one still waiting, which cannot normally both hold a card.
      if (!seen || (seen.request.status !== 'paid' && request.status === 'paid')) {
        onRequest.set(item.conversionId, { request, amount: item.amount });
      }
    }
  }

  const own = load.conversions.filter((row) => row.usr === usr);
  const views = describeConversions(load.links, own, load.submissions, { gross: false });
  return views
    .map((view): HistoryRow => {
      const found = onRequest.get(view.id);
      const request = found?.request;
      const amount = found ? found.amount : view.affiliate;
      const base = toCardRow({ id: view.id, approvedOn: view.approvedOn, amount, card: view.card, client: view.client });
      if (request?.status === 'paid') {
        const paidOn = request.paidAt ? dayOf(request.paidAt) : '';
        return {
          ...base,
          status: 'paid',
          chip: { label: 'Paid', className: 'chip-live' },
          when: paidOn ? `Paid ${shortDay(paidOn)}` : 'Paid',
          href: payslipHref(request.id),
        };
      }
      if (request) {
        return {
          ...base,
          status: 'processing',
          chip: { label: 'Processing', className: 'chip-gold' },
          when: 'Payment being processed',
          href: payslipHref(request.id),
        };
      }
      return {
        ...base,
        status: 'unpaid',
        chip: { label: 'Not paid yet', className: 'chip-quiet' },
        when: 'In the next monthly payout',
        href: '',
      };
    })
    .sort((a, b) => (a.approvedOn < b.approvedOn ? 1 : a.approvedOn > b.approvedOn ? -1 : Number(b.id) - Number(a.id)));
}

/** The line above the history: how much has been paid and how much is waiting. */
export function describeHistory(rows: readonly HistoryRow[]): string {
  if (rows.length === 0) return '';
  const paid = rows.filter((row) => row.status === 'paid');
  const waiting = rows.filter((row) => row.status !== 'paid');
  const sum = (list: readonly HistoryRow[]) => formatMoney(list.reduce((total, row) => total + row.amount, 0));
  const paidText = `${cardCount(paid.length)} paid, ${sum(paid)}`;
  return waiting.length === 0 ? `${paidText}. Everything has been paid.` : `${paidText}. ${cardCount(waiting.length)} not paid yet, ${sum(waiting)}.`;
}

/** One request, as the list on /payslips draws it. */
export type RequestRow = {
  id: string;
  href: string;
  cards: string;
  /** What the request was for, fixed the moment it was made. */
  total: number;
  status: PayoutRequestStatus;
  chip: StatusChip;
  requested: string;
  /** "Paid 8 Oct 2026", "Cancelled 4 Oct 2026", or '' while it waits. */
  outcome: string;
};

type Listable = Pick<
  PayoutRequestRecord,
  'id' | 'status' | 'requestedAt' | 'totalAmount' | 'paidAt' | 'cancelledAt' | 'items'
>;

function stampOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Newest first, because the one at the top is the one somebody is waiting on.
 *
 * Ordered here even though the store already orders its query: the list is a
 * promise about the page, not about whichever query fed it. Two requests made
 * in the same instant fall back to the id, which only ever goes up.
 */
export function requestRows(records: readonly Listable[]): RequestRow[] {
  return [...records]
    .sort((a, b) => {
      const byTime = stampOf(b.requestedAt) - stampOf(a.requestedAt);
      if (byTime !== 0) return byTime;
      const byId = Number(b.id) - Number(a.id);
      return Number.isFinite(byId) ? byId : b.id.localeCompare(a.id);
    })
    .map((record) => ({
      id: record.id,
      href: payslipHref(record.id),
      // Every line it was made with, released ones included: a cancelled
      // request of three cards was a request of three cards.
      cards: cardCount(record.items.length),
      total: record.totalAmount,
      status: record.status,
      chip: statusChip(record.status),
      requested: `Requested ${shortDay(record.requestedAt)}`,
      outcome:
        record.status === 'paid' && record.paidAt
          ? `Paid ${shortDay(record.paidAt)}`
          : record.status === 'cancelled' && record.cancelledAt
            ? `Cancelled ${shortDay(record.cancelledAt)}`
            : '',
    }));
}

/* --------------------------------------------------------------- document --- */

/** One line of a payslip document. */
export type PayslipLine = { key: string; card: string; customer: string; amount: number };

/**
 * The lines of a request's payslip: the request's own items, named.
 *
 * The amount is the item's, recorded when the request was made, and never the
 * approval's figure today. A payslip is a statement of what was asked for, and
 * a figure that moved afterwards would make the lines stop adding up to the
 * total printed under them.
 *
 * The approvals are read only for the card and the customer. A line whose
 * approval has since been deleted (its request was cancelled first, which is
 * what allows that) keeps its amount and its place, with blanks for the names.
 */
export function payslipLines(
  items: readonly PayoutRequestItem[],
  load: Pick<Loaded, 'links' | 'conversions' | 'submissions'>,
): PayslipLine[] {
  const wanted = new Set(items.map((item) => item.conversionId).filter((id): id is string => id !== null));
  const views = describeConversions(
    load.links,
    load.conversions.filter((row) => wanted.has(row.id)),
    load.submissions,
    { gross: false },
  );
  const byId = new Map(views.map((view) => [view.id, view]));
  return items.map((item, index) => {
    const view = item.conversionId === null ? undefined : byId.get(item.conversionId);
    return {
      key: `${index}:${item.conversionId ?? 'released'}`,
      card: named(view?.card ?? ''),
      customer: named(view?.client ?? ''),
      amount: item.amount,
    };
  });
}
