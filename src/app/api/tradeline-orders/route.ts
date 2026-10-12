import { NextResponse } from 'next/server';
import { requireApiAdmin } from '@/lib/api-auth';
import { asBody, storeFailure } from '@/lib/payout-api';
import { readOrderAction } from '@/lib/tradeline-order-admin';
import {
  cancelTradelineOrder,
  markTradelineOrderPaid,
  revealTradelineOrderSecrets,
} from '@/lib/tradeline-order-store';

/**
 * What an admin does to a tradeline order: mark it paid, cancel it, or read
 * its SSN and date of birth back. Admins only, every action.
 *
 * `reveal` is the one that hands out an SSN. The store writes down who asked
 * before it opens anything, and the answer is marked not to be kept by a
 * browser or anything in between.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can change a tradeline order.');
  if ('response' in gate) return gate.response;
  const by = gate.viewer.username;

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }
  const action = readOrderAction(body.action);
  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim() : '';
  if (!action || !/^LGF-[0-9]{6}$/.test(orderNumber)) {
    return NextResponse.json({ error: 'Which order, and what should happen to it?' }, { status: 400 });
  }

  try {
    if (action === 'pay') {
      await markTradelineOrderPaid(orderNumber, by);
      return NextResponse.json({ ok: true });
    }
    if (action === 'cancel') {
      await cancelTradelineOrder(orderNumber, by);
      return NextResponse.json({ ok: true });
    }
    const secrets = await revealTradelineOrderSecrets(orderNumber, by);
    return NextResponse.json(secrets, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const refusal = storeFailure(error, 'That did not work. Reload and try again.');
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
}
