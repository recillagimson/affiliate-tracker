'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDateTime } from '@/lib/analytics';
import { maskTin } from '@/lib/mask';
import { formatSsn, matchOrders, ORDER_STATUS_LABELS } from '@/lib/tradeline-order-admin';
import type { OrderStatus, TradelineOrder } from '@/lib/tradeline-order-store';
import { formatOpenDate, formatPrice } from '@/lib/tradelines';

const STATUS_CHIP: Record<OrderStatus, string> = {
  awaiting_payment: 'chip chip-quiet',
  paid: 'chip chip-gold',
  cancelled: 'chip border-alarm-edge bg-alarm-wash text-alarm',
};

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  return <span className={STATUS_CHIP[status]}>{ORDER_STATUS_LABELS[status]}</span>;
}

async function post(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch('/api/tradeline-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, data };
  return { ok: false, error: typeof data.error === 'string' ? data.error : `That did not work (${response.status}).` };
}

/**
 * Every order, newest first, with a search and a status filter.
 *
 * `sellers` is each affiliate's name by their account id, so the list can say
 * who sold what without each row being its own lookup.
 */
export function OrdersList({ orders, sellers }: { orders: TradelineOrder[]; sellers: Record<string, string> }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const shown = useMemo(() => matchOrders(orders, query, status), [orders, query, status]);

  if (orders.length === 0) {
    return (
      <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
        No orders yet. An order placed on the storefront will be listed here.
      </p>
    );
  }

  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-edge px-5 py-3.5">
        <label className="block min-w-[220px] flex-1">
          <span className="field-label">Find an order</span>
          <input
            type="search"
            className="field mt-1.5"
            placeholder="Order number, name or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Status</span>
          <select className="field mt-1.5" value={status} onChange={(event) => setStatus(event.target.value as OrderStatus | 'all')}>
            <option value="all">All</option>
            <option value="awaiting_payment">Awaiting payment</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-soft">No order matches that.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {shown.map((order) => (
            <li key={order.orderNumber}>
              <Link
                href={`/tradelines/orders/${order.orderNumber}`}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 px-5 py-3.5 hover:bg-paper-sunk"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                    {order.customerName}
                    <OrderStatusChip status={order.status} />
                  </span>
                  <span className="tnum mt-0.5 block text-[12px] text-ink-dim">
                    {order.orderNumber}, {formatDateTime(order.createdAt)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="tnum block text-[14px] font-medium text-ink">{formatPrice(order.total)}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-dim">
                    {order.items.length === 1 ? '1 tradeline' : `${order.items.length} tradelines`},{' '}
                    {order.affiliateUserId ? (sellers[order.affiliateUserId] ?? 'An affiliate') : 'House sale'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * An order's SSN and date of birth.
 *
 * Drawn with the last four digits and nothing else, because that is all the
 * page was given. Reveal asks the server for both; the server writes down who
 * asked. They are held in this component's memory and nowhere else, so they
 * are gone on a reload.
 */
export function OrderSecrets({ orderNumber, ssnLast4 }: { orderNumber: string; ssnLast4: string }) {
  const [revealed, setRevealed] = useState<{ ssn: string; dob: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    if (!confirm("Show this customer's full SSN and date of birth? This is recorded with your name and the time.")) return;
    setBusy(true);
    setError(null);
    const result = await post({ action: 'reveal', orderNumber });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRevealed({ ssn: String(result.data.ssn ?? ''), dob: String(result.data.dob ?? '') });
  }

  return (
    <div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="label-cap text-[10px]">Social Security number</dt>
          <dd className="tnum mt-1 text-[14px] text-ink">{revealed ? formatSsn(revealed.ssn) : maskTin(ssnLast4, 'ssn')}</dd>
        </div>
        <div>
          <dt className="label-cap text-[10px]">Date of birth</dt>
          <dd className="tnum mt-1 text-[14px] text-ink">{revealed ? formatOpenDate(revealed.dob) : 'Hidden'}</dd>
        </div>
      </dl>
      {revealed ? (
        <button type="button" className="btn-quiet btn-sm mt-3" onClick={() => setRevealed(null)}>
          Hide
        </button>
      ) : (
        <button type="button" className="btn-outline btn-sm mt-3" disabled={busy} aria-busy={busy} onClick={reveal}>
          {busy ? 'Revealing…' : 'Reveal'}
        </button>
      )}
      {error ? (
        <p role="alert" className="field-error mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Mark paid and cancel, for the statuses each makes sense in. Each asks first. */
export function OrderActions({ orderNumber, status }: { orderNumber: string; status: OrderStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'pay' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status === 'cancelled') return null;

  async function act(action: 'pay' | 'cancel') {
    const question =
      action === 'pay'
        ? `Mark ${orderNumber} paid? The affiliate's commission counts from now.`
        : `Cancel ${orderNumber}? A cancelled order cannot be reopened${status === 'paid' ? ', and its commission stops counting' : ''}.`;
    if (!confirm(question)) return;
    setBusy(action);
    setError(null);
    const result = await post({ action, orderNumber });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {status === 'awaiting_payment' ? (
          <button type="button" className="btn-gold" disabled={busy !== null} aria-busy={busy === 'pay'} onClick={() => act('pay')}>
            {busy === 'pay' ? 'Marking paid…' : 'Mark paid'}
          </button>
        ) : null}
        <button type="button" className="btn-danger" disabled={busy !== null} aria-busy={busy === 'cancel'} onClick={() => act('cancel')}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="field-error mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
