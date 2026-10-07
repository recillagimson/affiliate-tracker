import type { Metadata } from 'next';
import { ErrorPanel } from '@/components/ErrorPanel';
import { TradelinesBrowser } from '@/components/TradelinesTable';
import { issuerFrom, type Tradeline } from '@/lib/tradelines';
import { listTradelines, tradelinesEnabled } from '@/lib/tradelines-store';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradelines Table' };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The tradelines table: what tradelines there are, issuer by issuer.
 *
 * Six tables, one per issuer, and the address says which is showing so it
 * survives a reload and can be linked to. Each row is a tradeline's name, its
 * credit limit, the day it was opened and its age, the last shown exactly as
 * it was pasted or typed.
 *
 * Admins only, for now. It is being loaded, and affiliates on the Tradelines
 * service are to be shown it later. requireAdmin sends anybody else home, and
 * the route behind the page's buttons refuses them separately.
 */
export default async function TradelinesPage({ searchParams }: PageProps) {
  await requireAdmin();

  if (!tradelinesEnabled()) {
    return (
      <ErrorPanel
        title="The tradelines table needs a database"
        message="Tradelines are kept in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  const query = await searchParams;
  const raw = query.issuer;
  const issuer = issuerFrom(Array.isArray(raw) ? raw[0] : raw);

  let all: Tradeline[];
  try {
    all = await listTradelines();
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read the tradelines"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }

  // Today, for the dialogs: to read a paste's two-digit years and to stop an
  // open date being set in the future. Decided once here so the server's
  // first paint and the browser agree on it. No age is worked out from it.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="w-full">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">Tradelines Table</h1>
        <p className="mt-3 max-w-[680px] text-[13px] leading-relaxed text-ink-soft">
          The tradelines on offer, by issuer. Choose an issuer to see its table. Ages are shown exactly as they were
          pasted or entered.
        </p>
      </div>

      {/* Every issuer's rows at once, so choosing one is instant. Which opens first comes from the address. */}
      <TradelinesBrowser all={all} initialIssuer={issuer} today={today} />
    </div>
  );
}
