import { after, NextResponse } from 'next/server';
import { emailConfigured, sendEmail } from '@/lib/email';
import { tradelineOrderEmail } from '@/lib/emails/tradeline-order';
import { storeFailure } from '@/lib/payout-api';
import { rateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/request';
import { secretsConfigured } from '@/lib/secret-box';
import { orderLimitFor, priceOrder, readOrderRequest, totalsAgree } from '@/lib/tradeline-order';
import { findEarningAffiliate, placeTradelineOrder, tradelineOrdersEnabled } from '@/lib/tradeline-order-store';
import { allowedOrigin, publicInventory } from '@/lib/tradelines-public';
import { listTradelines } from '@/lib/tradelines-store';

/**
 * Placing a tradelines order, from the storefront's checkout. No sign-in.
 *
 * The one route that takes an SSN from somebody who is not signed in, so it
 * is strict in a particular order: it will not take one at all unless it can
 * seal it, it reads and checks everything (lib/tradeline-order) before it
 * looks anything up, and it limits how often one address may place one.
 *
 * It never trusts a price. The request says which tradelines and how many,
 * and what total the customer was shown. The lines are priced here from the
 * live table, and if that is not the total they were shown the order is
 * refused and they are told the real one.
 *
 * Nothing from the body is logged, here or in a caught error: it has a
 * customer's SSN in it.
 *
 * Deliberately absent from the middleware's matcher, like the stock list.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 20_000;
const UNAVAILABLE = 'Checkout is not available right now. Please call us to place your order.';

function headersFor(request: Request): Record<string, string> {
  const production = process.env.NODE_ENV === 'production';
  const origin = allowedOrigin(request.headers.get('origin'), process.env.TRADELINES_SITE_URL, production);
  return {
    'Cache-Control': 'no-store',
    ...(production ? {} : { Vary: 'Origin' }),
    ...(origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        }
      : {}),
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(request) });
}

export async function POST(request: Request) {
  const headers = headersFor(request);
  const answer = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers });

  // No key to seal with, or nowhere to save: say so before reading a word of it.
  if (!secretsConfigured() || !tradelineOrdersEnabled()) return answer({ error: UNAVAILABLE }, 503);

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return answer({ error: 'That order could not be read.' }, 400);
    body = JSON.parse(raw);
  } catch {
    return answer({ error: 'That order could not be read.' }, 400);
  }

  const read = readOrderRequest(body, new Date().toISOString().slice(0, 10));
  if (!read.ok) return answer({ error: 'Please check the highlighted details.', fields: read.fields }, 422);
  const order = read.request;

  // Counted here, once the request is one that could become an order, so a
  // customer correcting a mistyped field is not using up their tries.
  const { key, limit, windowMs } = orderLimitFor(clientIp(request));
  if (!rateLimit(key, { limit, windowMs }).ok) {
    return answer({ error: 'That is a lot of orders in a short time. Wait a few minutes and try again, or call us.' }, 429);
  }

  // Not a person. Answer as if it worked, and save nothing.
  if (order.trap) return answer({ orderNumber: 'LGF-000000', total: order.expectedTotal }, 201);

  try {
    const stock = publicInventory(await listTradelines()).tradelines;
    const affiliate = order.ref ? await findEarningAffiliate(order.ref) : null;

    const priced = priceOrder(order.items, stock, affiliate?.earns ?? false);
    if (!priced.ok) {
      return answer(
        {
          error: 'Something in your cart is no longer available. Remove it and try again.',
          gone: priced.gone,
        },
        409,
      );
    }
    if (!totalsAgree(order.expectedTotal, priced.total)) {
      return answer(
        { error: 'A price has changed since you added it to your cart. Check the new total and try again.', total: priced.total },
        409,
      );
    }

    const orderNumber = await placeTradelineOrder({
      customer: order.customer,
      items: priced.items,
      ref: order.ref,
      affiliateUserId: affiliate?.userId ?? null,
    });

    /*
     * The confirmation, sent once the customer has their answer. The order is
     * saved by now, and holding the answer while a mail provider thinks is how
     * a saved order comes to look like a failed one: the request times out,
     * the customer is told it did not go through, and they place it again.
     */
    if (emailConfigured()) {
      const message = tradelineOrderEmail({
        to: order.customer.email,
        name: order.customer.name,
        orderNumber,
        items: priced.items,
        total: priced.total,
      });
      after(() => sendEmail(message).then(() => undefined, () => undefined));
    }

    return answer({ orderNumber, total: priced.total }, 201);
  } catch (error) {
    // The class of the error and nothing else. Never the error itself.
    console.error('[tradeline-orders] placing an order failed:', error instanceof Error ? error.name : 'unknown');
    const refusal = storeFailure(error, UNAVAILABLE);
    return answer({ error: refusal.status === 503 ? UNAVAILABLE : refusal.error }, refusal.status);
  }
}
