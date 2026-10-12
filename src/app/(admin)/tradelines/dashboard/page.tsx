import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { TradelineCheckouts, TradelineFigures } from '@/components/TradelinesSummary';
import { tradelineSalesFor } from '@/lib/tradeline-sales';
import { readUserTradelineRef } from '@/lib/users';
import { requireService } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradelines Dashboard' };

/**
 * An affiliate's tradelines dashboard: what they have earned, what they are
 * owed, and every checkout made with their reference number.
 *
 * Reached from "View all" on the tradelines page. Their own and nobody
 * else's: it is read from the session, and there is nothing in the address to
 * change. For an affiliate on tradelines only. An admin has no reference
 * number and so no dashboard of their own, and is sent back to the table.
 *
 * The figures and the list come from their orders (lib/tradeline-sales). A
 * commission counts once its order is marked paid.
 */
export default async function TradelinesDashboardPage() {
  const viewer = await requireService('tradelines');
  if (viewer.role === 'admin') redirect('/tradelines');

  const tradelineRef = viewer.id ? await readUserTradelineRef(viewer.id).catch(() => '') : '';
  let sales;
  try {
    sales = await tradelineSalesFor(viewer.id);
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read your checkouts"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  const { summary, rows } = sales;

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">Tradelines Dashboard</h1>
        <p className="mt-3 max-w-[680px] text-[13px] leading-relaxed text-ink-soft">
          What you have made from tradelines, and every checkout made with your reference number
          {tradelineRef ? (
            <>
              , <span className="tnum font-medium text-ink">{tradelineRef}</span>
            </>
          ) : null}
          .
        </p>
      </div>

      <section className="rise panel mt-5 overflow-hidden">
        <TradelineFigures summary={summary} />
      </section>

      <h2 className="mt-8 text-[15px] font-semibold">Checkouts</h2>
      <div className="mt-3">
        <TradelineCheckouts rows={rows} />
      </div>

      <p className="mt-6">
        <Link href="/tradelines" className="btn-quiet btn-sm">
          Back to the tradelines table
        </Link>
      </p>
    </div>
  );
}
