import type { Metadata } from 'next';
import Link from 'next/link';
import { OnboardingRail } from '@/components/OnboardingRail';
import { formatDateTime } from '@/lib/analytics';
import { maskAccount } from '@/lib/mask';
import { STEPS } from '@/lib/onboarding';
import { requireAwaitingReview } from '@/lib/onboarding-guard';
import { readAgreement, readBank, readW9 } from '@/lib/onboarding-store';
import { findUserById } from '@/lib/users';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Being reviewed' };

/**
 * The wait.
 *
 * Everything is signed and nobody has read it yet. This page exists so that
 * state has somewhere to live: without it, finishing the last form would land
 * on a dashboard that immediately redirects, and the app would look broken at
 * the exact moment somebody has just finished trusting it with their Social
 * Security number.
 *
 * So it says what happens next, shows them what they sent, and leaves every
 * step open to correct. A declined account gets the reason in the same place,
 * because "declined" with nothing after it is a locked door with no handle.
 */
export default async function ReviewPage() {
  const { viewer, state, approval } = await requireAwaitingReview();
  const declined = approval.status === 'declined';

  const [account, agreement, w9, bank] = await Promise.all([
    findUserById(viewer.id).catch(() => null),
    readAgreement(viewer.id).catch(() => null),
    readW9(viewer.id).catch(() => null),
    readBank(viewer.id).catch(() => null),
  ]);

  return (
    <div>
      <div className="rise">
        <p className="label-cap">{declined ? 'Needs another look' : 'Step 4 of 4, done'}</p>
        <h1 className="mt-1.5 font-display text-[26px] leading-[1.15]">
          {declined ? 'We need something changed' : 'That is everything. We are reviewing it.'}
        </h1>
        <p className="plain mt-2.5">
          {declined
            ? 'Someone looked at what you sent and cannot approve it yet. The reason is below. Fix what it asks for and save that step again, and it goes straight back into the queue.'
            : 'Your paperwork is in and an admin is checking it. You will get an email as soon as your account is approved, and your dashboard opens at the same time. Nothing else is needed from you.'}
        </p>
      </div>

      {declined ? (
        <div className="panel mt-5 border-alarm bg-alarm-wash p-5 sm:p-6" role="alert">
          <h2 className="label-cap text-alarm">What needs changing</h2>
          <p className="mt-2.5 text-[14px] leading-relaxed text-ink">
            {approval.note || 'No reason was given. Ask your admin what is missing.'}
          </p>
          {approval.reviewedAt ? (
            <p className="plain mt-3">
              Reviewed {formatDateTime(approval.reviewedAt)}
              {approval.reviewedBy ? ` by ${approval.reviewedBy}` : ''}.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="panel mt-5 border-gold-edge bg-gold-faint p-5 sm:p-6">
          <p className="text-[14px] leading-relaxed text-ink">
            <span aria-hidden className="mr-1.5 font-semibold text-gold-deep">
              ●
            </span>
            Waiting on an admin
            {approval.submittedAt ? (
              <>
                {' since '}
                <span className="tnum">{formatDateTime(approval.submittedAt)}</span>
              </>
            ) : null}
            .
          </p>
          <p className="plain mt-1.5">
            Most accounts are looked at the same working day. If yours has been sitting longer than
            that, chase whoever set it up for you.
          </p>
        </div>
      )}

      <div className="mt-5">
        <OnboardingRail current="bank" state={state} />
      </div>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">What you sent</h2>
        <p className="plain mt-1">
          Anything here can still be changed. Open a step, correct it, and save.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Name" value={account?.fullName ?? ''} />
          <Fact label="Email" value={account?.email ?? ''} />
          <Fact label="Position" value={account?.position ?? ''} />
          <Fact label="Mobile" value={account?.mobile ?? ''} mono />
        </div>

        <dl className="mt-6 divide-y divide-edge-faint border-t border-edge-faint">
          <Row
            label="Affiliate agreement"
            value={
              agreement
                ? `Signed ${formatDateTime(agreement.signedAt)} as ${agreement.affiliateName}`
                : 'Not signed'
            }
            href="/welcome/agreement"
          />
          <Row
            label="Form W-9"
            value={
              w9
                ? `Filed ${formatDateTime(w9.signedAt)}, ${
                    w9.tinType === 'ssn' ? 'SSN' : 'EIN'
                  } ending ${w9.tinLast4 || 'unknown'}`
                : 'Not filed'
            }
            href="/welcome/w9"
          />
          <Row
            label="Bank details"
            value={
              bank
                ? bank.routingNumber
                  ? `${bank.accountName} at ${bank.bankName}, routing ${bank.routingNumber}, ${maskAccount(bank.accountLast4)}`
                  : `${bank.accountName} at ${bank.bankName}, ${maskAccount(bank.accountLast4)}. Routing number still needed.`
                : 'Not on file yet. Nothing can be paid out until it is.'
            }
            href="/welcome/bank"
          />
        </dl>
      </section>

      <p className="plain mt-5">
        {STEPS.length} steps done. You can close this page. We will email{' '}
        {account?.email ? <strong className="text-ink">{account.email}</strong> : 'you'} when your
        account is approved.{' '}
        <Link href="/welcome" className="link-text">
          Or go back to your details
        </Link>
        .
      </p>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <span className="field-label">{label}</span>
      <p className={`mt-1 break-words text-[13px] text-ink-soft ${mono ? 'tnum' : ''}`}>
        {value || 'Not given'}
      </p>
    </div>
  );
}

function Row({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <div className="grid gap-1 py-3.5 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
      <dt className="text-[13px] font-semibold">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] text-ink-soft">{value}</dd>
      <dd className="sm:text-right">
        <Link href={href} className="text-[12px] text-link hover:underline">
          Open
        </Link>
      </dd>
    </div>
  );
}
