import type { Metadata } from 'next';
import { CpaBrowser } from '@/components/CpaBrowser';
import { CpaUpload } from '@/components/CpaUpload';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel } from '@/components/ErrorPanel';
import Link from 'next/link';
import { formatDateTime, formatMoney } from '@/lib/analytics';
import { cardsBelowFloor, ratesAboveFloor, ratesForViewer } from '@/lib/cpa';
import { currentShare, defaultSettings, formatShare, type Settings } from '@/lib/settings';
import { getStore } from '@/lib/store';
import { listNoShareKeys } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';
import type { CpaReport } from '@/lib/types';

/**
 * The rate card: what each card pays for an approval.
 *
 * Readable by everyone signed in, on purpose: an affiliate quoting a card needs
 * to know what it pays as much as an admin does, and none of it is anybody's
 * personal data. Replacing it is admin only, because these are the numbers the
 * whole team quotes from.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Commission per Approvals Reports' };

export default async function CpaPage() {
  const viewer = await requireViewer();
  const isAdmin = viewer.role === 'admin';

  let report: CpaReport | null = null;
  let settings: Settings = defaultSettings();
  let error: string | null = null;
  try {
    [report, settings] = await Promise.all([
      getStore().readCpaReport(),
      getStore().readSettings(),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Unknown storage error';
  }

  /*
   * The floor an admin set on the settings page, applied to the merchant's own
   * rates before anybody is cut out of them, so every reader is looking at the
   * same list of cards. A tiered card that clears it at any tier keeps all of
   * its tiers: see ratesAboveFloor.
   */
  const uploaded = report?.rows ?? [];
  const rates = ratesAboveFloor(uploaded, settings.cpaFloor);
  const hidden = cardsBelowFloor(uploaded, settings.cpaFloor);
  const cards = new Set(rates.map((rate) => `${rate.issuer}|${rate.card}`)).size;
  // What an approval today would pay, which is what the Potential revenue
  // column on this page is worked out at.
  const share = currentShare(settings.shares, new Date().toISOString().slice(0, 10));
  // Only what the table draws crosses to the browser, and for an affiliate that
  // is their half alone — the merchant's rates never reach the page at all.
  const rows = ratesForViewer(rates, isAdmin);
  // An LGF employee earns no share, so "what you earn" would not be true of them.
  const employee =
    !isAdmin && Boolean(viewer.usr) && (await listNoShareKeys().catch(() => new Set<string>())).has(viewer.usr);

  return (
    <div className="w-full">
      <div className="rise">
        <h1 className="font-display leading-[1.05] text-[26px]">
          Commission per Approvals Reports
        </h1>
        <p className="mt-3 max-w-[720px] text-[13px] leading-relaxed text-ink-soft">
          {/* The share is a setting now, so the sentence reads it rather than
              saying "half" whatever it has been changed to. */}
          {isAdmin
            ? `What each card pays for an approval, and ${formatShare(share)} of it beside, which is what the affiliate keeps. LGF employees keep none of it.`
            : employee
              ? 'What an affiliate earns for an approval on each card. As an LGF - Employee you earn no affiliate share: the company keeps the whole payout.'
              : 'What you earn for an approval on each card.'}{' '}
          Where a card is tiered, every tier is listed separately, because the tier is what decides
          the payout.
        </p>

        {/*
          The caveat that has to travel with every figure on this page.

          A rate card reads like a price list, and a price list implies a
          promise. This one is a snapshot of what the merchant pays today, and
          the merchant can revise an amount after an approval has already gone
          through — so the number beside a card is the current rate, not a
          quote. Said once, at the top, rather than as a footnote nobody scrolls
          to.
        */}
        <p className="plain-note mt-4">
          <strong>This can change after the approval.</strong> These are the rates as they stand
          today. An amount can still be revised once an approval has gone through, so treat a figure
          here as what a card pays now rather than a settled payout.
        </p>
      </div>

      {error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read the rate card" message={error} />
        </div>
      ) : null}

      <section className="rise panel mt-5 p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="font-display text-[18px]">
            {rows.length === 0 ? 'Nothing uploaded yet' : `${cards.toLocaleString()} cards`}
          </h2>
          {/* When the rates were read, and when they were put here. Both,
              because they answer different questions: the report day is how
              current the rates are, and the upload is how current this page is
              — and a stale upload of a fresh report is the failure worth
              seeing. */}
          <span className="text-[13px] text-ink-soft">
            {report?.updatedAt
              ? `Updated ${formatDateTime(report.updatedAt)}${
                  report.updatedBy ? ` by ${report.updatedBy}` : ''
                }`
              : 'Never updated'}
          </span>
        </div>

        {/*
          Said only to the admin, and only when it is true. Without it, an
          upload of 73 cards that lists 42 reads as an upload that lost half its
          rows rather than as the floor doing what it was set to do.
        */}
        {isAdmin && hidden > 0 ? (
          <p className="mt-4 text-[12px] text-ink-soft">
            {hidden.toLocaleString()} card{hidden === 1 ? '' : 's'} paying under{' '}
            {formatMoney(settings.cpaFloor ?? 0)} {hidden === 1 ? 'is' : 'are'} not listed. Change
            that on the <Link href="/settings" className="link">settings page</Link>.
          </p>
        ) : null}

        {isAdmin ? <CpaUpload /> : null}

        {rows.length === 0 && !error ? (
          <div className="mt-6">
            {isAdmin ? (
              <EmptyState
                title="No rate card here yet"
                body="Export the CPA report from QMP, save it as CSV, and upload it above. Everyone signed in will be able to read it."
              />
            ) : (
              <EmptyState
                title="No rate card here yet"
                body="Your admin has not uploaded one. Once they do, every card and what it pays will be listed here."
              />
            )}
          </div>
        ) : (
          <CpaBrowser rows={rows} gross={isAdmin} />
        )}
      </section>
    </div>
  );
}
