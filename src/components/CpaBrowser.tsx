'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Pager } from '@/components/Pager';
import { SortHeader, nextSort, type SortState } from '@/components/SortHeader';
import { TableScroller } from '@/components/TableScroller';
import { formatDay, formatMoney, formatPercent } from '@/lib/analytics';
import type { CpaRateView } from '@/lib/cpa';
import {
  MIN_STEPS,
  columnsFor,
  defaultSort,
  filterGroups,
  filterQuery,
  groupRates,
  isFiltered,
  issuersOf,
  sortGroups,
  tiersOf,
  type CpaFilter,
  type CpaShape,
} from '@/lib/cpa-groups';
import { BLANK } from '@/lib/report-table';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';

/**
 * The rate card, grouped the way the report itself is written: one row per
 * card, with its tiers folded underneath it.
 *
 * The export is a list of rates, but a person reads it as a list of cards:
 * "what does the Platinum pay" is one question, not three. Flat, a nine-tier
 * card is nine rows that push everything else off the screen; grouped, it is
 * one row you open when you need it.
 *
 * That makes the card the unit of this table, and so also the unit of the
 * pager: a page is ten cards, never ten rates, because half a card's tiers at
 * the bottom of one page and the rest at the top of the next is not something
 * anybody can read.
 *
 * The grouping, the columns, the sort and the filter all live in
 * lib/cpa-groups, which knows nothing about React. That is what lets the three
 * downloads at the top of the table be built from the same rules on the server:
 * a PDF that disagreed with the page it was printed from would be a rate card
 * with different numbers in it.
 */

