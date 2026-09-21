'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Pager } from '@/components/Pager';
import { TableScroller } from '@/components/TableScroller';
import {
  affiliateHref,
  formatMoney,
  formatPercent,
  initialsOf,
  type EarningsRow,
  type EarningsView,
  type Period,
} from '@/lib/analytics';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';

/**
 * One row per person: what came in, and what half of it is theirs.
 *
 * A client component only so it can page itself. Every figure in it is worked
 * out on the server and handed over whole, so there is no arithmetic here that
 * the totals below could disagree with.
 *
 * `gross` says which number arrived. An admin gets the merchant's payout and
 * both columns; an affiliate gets their own half already worked out, so the
 * Amount column is dropped rather than blanked — a column of dashes is a
 * standing reminder of a figure somebody is not being shown, and the merchant's
 * gross is not theirs to wonder about.
 */
export function EarnersTable({
  rows,
  totals,
  period,
  month = '',
  gross,
}: {
  rows: EarningsRow[];
  totals: EarningsView['totals'];
  period: Period;
  /** The month being shown, carried into each person's page. */
  month?: string;
  gross: boolean;
}) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[0]);
  const visible = pageSlice(rows, page, perPage);

  /*
   * Every row's own share added up, rather than a share of the total. The two
   * can differ by a cent, and once the commission percentage has been changed
   * once they differ by more than that: a row here can hold approvals earned
   * under two rates, and there is no single percentage of the total that is
   * the right answer. This is the sum of the column printed above it, which is
   * also the one a reader can check.
   */
  const affiliateRevenue =
    Math.round(rows.reduce((sum, row) => sum + row.affiliate, 0) * 100) / 100;

  return (
    <>
      <TableScroller className="mt-5" label="Who is earning">
        <table className={`w-full border-collapse text-left ${gross ? 'min-w-[980px]' : 'min-w-[820px]'}`}>
          <thead>
            <tr className="bg-paper-card">
              <Th>Person</Th>
              <Th align="right">Visits</Th>
              <Th align="right">Approved</Th>
              {gross ? <Th align="right">Amount</Th> : null}
              <Th align="right">Affiliate revenue</Th>
              {/* Deliberately empty: every button in the column carries its
                  own "Open <person>" label, so a header here would only
                  repeat itself once per row. */}
              <th className="border-b border-edge bg-paper-card px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.key} className="divider-row last:border-0">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="disc h-8 w-8 text-[11px]">
                      {row.usr ? initialsOf(row.person) : 'H'}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium">{row.person}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink-dim">
                        {row.cardCount} card{row.cardCount === 1 ? '' : 's'}
                        {row.usr ? ` · usr=${row.usr}` : ' · no usr'}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="tnum px-5 py-3.5 text-right text-[16px] font-semibold">
                  {row.visits.toLocaleString()}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <span className="tnum block text-[16px] font-semibold">{row.approved}</span>
                  {row.visits > 0 && row.approved > 0 ? (
                    <span className="mt-0.5 block text-[12px] text-ink-soft">
                      {formatPercent(row.approvalRate, 1)} of visits
                    </span>
                  ) : null}
                </td>
                {gross ? (
                  <td className="tnum px-5 py-3.5 text-right text-[16px] font-semibold">
                    {formatMoney(row.earnings)}
                  </td>
                ) : null}
                <td className="tnum px-5 py-3.5 text-right text-[16px] font-semibold">
                  {formatMoney(row.affiliate)}
                </td>
                <td className="px-5 py-3.5 text-right">
                  {/* One link per row rather than a whole-row target: the
                      thing you can click is then something you can see. */}
                  <Link
                    href={affiliateHref(row.usr, period, month)}
                    className="btn-outline btn-sm"
                    aria-label={`Open ${row.person}`}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-edge bg-paper-card">
              <td className="px-5 py-3.5 text-[13px] font-semibold uppercase tracking-[0.03em]">
                Total
                {/* The footer has always been the whole window, and now that the
                    rows above it are one page of it, that has to be said out
                    loud or it reads as a broken sum. */}
                {rows.length > visible.length ? (
                  <span className="mt-1 block text-[12px] font-normal text-ink-soft">
                    everyone, not just this page
                  </span>
                ) : null}
              </td>
              <td className="tnum px-5 py-3.5 text-right text-[15px] font-semibold">
                {totals.visits.toLocaleString()}
              </td>
              <td className="tnum px-5 py-3.5 text-right text-[15px] font-semibold">
                {totals.approved.toLocaleString()}
              </td>
              {gross ? (
                <td className="px-5 py-3.5 text-right">
                  <span className="mark tnum text-[16px] font-bold">
                    {formatMoney(totals.earnings)}
                  </span>
                </td>
              ) : null}
              {/* The highlighter follows the figure that matters, which on an
                  affiliate's own page is this one. */}
              <td className="px-5 py-3.5 text-right">
                <span
                  className={`tnum text-[16px] font-bold ${gross ? '' : 'mark'}`}
                >
                  {formatMoney(affiliateRevenue)}
                </span>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </TableScroller>

      <Pager
        total={rows.length}
        page={page}
        perPage={perPage}
        onPage={setPage}
        onPerPage={setPerPage}
        label="People"
      />
    </>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`label-cap border-b border-edge px-5 py-2.5 text-[10px] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
