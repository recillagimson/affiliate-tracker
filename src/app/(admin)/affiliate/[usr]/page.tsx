import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApprovalsList } from '@/components/ApprovalsList';
import { EarningsChart } from '@/components/EarningsChart';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LeadsPanel, type LeadRow } from '@/components/LeadsPanel';
import { LinkPending } from '@/components/LinkPending';
import { MonthFilter } from '@/components/MonthFilter';
import { SalesStrip } from '@/components/SalesStrip';
import {
  activeMonths,
  buildEarnings,
  describeConversions,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatRelative,
  HOUSE_KEY,
  initialsOf,
  monthLabel,
  parseMonth,
  PERIODS,
  type Period,
} from '@/lib/analytics';
import { captureFormEnabled } from '@/lib/config';
import { loadAll } from '@/lib/load';
import { approvedCards, approvedLeadIds, cardForLead } from '@/lib/qmp-sync';
import { ownsKey } from '@/lib/scope';
import { normalizeKey } from '@/lib/validate';
import { loadApproveContext } from '@/lib/approve-context';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

const RECENT_APPROVALS = 12;
/**
 * How many of this person's leads are sent to the browser. The panel itself
 * pages through them twelve at a time; this is the ceiling on the payload, so a
 * person with thousands of leads does not turn their own page into a download.
 */
const RECENT_LEADS = 200;