export function CpaBrowser({
  rows,
  gross,
  inactive = [],
}: {
  rows: CpaRateView[];
  gross: boolean;
  /** Cards an admin has marked Inactive, as `issuer|card`. Everybody sees the mark; only an admin (gross) can change it. */
  inactive?: string[];
}) {
  /*
   * The marks as this page shows them: the server's, plus any change made
   * here. No router refresh after a save: the chip is already right, the
   * server has it for the next load, and going without a router is what lets
   * the render checks draw this table. Reset if the server's list changes.
   */
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set(inactive));
  const inactiveKey = inactive.join('\n');
  useEffect(() => setMarked(new Set(inactive)), [inactiveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [savingCard, setSavingCard] = useState('');
  const [statusError, setStatusError] = useState('');

  async function setStatus(key: string, makeInactive: boolean) {
    if (savingCard) return;
    setSavingCard(key);
    setStatusError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'card-status', card: key, inactive: makeInactive }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? `That did not save (${res.status}).`);
      setMarked((current) => {
        const next = new Set(current);
        if (makeInactive) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch (caught) {
      setStatusError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setSavingCard('');
    }
  }

  const [filter, setFilter] = useState<CpaFilter>({
    query: '',
    issuer: '',
    min: null,
    shape: 'all',
  });
  const [sort, setSort] = useState<SortState>(() => defaultSort(gross));
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[0]);
  /**
   * Which cards are folded shut. Closed is what is tracked rather than open, so
   * the default is everything open: the same as the report this copies, and the
   * state somebody can read without clicking anything first.
   */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo(() => groupRates(rows), [rows]);
  const columns = useMemo(() => columnsFor(gross), [gross]);
  const issuers = useMemo(() => issuersOf(groups), [groups]);

  const matched = useMemo(
    () => sortGroups(filterGroups(groups, filter, gross), sort, gross),
    [groups, filter, sort, gross],
  );

  const visible = pageSlice(matched, page, perPage);
  const anyTiered = groups.some((group) => group.tiered);
  const allClosed = anyTiered && groups.every((group) => !group.tiered || closed.has(group.key));
  const narrowed = isFiltered(filter);

  /*
   * The filter and the sort, handed to the server so a download is the table
   * somebody is looking at rather than the whole rate card. Not the page: a
   * two-page PDF of page one of a table is nobody's idea of an export.
   */
  const query = filterQuery(filter, sort);
  const href = (format: 'pdf' | 'xlsx' | 'csv') =>
    `/api/cpa/export?format=${format}${query ? `&${query}` : ''}`;

  function change(next: Partial<CpaFilter>) {
    setFilter((current) => ({ ...current, ...next }));
    // Any change to what is listed sends the reader back to the first page.
    // Staying on page four of a list that is now two pages long shows an empty
    // table and reads as "nothing matched".
    setPage(1);
  }

  function clear() {
    setFilter({ query: '', issuer: '', min: null, shape: 'all' });
    setPage(1);
  }

  function toggleSort(key: string) {
    setPage(1);
    setSort((current) => nextSort(current, key));
  }

  function toggle(key: string) {
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    // Every card, not just this page. A "fold everything" that left the next
    // page open would be a control that lies about what it did.
    setClosed(allClosed ? new Set() : new Set(groups.filter((g) => g.tiered).map((g) => g.key)));
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="sr-only" htmlFor="cpa-search">
            Search the rate card
          </label>
          <input
            id="cpa-search"
            type="search"
            value={filter.query}
            onChange={(event) => change({ query: event.target.value })}
            placeholder="Search an issuer, a card or a tier…"
            className="field"
          />
        </div>

        <label className="sr-only" htmlFor="cpa-issuer">
          Issuer
        </label>
        <select
          id="cpa-issuer"
          value={filter.issuer}
          onChange={(event) => change({ issuer: event.target.value })}
          className="field w-auto max-w-[220px] truncate"
        >
          <option value="">Every issuer</option>
          {issuers.map((issuer) => (
            <option key={issuer} value={issuer}>
              {issuer}
            </option>
          ))}
        </select>

        {/*
          The floor, in round numbers. It reads against whichever money column
          this viewer has, so an admin filters on what the merchant pays and
          everybody else on what they would keep. The label says which.
        */}
        <label className="sr-only" htmlFor="cpa-min">
          {gross ? 'The least a card may pay' : 'The least a card may earn you'}
        </label>
        <select
          id="cpa-min"
          value={filter.min === null ? '' : String(filter.min)}
          onChange={(event) =>
            change({ min: event.target.value === '' ? null : Number(event.target.value) })
          }
          className="field w-auto"
        >
          <option value="">Any amount</option>
          {MIN_STEPS.map((step) => (
            <option key={step} value={step}>
              {/* One string rather than three, so the label is one text node in
                  the markup instead of three with comment separators between
                  them. It reads the same and it can be searched for. */}
              {`${gross ? 'Pays' : 'Earns'} ${formatMoney(step)} or more`}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="cpa-shape">
          Tiers
        </label>
        <select
          id="cpa-shape"
          value={filter.shape}
          onChange={(event) => change({ shape: event.target.value as CpaShape })}
          className="field w-auto"
        >
          <option value="all">Tiered and flat</option>
          <option value="tiered">Tiered cards</option>
          <option value="flat">One rate only</option>
        </select>

        {narrowed ? (
          <button type="button" className="btn-quiet btn-sm" onClick={clear}>
            Clear
          </button>
        ) : null}
        {anyTiered ? (
          <button type="button" className="btn-quiet btn-sm" onClick={toggleAll}>
            {allClosed ? 'Open every card' : 'Fold every card'}
          </button>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <p className="text-[12px] text-ink-soft">
          {narrowed
            ? `A download takes the ${matched.length.toLocaleString()} card${
                matched.length === 1 ? '' : 's'
              } this filter leaves, not the page you are on.`
            : `A download takes all ${groups.length.toLocaleString()} card${
                groups.length === 1 ? '' : 's'
              }.`}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-dim">
            Download
          </span>
          {/* Plain links rather than a fetch and a blob: the server names the
              file and the browser saves it, which is one moving part instead of
              three and works with a middle click. */}
          <a className="btn-quiet btn-sm" href={href('pdf')}>
            PDF
          </a>
          <a className="btn-quiet btn-sm" href={href('xlsx')}>
            Excel
          </a>
          <a className="btn-quiet btn-sm" href={href('csv')}>
            CSV
          </a>
        </span>
      </div>

      {matched.length === 0 ? (
        <p className="mt-8 rounded-[20px] border-2 border-dashed border-edge-strong bg-panel px-6 py-16 text-center text-[13px] text-ink-soft">
          {groups.length === 0
            ? 'No rates uploaded yet.'
            : narrowed
              ? 'No cards match those filters.'
              : 'Nothing matches.'}
        </p>
      ) : (
        <>
          {statusError ? (
            <p role="alert" className="field-error mt-4 block text-[13px]">
              {statusError}
            </p>
          ) : null}
          <TableScroller className="mt-5" label="Card rates">
          <table
            className={`w-full border-collapse text-left ${
              gross ? 'min-w-[1040px]' : 'min-w-[720px]'
            }`}
          >
            <thead>
              <tr className="bg-paper-card">
                {columns.map((column) => (
                  <SortHeader
                    key={column.key}
                    label={column.label}
                    sortKey={column.key}
                    sort={sort}
                    onSort={toggleSort}
                    right={column.right}
                  />
                ))}
                {/* Not sortable: it is a mark, not a figure, and the filter is
                    the way to find the inactive ones. */}
                <th scope="col" className="whitespace-nowrap p-0 pb-3">
                  <span className="label-cap block px-3 py-1 text-left">Status</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((group, index) => {
                const open = !closed.has(group.key);
                const single = group.tiered ? null : group.rates[0]!;
                /*
                 * Every other card sits on a band, and a whole card takes one:
                 * a tiered card and its tiers are one thing, and striping them
                 * apart would undo the grouping this table exists for. Folded
                 * shut, that is exactly one row per band, which is the plain
                 * every-other-row stripe.
                 *
                 * Counted off the page rather than the whole list, so every
                 * page opens on the same colour instead of the first row
                 * changing shade as you page through.
                 */
                const band = index % 2 === 1 ? 'bg-paper-sunk' : '';
                const isInactive = marked.has(group.key);
                // Greyed, not hidden: an affiliate should see that the card
                // exists and is not to be offered, rather than wonder where it went.
                const dim = isInactive ? 'opacity-55' : '';

                return (
                  <Fragment key={group.key}>
                    {/* The card. On a tiered one this is a heading and nothing
                        else: the rates live on the tiers underneath, and
                        putting a figure here would mean inventing one. */}
                    <tr
                      className={`${
                        group.tiered ? 'border-t-2 border-edge-faint' : 'divider-row'
                      } ${band}`}
                    >
                      <td className={`max-w-[200px] truncate px-3 py-3 text-[12px] text-ink-soft ${dim}`}>
                        {group.issuer || BLANK}
                      </td>
                      <td className={`max-w-[380px] px-3 py-3 text-[13px] font-semibold ${dim}`}>
                        {group.card}
                      </td>
                      <td className="px-3 py-3 text-[12px]">
                        {group.tiered ? (
                          <button
                            type="button"
                            onClick={() => toggle(group.key)}
                            aria-expanded={open}
                            className="inline-flex items-center gap-2 rounded-lg px-1 py-1"
                          >
                            <span className="chip chip-quiet tnum">{group.rates.length}</span>
                            <span aria-hidden className="text-ink-soft">
                              {open ? '▲' : '▼'}
                            </span>
                            <span className="sr-only">
                              {open ? 'Fold away' : 'Show'} the {group.rates.length} tiers of{' '}
                              {group.card}
                            </span>
                          </button>
                        ) : (
                          <span className="text-ink-dim">{BLANK}</span>
                        )}
                      </td>
                      {gross ? <Money value={single ? single.current : null} lead /> : null}
                      <Money value={single ? single.revenue : null} lead />
                      {gross ? <Money value={single ? single.previous : null} /> : null}
                      {gross ? <Change value={single ? single.change : null} /> : null}
                      <Changed value={single ? single.changedOn : ''} />
                      <td className="whitespace-nowrap px-3 py-3 text-[12px]">
                        <span className="flex items-center gap-2">
                          <span className={`chip ${isInactive ? 'chip-quiet' : 'chip-live'}`}>
                            {isInactive ? 'Inactive' : 'Active'}
                          </span>
                          {gross ? (
                            <button
                              type="button"
                              className="btn-quiet btn-sm"
                              disabled={savingCard !== ''}
                              aria-busy={savingCard === group.key}
                              onClick={() => void setStatus(group.key, !isInactive)}
                            >
                              {savingCard === group.key ? 'Saving…' : isInactive ? 'Mark active' : 'Mark inactive'}
                              <span className="sr-only">: {group.card}</span>
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>

                    {group.tiered && open
                      ? tiersOf(group, sort).map((rate, tierIndex) => (
                          <tr
                            key={`${group.key}:${rate.tier}:${tierIndex}`}
                            className={`divider-row ${band} ${dim}`}
                          >
                            {/* Blank on purpose: the issuer and the card are on
                                the row above, and repeating them down every
                                tier is what makes a grouped table read like an
                                ungrouped one. */}
                            <td />
                            <td />
                            <td className="whitespace-nowrap px-3 py-3 text-[12px]">
                              <span aria-hidden className="mr-2 text-ink-dim">
                                ↳
                              </span>
                              {/* The card's name, for a screen reader only: a
                                  row that says only "Tier 2" is unreadable out
                                  of the context the indent gives sighted eyes. */}
                              <span className="sr-only">{group.card}, </span>
                              {rate.tier || BLANK}
                            </td>
                            {gross ? <Money value={rate.current} lead /> : null}
                            <Money value={rate.revenue} lead />
                            {gross ? <Money value={rate.previous} /> : null}
                            {gross ? <Change value={rate.change} /> : null}
                            <Changed value={rate.changedOn} />
                            <td />
                          </tr>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </TableScroller>
        </>
      )}

      <Pager
        total={matched.length}
        page={page}
        perPage={perPage}
        onPage={setPage}
        onPerPage={setPerPage}
        label="Cards"
        note={matched.length === groups.length ? '' : ` · ${groups.length} in total`}
        className="mt-6"
      />
    </>
  );
}

/**
 * A money cell. `lead` marks the two columns people came here for, which are
 * set larger; the rest are context and are sized as such.
 *
 * Null reads as a dash rather than as $0 throughout. A card at zero has been
 * switched off, which is worth seeing; a blank one simply has no figure.
 */
function Money({ value, lead = false }: { value: number | null; lead?: boolean }) {
  return (
    <td
      className={
        lead
          ? 'tnum px-3 py-3 text-right font-display text-[15px] font-semibold'
          : 'tnum px-3 py-3 text-right text-[12px] text-ink-soft'
      }
    >
      {value === null ? <span className="text-ink-dim">{BLANK}</span> : formatMoney(value)}
    </td>
  );
}

function Change({ value }: { value: number | null }) {
  return (
    <td className="tnum px-3 py-3 text-right text-[12px]">
      {value === null ? (
        <span className="text-ink-dim">{BLANK}</span>
      ) : (
        <span className={value < 0 ? 'text-alarm' : undefined}>
          {value > 0 ? '+' : ''}
          {formatPercent(value, 2)}
        </span>
      )}
    </td>
  );
}

function Changed({ value }: { value: string }) {
  return (
    <td className="whitespace-nowrap px-3 py-3 text-right text-[12px] text-ink-soft">
      {value ? formatDay(value) : BLANK}
    </td>
  );
}
