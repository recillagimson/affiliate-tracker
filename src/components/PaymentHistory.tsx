import Link from 'next/link';
import { formatMoney } from '@/lib/analytics';
import { describeHistory, type HistoryRow } from '@/lib/payslip-view';

/**
 * Every approved card, and whether it has been paid.
 *
 * Drawn on the server from rows approvalHistory has already sorted and
 * labelled. Flex-wrap rows rather than a table, like the rest of the payout
 * pages, so a phone folds the columns instead of scrolling sideways.
 */
export function PaymentHistory({ rows }: { rows: HistoryRow[] }) {
  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="border-b border-edge bg-paper-card px-5 py-3.5">
        <h2 className="text-[15px] font-semibold text-ink">Payment history</h2>
        <p className="mt-0.5 text-[12px] text-ink-dim">
          {rows.length === 0 ? 'No approved cards yet.' : describeHistory(rows)}
        </p>
      </div>

      {rows.length === 0 ? null : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="border-b border-edge-faint last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5">
                <span className="w-[110px] flex-none">
                  <span className="tnum block text-[13px] text-ink">{row.approved}</span>
                  <span className="block text-[11px] text-ink-dim">Approved</span>
                </span>
                <span className="min-w-[170px] flex-1">
                  <span className="block text-[13px] text-ink">{row.card}</span>
                  <span className="block text-[11px] text-ink-dim">{row.customer}</span>
                </span>
                <span className="w-[100px] flex-none text-right">
                  <span className="tnum block text-[14px] font-semibold text-ink">{formatMoney(row.amount)}</span>
                </span>
                <span className="w-[190px] flex-none">
                  <span className={`chip ${row.chip.className}`}>{row.chip.label}</span>
                  <span className="mt-1 block text-[11px] text-ink-dim">
                    {row.href ? (
                      <Link href={row.href} className="link-text">
                        {row.when}
                      </Link>
                    ) : (
                      row.when
                    )}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
