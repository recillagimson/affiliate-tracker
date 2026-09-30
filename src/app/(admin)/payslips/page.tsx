import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { CountingDown, RequestPayment, YourRequests } from '@/components/RequestPayment';
import { loadAll } from '@/lib/load';
import { dayOf, PAYOUT_DAYS } from '@/lib/payout';
import {
  listCommittedConversionIds,
  listPayoutRequestsFor,
  payoutsEnabled,
  type PayoutRequestRecord,
} from '@/lib/payout-request-store';
import { cardsFor, requestRows } from '@/lib/payslip-view';
import { listNoShareKeys } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'My payslip' };

/**
 * Your own pay: what you can ask for, what is nearly ready, and what you have
 * already asked for.
 *
 * There is no payday any more. Every approved card runs on its own clock and
 * can be asked for 15 days after it was approved, so this page is built around
 * the one decision that is the affiliate's to make: which ready cards to be
 * paid for, and when. Three sections, in the order somebody acts on them. Ready
 * to request is at the top because it is the only one with anything to press.
 * Counting down is under it, and only when something is counting. Your requests
 * is last, newest first, each one opening its own payslip.
 *
 * Nothing on this page or the one behind it names a percentage or a merchant
 * rate. Every figure is the affiliate's own money, which is the only figure
 * that means anything to the person being paid.
 *
 * An admin in Client View reaches this page as the affiliate and may request
 * payment for them; the request route writes down that it was an admin who
 * pressed the button. Neither an admin nor an LGF employee can request.
 */
export default async function PayslipsPage() {
  const viewer = await requireViewer();

  /*
   * An admin has no payslips: they are not paid through this. Rather than a
   * blank page, the door to the other side of the same records.
   */
  if (viewer.role === 'admin' || !viewer.id) {
    return (
      <div className="mx-auto w-full max-w-[900px]">
        <h1 className="font-display text-[26px] leading-[1.05]">My payslip</h1>
        <p className="panel mt-5 p-5 text-[13px] text-ink-soft">
          This account is not paid through Ledger, so it has no payslips.{' '}
          <Link href="/payouts" className="link-text font-medium">
            Payouts
          </Link>{' '}
          has everybody else&rsquo;s requests.
        </p>
      </div>
    );
  }

  if (!payoutsEnabled()) {
    return (
      <ErrorPanel
        title="Payslips need a database"
        message="Payments are recorded in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  const today = dayOf(new Date().toISOString());
  const [load, read, lgfEmployee] = await Promise.all([
    loadAll(viewer),
    readRequests(viewer.id),
    isLgfEmployee(viewer.usr),
  ]);

  /*
   * An LGF employee earns no share, so there is nothing for them to ask for;
   * the request route refuses them too. Their earlier requests, if any, still
   * show below.
   */
  if (lgfEmployee !== false) {
    return (
      <div className="mx-auto w-full max-w-[900px]">
        <h1 className="font-display text-[26px] leading-[1.05]">My payslip</h1>
        {lgfEmployee === null ? (
          <div className="mt-5">
            <ErrorPanel title="Could not check your account" message="Try again in a moment." hint="" />
          </div>
        ) : (
          <p className="panel mt-5 p-5 text-[13px] text-ink-soft">
            LGF employees are not paid through Ledger, so there is nothing to request here.
          </p>
        )}
        {read.error ? null : <YourRequests rows={requestRows(read.requests)} />}
      </div>
    );
  }

  /*
   * Cards are offered only when both halves of the answer were read: the
   * approvals, and which of them are already spoken for. Without the second, a
   * card already paid for would look ready again, and the page would be
   * inviting a request the database refuses. Nothing offered, with the reason
   * above it, is the honest version of that page.
   */
  const cards =
    !load.error && read.committed
      ? cardsFor(load, viewer.usr, today, read.committed)
      : { ready: [], countingDown: [] };

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">My payslip</h1>
        <p className="plain mt-2.5">
          Once a card you brought in has been approved for {PAYOUT_DAYS} days, you can ask to be paid
          for it. Choose the cards below and request payment whenever you are ready.
        </p>
      </div>

      {load.error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read your approvals" message={load.error} />
        </div>
      ) : null}
      {read.error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read your payment requests" message={read.error} hint="" />
        </div>
      ) : null}

      {!load.error && !read.error ? (
        <>
          <RequestPayment rows={cards.ready} />
          <CountingDown rows={cards.countingDown} />
        </>
      ) : null}

      {read.error ? null : <YourRequests rows={requestRows(read.requests)} />}
    </div>
  );
}

/**
 * This person's requests, and every card committed to any live request.
 *
 * Read together and failed together: the two answer one question between them,
 * which cards are still free to ask for, and half of that answer is worse than
 * none. The committed set is everybody's, not just this person's, because a
 * card is spoken for whoever's request it is on.
 */
async function readRequests(userId: string): Promise<{
  requests: PayoutRequestRecord[];
  committed: Set<string> | null;
  error: string | null;
}> {
  try {
    const [requests, committed] = await Promise.all([
      listPayoutRequestsFor(userId),
      listCommittedConversionIds(),
    ]);
    return { requests, committed, error: null };
  } catch (caught) {
    return {
      requests: [],
      committed: null,
      error: caught instanceof Error ? caught.message : 'Could not read your payment requests.',
    };
  }
}

/** True or false, or null when it could not be read: the caller then offers nothing. */
async function isLgfEmployee(usr: string): Promise<boolean | null> {
  if (!usr) return false;
  try {
    return (await listNoShareKeys()).has(usr);
  } catch (caught) {
    console.error('checking for an LGF employee', caught);
    return null;
  }
}
