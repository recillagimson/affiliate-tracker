import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { OrderActions, OrderSecrets, OrderStatusChip } from '@/components/TradelineOrders';
import { formatDateTime } from '@/lib/analytics';
import { formatMobile } from '@/lib/tradeline-order-admin';
import { listSsnReveals, readTradelineOrder } from '@/lib/tradeline-order-store';
import { orderCommission } from '@/lib/tradeline-sales';
import { formatAge, formatLimit, formatOpenDate, formatPrice } from '@/lib/tradelines';
import { findUserById } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradeline Order' };

type PageProps = { params: Promise<{ orderNumber: string }> };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label-cap text-[10px]">{label}</dt>
      <dd className="mt-1 text-[14px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * One order: who placed it, what for, who sold it, and where it stands.
 * Admins only.
 *
 * The SSN and date of birth are not read for this page. It is given the last
 * four digits, and the rest comes only when Reveal is pressed.
 */
export default async function TradelineOrderPage({ params }: PageProps) {
  await requireAdmin();
  const { orderNumber } = await params;

  let order;
  try {
    order = await readTradelineOrder(decodeURIComponent(orderNumber).toUpperCase());
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read that order"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  if (!order) notFound();

  const [seller, reveals] = await Promise.all([
    order.affiliateUserId ? findUserById(order.affiliateUserId).catch(() => null) : null,
    listSsnReveals(order.orderNumber).catch(() => []),
  ]);
  const commission = orderCommission(order);

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <p className="text-[12px]">
          <Link href="/tradelines/orders" className="text-ink-soft underline underline-offset-2">
            All orders
          </Link>
        </p>
        <h1 className="tnum mt-2 flex flex-wrap items-center gap-3 font-display text-[26px] leading-[1.05]">
          {order.orderNumber}
          <OrderStatusChip status={order.status} />
        </h1>
        <p className="plain mt-2.5">
          Placed {formatDateTime(order.createdAt)}
          {order.paidAt ? `. Marked paid ${formatDateTime(order.paidAt)}${order.paidBy ? ` by ${order.paidBy}` : ''}` : ''}
          {order.cancelledAt ? `. Cancelled ${formatDateTime(order.cancelledAt)}${order.cancelledBy ? ` by ${order.cancelledBy}` : ''}` : ''}.
        </p>
        <div className="mt-4">
          <OrderActions orderNumber={order.orderNumber} status={order.status} />
        </div>
      </div>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">What was ordered</h2>
        <ul className="mt-3 divide-y divide-edge">
          {order.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3">
              <div>
                <p className="text-[14px] font-medium text-ink">{item.name}</p>
                <p className="tnum mt-0.5 text-[12px] text-ink-dim">
                  {formatLimit(item.creditLimit)} limit, opened {formatOpenDate(item.openDate)}
                  {item.age ? `, ${formatAge(item.age)} years` : ''}
                </p>
                <p className="tnum mt-0.5 text-[12px] text-ink-dim">
                  {formatPrice(item.unitPrice)} each, quantity {item.quantity} ({item.quantity * 3} months)
                </p>
              </div>
              <p className="tnum text-[14px] font-medium text-ink">{formatPrice(item.lineTotal)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-baseline justify-between border-t border-edge pt-3 text-[14px]">
          <span className="text-ink-soft">Total</span>
          <span className="tnum text-[18px] font-medium text-ink">{formatPrice(order.total)}</span>
        </p>
      </section>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">Who sold it</h2>
        {order.affiliateUserId ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <Fact label="Affiliate">
              {seller ? (
                <Link href={`/users/${seller.id}`} className="underline underline-offset-2">
                  {seller.fullName || seller.username}
                </Link>
              ) : (
                'An affiliate'
              )}
            </Fact>
            <Fact label="Reference number">
              <span className="tnum">{order.tradelineRef}</span>
            </Fact>
            <Fact label="Commission">
              <span className="tnum">
                {order.status === 'cancelled'
                  ? 'None, the order was cancelled'
                  : order.status === 'paid'
                    ? `${formatPrice(commission)}, earned`
                    : `${formatPrice(commission)}, once paid`}
              </span>
            </Fact>
          </dl>
        ) : (
          <p className="plain mt-2">
            A house sale. {order.tradelineRef ? `It arrived with ${order.tradelineRef}, which is not a tradelines affiliate's number.` : 'It arrived with no reference number.'}
          </p>
        )}
      </section>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">The customer</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Name">{order.customerName}</Fact>
          <Fact label="Email">{order.customerEmail}</Fact>
          <Fact label="Mobile">
            <span className="tnum">{formatMobile(order.customerMobile)}</span>
          </Fact>
          <Fact label="Address">
            {order.line1}
            {order.line2 ? `, ${order.line2}` : ''}
            <br />
            {order.city}, {order.state} {order.zip}
          </Fact>
        </dl>
        <div className="mt-5 border-t border-edge pt-5">
          <OrderSecrets orderNumber={order.orderNumber} ssnLast4={order.ssnLast4} />
          <p className="mt-3 text-[12px] text-ink-dim">
            {reveals.length === 0
              ? 'Nobody has revealed these.'
              : `Last revealed ${formatDateTime(reveals[0]!.at)} by ${reveals[0]!.by}. Revealed ${reveals.length === 1 ? 'once' : `${reveals.length} times`} in all.`}
          </p>
        </div>
      </section>
    </div>
  );
}
