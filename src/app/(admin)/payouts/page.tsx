import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LinkPending } from '@/components/LinkPending';
import { PayoutRequests } from '@/components/PayoutRequests';
import { PendingApprovals } from '@/components/PendingApprovals';
import { describeConversions } from '@/lib/analytics';
import { asAffiliateShare, loadAll } from '@/lib/load';
import { listOnboarding, readBank } from '@/lib/onboarding-store';
import { dayOf, PAYOUT_DAYS } from '@/lib/payout';
import {
  buildPayees,
  buildPending,
  buildRequestRows,
  countRequested,
  indexPeople,
  pendingTabCounts,
  requestFilterFrom,
  tabFrom,
} from '@/lib/payout-admin';
import {
  listCommittedConversionIds,
  listPayoutRequests,
  payoutsEnabled,
} from '@/lib/payout-request-store';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Payouts' };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * What affiliates have asked to be paid, and what they could ask for next.
 *
 * There is no payout schedule any more. Every card runs on its own clock, 45
 * days from the day it was approved, and an affiliate chooses when to ask for
 * the cards that are ready. So this page is two lists rather than a calendar:
 * Requests, the payments somebody has asked for, which are the admin's to make;
 * and Pending, the approved cards nobody has asked for yet, which are not.
 *
 * Both tabs are fetched on every render, whichever is open, because each tab's
 * pill carries the other's count, and a count read from a different moment
 * than the list beside it is a count that disagrees with it. Four reads, each
 * once for everybody: the approvals, the requests, the roster that names them,
 * and which cards are already spoken for.
 */
export default async function PayoutsPage({ searchParams }: PageProps) {
  const viewer = await requireAdmin();
  const query = await searchParams;
  const tab = tabFrom(query.tab);
  // Which section of the Requests tab to show. Read here so the choice
  // survives a reload and can be shared, like every other filter in the app.
  const status = requestFilterFrom(Array.isArray(query.status) ? query.status[0] : query.status);
  const today = dayOf(new Date().toISOString());

  if (!payoutsEnabled()) {
    return (
      <ErrorPanel
        title="Payouts need a database"
        message={
          'Payout requests and the payments made against them are recorded in Supabase. ' +
          'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page.'
        }
        hint=""
      />
    );
  }

  const { links, submissions, conversions, settings, error } = await loadAll(viewer);

  /*
   * An admin reads gross payouts everywhere else in the app. A payout is the
   * other number: what this person is owed, at the rate in force on the day
   * each approval landed. Converted once, here, and described with gross
   * switched off, so no figure on the page can be the merchant's money wearing
   * somebody's name. Request amounts need none of this: they are the shares
   * recorded when the request was made.
   */
  const owedRows = asAffiliateShare(conversions, settings);
  const views = describeConversions(links, owedRows, submissions, {
    shares: settings.shares,
    gross: false,
  });

  let people: Awaited<ReturnType<typeof listOnboarding>> = [];
  let requests: Awaited<ReturnType<typeof listPayoutRequests>> = [];
  let committed = new Set<string>();
  let readError: string | null = null;
  try {
    [people, requests, committed] = await Promise.all([
      listOnboarding(),
      listPayoutRequests(),
      listCommittedConversionIds(),
    ]);
  } catch (caught) {
    readError = caught instanceof Error ? caught.message : 'Could not read the payout requests.';
  }

  const { byUserId, byUsr } = indexPeople(people);
  const rows = buildRequestRows(requests, byUserId, views);

  /*
   * Who each request is going to, for the approve dialog: the roster rows the
   * page already read, with the bank details of the accounts that actually
   * have a request. Only those, and only the unsealed half — the last four
   * digits, never the number — so opening this page cannot become a way to
   * read everybody's account.
   */
  const payeeIds = [...new Set(rows.map((row) => row.userId))].filter(Boolean);
  const banks = readError
    ? []
    : (
        await Promise.all(
          payeeIds.map((id) => readBank(id).catch(() => null)),
        )
      ).filter((bank): bank is NonNullable<typeof bank> => bank !== null);
  const payees = buildPayees(
    people.filter((person) => payeeIds.includes(person.userId)),
    banks,
  );

  /*
   * Pending needs to know which cards are already on a request. Without that
   * read, every card an affiliate has already asked for would be drawn as
   * ready again, which is worse than drawing nothing: it looks like work
   * nobody has done. Same for the approvals themselves. So a failed read
   * leaves the tab to its error panel, and its count off the pill.
   */
  const pending = readError || error ? null : buildPending(views, byUsr, today, committed);
  const requestedCount = readError ? null : countRequested(rows);
  // Both numbers: what can be asked for, and what is still inside its 45 days.
  const pendingTab = pending ? pendingTabCounts(pending) : null;

  return (
    <div className="w-full">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">Payouts</h1>
        <p className="plain mt-3">
          Every card is paid on its own clock: {PAYOUT_DAYS} days after it is approved. An affiliate
          asks to be paid once their cards are ready, which is what shows up here.
        </p>
      </div>

      {/*
        A status filter within one page, so .pill-filter rather than .pill-tab,
        which is the site nav's. Named for what it switches, so a screen reader
        does not hear a second "Sections" landmark beside the real one.
      */}
      <nav aria-label="Payout status" className="mt-5 flex flex-wrap gap-3">
        <Link
          href="/payouts?tab=requests"
          className="pill-filter relative"
          data-active={tab === 'requests'}
          aria-current={tab === 'requests' ? 'page' : undefined}
        >
          Requests
          {requestedCount === null ? null : <span className="tnum text-[11px]">{requestedCount}</span>}
          {/* Same page, different query string: no route change, so no
              skeleton. The pill says it is working instead. */}
          <LinkPending />
        </Link>
        <Link
          href="/payouts?tab=pending"
          className="pill-filter relative"
          data-active={tab === 'pending'}
          aria-current={tab === 'pending' ? 'page' : undefined}
        >
          Pending
          {pendingTab === null ? null : (
            <>
              <span aria-hidden className="tnum text-[11px]">
                {pendingTab.badge}
              </span>
              {/* The pair on the pill is two numbers with nothing to tell them
                  apart, so the name says which is which. */}
              <span className="sr-only">{pendingTab.label}</span>
            </>
          )}
          <LinkPending />
        </Link>
      </nav>

      {error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read the approvals" message={error} />
        </div>
      ) : null}
      {readError ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read the payout requests" message={readError} hint="" />
        </div>
      ) : null}

      {tab === 'requests' ? (
        readError ? null : (
          <PayoutRequests rows={rows} today={today} payees={payees} status={status} />
        )
      ) : pending ? (
        <PendingApprovals {...pending} />
      ) : null}
    </div>
  );
}