type PageProps = {
  params: Promise<{ usr: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function parsePeriod(raw: string): Period {
  return (PERIODS.find((p) => p.key === raw)?.key ?? 'month') as Period;
}

/**
 * `_house` is the one key that isn't a tracking key — it stands for clicks that
 * arrived with no ?usr= at all. Everything else is normalised the same way the
 * links are, so /affiliate/Arthur resolves to the same page as /affiliate/arthur.
 */
function decodeUsr(raw: string): string {
  const decoded = decodeURIComponent(raw);
  return decoded === HOUSE_KEY ? '' : normalizeKey(decoded);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { usr } = await params;
  return { title: decodeUsr(usr) || 'Unassigned' };
}

export default async function AffiliatePage({ params, searchParams }: PageProps) {
  const { usr: rawUsr } = await params;
  const query = await searchParams;
  const period = parsePeriod(firstValue(query.period));
  // A calendar month, when one is picked. It outranks the period.
  const month = parseMonth(firstValue(query.month));
  const usr = decodeUsr(rawUsr);
  const personKey = usr || HOUSE_KEY;

  const viewer = await requireViewer();
  const isAdmin = viewer.role === 'admin';

  // An affiliate asking for anybody else's page gets the same 404 as a key that
  // was never used. notFound() rather than a redirect or a "forbidden" on
  // purpose: telling someone that a key exists but is not theirs is itself a
  // fact about who else works here and what their key is.
  if (!ownsKey(viewer, usr)) notFound();

  const { links, submissions, visits, conversions, gross, settings, error } = await loadAll(viewer);
  if (error) {
    return <ErrorPanel title="Could not read your data" message={error} />;
  }

  // Cards for this person only. All time is checked separately from the
  // selected window, so a person with no activity *this month* still gets their
  // page (showing an empty window) rather than a 404 that reads as "no such
  // person" — only a key that has never been seen at all is a 404.
  // As on the dashboard: each approval at the rate in force the day it was
  // approved, so a change to the percentage never restates this page.
  const money = { shares: settings.shares, gross };

  const everView = buildEarnings(links, visits, conversions, {
    period: 'all',
    usr: personKey,
    groupBy: 'card',
    ...money,
  });
  if (everView.rows.length === 0) notFound();

  const view = buildEarnings(links, visits, conversions, {
    period,
    month,
    usr: personKey,
    groupBy: 'card',
    ...money,
  });

  const person = everView.people.find((p) => p.usr === personKey);
  const name = person?.name ?? usr;
  // As on the dashboard: "30 days" mid-sentence, "September 2026" as a name.
  const periodLabel = month
    ? monthLabel(month)
    : (PERIODS.find((p) => p.key === period)?.label ?? '30 days');
  const windowLabel = month ? periodLabel : periodLabel.toLowerCase();
  // Only this person's months: a month they had nothing in is an empty page.
  const months = activeMonths(
    visits.filter((row) => (row.usr || HOUSE_KEY) === personKey),
    conversions.filter((row) => (row.usr || HOUSE_KEY) === personKey),
  ).map((key) => ({ key, label: monthLabel(key) }));

  // Leads are passed in so each approval can name the client behind it. They
  // are already scoped to this viewer, so an approval whose lead belongs to
  // somebody else resolves to a dash rather than to a name they may not see.
  const theirApprovals = describeConversions(
    links,
    conversions.filter((row) => (row.usr || HOUSE_KEY) === personKey).slice(0, RECENT_APPROVALS),
    submissions,
    money,
  );

  const theirLinks = links.filter((link) => (link.usr || HOUSE_KEY) === personKey);

  // The people behind the numbers. A visit records no name — only a slug, a
  // key and an IP — so the form is the one place a person's own details are
  // ever captured, and these are the only names this page can honestly show.
  //
  // All time, like the approvals below it and unlike the cards above: a lead is
  // a person you might still call, and hiding one because it arrived 31 days
  // ago would make the period filter mean something quite different here.
  const capture = captureFormEnabled();
  const theirLeads = submissions.filter((row) => (row.usr || HOUSE_KEY) === personKey);
  // Every approval this viewer can see, not the slice shown above: the list is
  // cut to the most recent for reading, and a lead should not go back to
  // pending because its approval scrolled off the end.
  const approvedLeads = approvedLeadIds(conversions);
  // Their cards, by the same reasoning: the one the sync wrote on the lead, or
  // for a lead approved before leads kept one, the cards its approvals name.
  const cardsApproved = approvedCards(conversions);
  // Approve on the leads list, for an admin. See the dashboard.
  const approving = isAdmin && theirLeads.length > 0 ? await loadApproveContext(settings.shares) : undefined;

  const leadRows: LeadRow[] = theirLeads.slice(0, RECENT_LEADS).map((row) => ({
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    campaign: row.campaign,
    slug: row.slug,
    assignee: row.assignee,
    status: row.status,
    card: cardForLead(row, cardsApproved),
    hasApproval: approvedLeads.has(row.id),
    // Formatted here rather than in the browser: a relative time computed on
    // the client renders a different string from the one the server sent.
    age: formatRelative(row.createdAt),
    capturedAt: formatDateTime(row.createdAt),
  }));

  // Leads against visits, both all time, because that pairing is the question
  // the list is opened with: of everyone who clicked, who actually left their
  // details. Counted rather than expressed as a rate — the visit beacon is
  // best-effort, so leads can legitimately outnumber the visits recorded.
  const everVisits = everView.totals.visits;
  const leadSummary =
    theirLeads.length > leadRows.length
      ? `Latest ${leadRows.length} of ${theirLeads.length.toLocaleString()} · all time`
      : `${theirLeads.length.toLocaleString()} lead${theirLeads.length === 1 ? '' : 's'} from ` +
        `${everVisits.toLocaleString()} visit${everVisits === 1 ? '' : 's'} · all time`;

  return (
    <div className="w-full">
      <Link
        href={month ? `/?month=${month}` : period === 'month' ? '/' : `/?period=${period}`}
        className="btn-quiet btn-sm"
      >
        {isAdmin ? '← Back to all people' : '← Back to your dashboard'}
      </Link>

      <div className="rise mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-5">
        <div className="flex min-w-0 items-center gap-5">
          <span aria-hidden className="disc h-20 w-20 flex-none text-[15px]">
            {usr ? initialsOf(name) : 'H'}
          </span>
          <div className="min-w-0">
            {/* A tracking key can be one long unbreakable word, and the avatar
                has already taken 80px of a 320px screen. */}
            <h1 className="font-display leading-[1.05] text-[26px]">
              {name}
            </h1>
            <p className="mt-1.5 text-[13px] text-ink-soft">
              {usr ? `Tracking key usr=${usr}` : 'Clicks that arrived with no usr'} ·{' '}
              {theirLinks.length} link{theirLinks.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {/* Period filter — same windows as the dashboard, kept in the URL. */}
        <nav aria-label="Period" className="flex flex-wrap gap-3">
          {PERIODS.map((option) => (
            <Link
              key={option.key}
              href={
                option.key === 'month'
                  ? `/affiliate/${encodeURIComponent(personKey)}`
                  : `/affiliate/${encodeURIComponent(personKey)}?period=${option.key}`
              }
              className="pill-filter relative"
              data-active={!month && option.key === period}
              aria-current={!month && option.key === period ? 'page' : undefined}
            >
              {option.label}
              {/* Same page, different query string: no route change, so no
                  skeleton. The pill says it is working instead. */}
              <LinkPending />
            </Link>
          ))}
          <MonthFilter months={months} value={month} />
        </nav>
      </div>

      <section className="rise panel mt-5 grid gap-10 p-6 sm:p-8 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="min-w-0">
          {/* Named for what the figure under it actually is: the merchant's
              payout for an admin reading somebody's page, that person's own
              half when they are reading it themselves. */}
          <h2 className="label-cap">
            {usr
              ? `${name.split(' ')[0]}'s ${gross ? 'earnings' : 'affiliate revenue'}`
              : `House ${gross ? 'earnings' : 'affiliate revenue'}`}{' '}
            · {windowLabel}
          </h2>
          {/* See the dashboard hero: clamped so a long total cannot widen the page. */}
          <p className="tnum mt-4 leading-[0.95] text-[28px]">
            {formatMoney(view.totals.earnings)}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <span className="chip chip-gold">{view.totals.approved} approved</span>
            <span className="text-[13px] text-ink-soft">
              from {view.totals.visits.toLocaleString()} visit
              {view.totals.visits === 1 ? '' : 's'}
              {view.rows.length > 0
                ? `, across ${view.rows.length} card${view.rows.length === 1 ? '' : 's'}`
                : ''}
            </span>
          </div>
          <p className="plain-note mt-6">
            {view.rows.length === 0
              ? 'Nothing landed in this window. Try a longer period. The numbers below follow the same dates.'
              : `Everything here is ${usr ? `${name}'s` : 'house'} traffic only. Visits count when the click happens, approvals on the day they were approved.`}
          </p>
        </div>

        <EarningsChart series={view.series} />
      </section>

      <SalesStrip totals={view.totals} gross={gross} windowLabel={windowLabel} />

      {/* Per card — the reason this page exists. Cards rather than a table:
          three or four numbers per row reads better stacked than columned. */}
      <section className="rise panel mt-5 p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="font-display text-[18px]">Card by card</h2>
          <span className="text-[13px] text-ink-soft">{periodLabel}</span>
        </div>

        {view.rows.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-ink-soft">
            No visits or approvals in this window.
          </p>
        ) : (
          <>
            <ul className="mt-5 flex flex-col gap-4">
              {view.rows.map((row) => {
                const earned = row.earnings > 0;
                return (
                  <li
                    key={row.key}
                    className={`${
                      earned ? 'card-row-lit' : 'card-row'
                    } grid gap-x-6 gap-y-4 p-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_130px_170px_200px] lg:items-center`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold" title={row.card}>
                        {row.card}
                      </p>
                      <p className="mt-0.5 text-[12px] text-ink-soft">
                        {row.approved > 0
                          ? `Earning · ${formatPercent(row.approvalRate, 1)} approved`
                          : 'No approvals yet'}
                      </p>
                    </div>
                    <CardStat label="Visits" value={row.visits.toLocaleString()} />
                    <CardStat label="Approved" value={row.approved.toLocaleString()} muted={row.approved === 0} />
                    <CardStat
                      label={gross ? 'Earnings' : 'Revenue'}
                      value={formatMoney(row.earnings)}
                      muted={!earned}
                      display
                    />
                  </li>
                );
              })}
            </ul>

            <div className="mt-5 grid gap-x-6 gap-y-2 border-t-2 border-edge px-1 pt-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_130px_170px_200px] lg:items-center">
              <p className="text-[14px] font-bold">
                Total across {view.rows.length} card{view.rows.length === 1 ? '' : 's'}
              </p>
              <CardStat label="Visits" value={view.totals.visits.toLocaleString()} />
              <CardStat label="Approved" value={view.totals.approved.toLocaleString()} />
              <div className="lg:text-right">
                <span className="label-cap block">{gross ? 'Earnings' : 'Revenue'}</span>
                <span className="mark tnum mt-1 inline-block text-[18px] font-bold">
                  {formatMoney(view.totals.earnings)}
                </span>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Their approvals, all time — the rows behind the earnings figure */}
      <section className="rise panel mt-5 p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="font-display text-[18px]">{usr ? `${name}'s approvals` : 'House approvals'}</h2>
          <span className="text-[13px] text-ink-soft">All time</span>
        </div>

        {/* The dashboard's table, without the Person column: this page is one
            person, and their name down the side of their own rows is a column
            that never changes. Shared rather than copied, so the two lists of
            approvals cannot drift apart. */}
        <ApprovalsList
          rows={theirApprovals}
          canEdit={isAdmin}
          gross={gross}
          showPerson={false}
          empty={`None recorded for ${name} yet.`}
        />
      </section>

      {/* The people themselves. Kept behind the same switch as the dashboard's
          copy, with one exception: leads that were captured while the form was
          on stay readable after it is turned off, because they are still real
          people who are still worth calling. */}
      {capture || theirLeads.length > 0 ? (
        <LeadsPanel
          rows={leadRows}
          total={theirLeads.length}
          canEdit={isAdmin}
          title={usr ? `${name}'s leads` : 'House leads'}
          summary={leadSummary}
          showAssignee={false}
          approving={approving}
          emptyBody={
            usr
              ? `Nobody has filled in the form on ${name}'s links yet.`
              : 'No form fills have arrived without a tracking key.'
          }
        />
      ) : null}
    </div>
  );
}

function CardStat({
  label,
  value,
  muted = false,
  display = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
  display?: boolean;
}) {
  return (
    <div className="lg:text-right">
      <span className="label-cap block">{label}</span>
      <span
        className={`tnum mt-1 block font-semibold ${
          display ? 'font-display text-[18px]' : 'text-[16px]'
        } ${muted ? 'text-ink-dim' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}
