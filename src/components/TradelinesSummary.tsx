import Link from 'next/link';
import { CopyButton } from '@/components/CopyButton';
import { EmptyState } from '@/components/EmptyState';
import { formatDateTime } from '@/lib/analytics';
import type { AffiliateOrderRow, TradelineSummary } from '@/lib/tradeline-sales';
import { formatPrice } from '@/lib/tradelines';

/**
 * An affiliate's own tradelines figures: what they have earned and what they
 * are still owed.
 *
 * To the cent, the way tradeline prices are. Shared by the panel on the
 * tradelines page and the dashboard behind "View all", so the two cannot say
 * different things.
 */
export function TradelineFigures({ summary }: { summary: TradelineSummary }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2">
      <Figure
        label="Income"
        value={formatPrice(summary.income)}
        plain="From tradelines you have sold."
        className="border-b border-edge-soft sm:border-b-0 sm:border-r"
      />
      <Figure label="Pending payout" value={formatPrice(summary.pendingPayout)} plain="Earned and not yet paid." />
    </div>
  );
}

function Figure({
  label,
  value,
  plain,
  className = '',
}: {
  label: string;
  value: string;
  plain: string;
  className?: string;
}) {
  return (
    <div className={`px-5 py-4 ${className}`}>
      <h3 className="label-cap text-[10px]">{label}</h3>
      <div className="mt-2">
        <span className="tnum text-[28px] font-medium leading-none tracking-[-0.02em]">{value}</span>
      </div>
      <p className="mt-1 text-[12px] text-ink-dim">{plain}</p>
    </div>
  );
}

/**
 * What an affiliate on tradelines sees above the tables: their link, their
 * figures, and the way to every checkout.
 *
 * The link is their storefront link once the storefront has an address
 * (lib/tradeline-ref, tradelineLinkFor). Until then it says it is coming
 * rather than showing an address that goes nowhere. Their reference number is
 * shown either way; somebody the database has not given one to is shown none.
 */
export function TradelinesSummaryPanel({
  tradelineRef,
  link = '',
  summary,
}: {
  tradelineRef: string;
  /** Their storefront link, or '' while the storefront has no address. */
  link?: string;
  summary: TradelineSummary;
}) {
  return (
    <section className="rise panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-edge px-5 py-4">
        <div className="min-w-0">
          <h2 className="label-cap text-[10px]">Your link</h2>
          {link ? (
            <p className="tnum mt-1.5 break-all text-[14px] font-medium text-ink">{link}</p>
          ) : (
            <p className="mt-1.5 text-[14px] font-medium text-ink">Coming soon</p>
          )}
          <p className="mt-1 text-[12px] text-ink-dim">
            {link ? (
              <>
                Send this to a customer. What they buy through it is yours, under reference number{' '}
                <span className="tnum font-medium text-ink">{tradelineRef}</span>.
              </>
            ) : tradelineRef ? (
              <>
                Your checkout link is on its way. It will carry your reference number,{' '}
                <span className="tnum font-medium text-ink">{tradelineRef}</span>.
              </>
            ) : (
              'Your checkout link is on its way.'
            )}
          </p>
        </div>
        {link ? (
          <CopyButton value={link} label="Copy your link" idle="Copy link" />
        ) : tradelineRef ? (
          <CopyButton value={tradelineRef} label="Copy your reference number" idle="Copy number" />
        ) : null}
      </div>

      <TradelineFigures summary={summary} />

      <div className="flex justify-end border-t border-edge px-5 py-3">
        <Link href="/tradelines/dashboard" className="btn-outline btn-sm">
          View all
        </Link>
      </div>
    </section>
  );
}

const STATUS_LABEL = { awaiting_payment: 'Awaiting payment', paid: 'Paid', cancelled: 'Cancelled' } as const;
const STATUS_CHIP = {
  awaiting_payment: 'chip chip-quiet',
  paid: 'chip chip-gold',
  cancelled: 'chip border-alarm-edge bg-alarm-wash text-alarm',
} as const;

/**
 * Every checkout made with an affiliate's reference number.
 *
 * What they sold, to whom, what it came to and what it earns them. The
 * customer is a name and nothing more: the rows (lib/tradeline-sales,
 * affiliateRows) are not handed anything else about them.
 */
export function TradelineCheckouts({ rows }: { rows: AffiliateOrderRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No checkouts yet"
        body="Tradelines sold with your reference number will be listed here, with what each one earned you."
      />
    );
  }
  return (
    <ul className="panel divide-y divide-edge overflow-hidden">
      {rows.map((row) => (
        <li key={row.orderNumber} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
              {row.customerName}
              <span className={STATUS_CHIP[row.status]}>{STATUS_LABEL[row.status]}</span>
            </p>
            <p className="tnum mt-0.5 text-[12px] text-ink-dim">
              {row.orderNumber}, {formatDateTime(row.placedAt)}
            </p>
            <ul className="mt-2 text-[13px] text-ink-soft">
              {row.items.map((item, index) => (
                <li key={index}>
                  {item.name}, {item.quantity * 3} months
                </li>
              ))}
            </ul>
          </div>
          <div className="text-right">
            <p className="tnum text-[15px] font-medium text-ink">
              {row.status === 'cancelled' || row.commission <= 0
                ? 'No commission'
                : row.status === 'paid'
                  ? formatPrice(row.commission)
                  : `${formatPrice(row.commission)} when paid`}
            </p>
            <p className="tnum mt-0.5 text-[12px] text-ink-dim">Order total {formatPrice(row.total)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
