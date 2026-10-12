import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { OrdersList } from '@/components/TradelineOrders';
import { listTradelineOrders } from '@/lib/tradeline-order-store';
import { listUsers } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradeline Orders' };

/**
 * Every order placed on the tradelines storefront. Admins only.
 *
 * An order arrives unpaid. Opening one is where it is marked paid, which is
 * what makes its commission the affiliate's, or cancelled.
 */
export default async function TradelineOrdersPage() {
  await requireAdmin();

  let orders;
  try {
    orders = await listTradelineOrders();
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read the orders"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }

  // Names for the affiliates behind the orders. Without them the list says "An affiliate".
  const sellers: Record<string, string> = {};
  for (const user of await listUsers().catch(() => [])) sellers[user.id] = user.fullName || user.username;

  return (
    <div className="w-full">
      <div className="rise">
        <p className="text-[12px]">
          <Link href="/tradelines" className="text-ink-soft underline underline-offset-2">
            Tradelines
          </Link>
        </p>
        <h1 className="mt-2 font-display text-[26px] leading-[1.05]">Tradeline Orders</h1>
        <p className="mt-3 max-w-[680px] text-[13px] leading-relaxed text-ink-soft">
          Orders placed on the storefront, newest first. An order arrives awaiting payment. Mark it paid once the money
          is in: that is when the affiliate behind it has earned their commission.
        </p>
      </div>
      <OrdersList orders={orders} sellers={sellers} />
    </div>
  );
}
