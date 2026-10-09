import { NextResponse } from 'next/server';
import { allowedOrigin, publicInventory } from '@/lib/tradelines-public';
import { listTradelines, tradelinesEnabled } from '@/lib/tradelines-store';

/**
 * The tradelines on offer, for the storefront. No sign-in.
 *
 * This is the one route that hands tradelines to somebody who is not signed
 * in, and it is meant to: the storefront is a public site and this is its
 * stock list. It is deliberately absent from the middleware's matcher. What
 * goes out is decided in lib/tradelines-public, which leaves out anything
 * unpriced and everything about who entered a row.
 *
 * Read-only. Kept by a browser and by the edge for a minute, so a busy shop
 * is not a read of the table per page view, and a new paste shows within the
 * minute.
 *
 * Only the storefront's own address may read it from a browser (see
 * allowedOrigin). That is not secrecy, the list is public; it stops another
 * site presenting this stock as its own from a visitor's browser.
 */

export const dynamic = 'force-dynamic';

function headersFor(request: Request): Record<string, string> {
  const origin = allowedOrigin(
    request.headers.get('origin'),
    process.env.TRADELINES_SITE_URL,
    process.env.NODE_ENV === 'production',
  );
  return {
    // The answer depends on who asked, so a cache must not hand one site's to another.
    Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } : {}),
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(request) });
}

export async function GET(request: Request) {
  const headers = headersFor(request);
  if (!tradelinesEnabled()) {
    return NextResponse.json({ error: 'The tradelines are not available right now.' }, { status: 503, headers });
  }
  try {
    const inventory = publicInventory(await listTradelines());
    return NextResponse.json(inventory, {
      headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' },
    });
  } catch {
    // The reason stays in the server log. A shopper is told only that it is not there.
    return NextResponse.json({ error: 'The tradelines are not available right now.' }, { status: 503, headers });
  }
}
