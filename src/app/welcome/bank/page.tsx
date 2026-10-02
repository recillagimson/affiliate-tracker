import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { OnboardingRail } from '@/components/OnboardingRail';
import { BankForm } from '@/components/onboarding/BankForm';
import { formatDateTime } from '@/lib/analytics';
import { isBypassed } from '@/lib/approval';
import { maskAccount } from '@/lib/mask';
import { canOpen, previousStep, stepPosition } from '@/lib/onboarding';
import { onboardingFor } from '@/lib/onboarding-guard';
import { readBank } from '@/lib/onboarding-store';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Bank details' };

/**
 * The last step, and the only one that never barred the door.
 *
 * requireStep() is not used here because this page also has to be reachable
 * from the banner inside the app, by somebody who finished everything weeks ago
 * and has since changed bank — a case that has nothing to do with the flow.
 */
export default async function BankPage() {
  const viewer = await requireViewer();
  const { state, applies, bypass } = await onboardingFor(viewer);
  if (!applies) redirect('/');
  /*
   * The waiver has to be passed in here, not assumed away. Without it this
   * check reads the ordinary queue, decides a waived account has not reached
   * step 4, and bounces the one person who was told they could fill this in
   * whenever they liked straight back to step 1.
   */
  const waived = isBypassed(bypass);
  if (!canOpen(state, 'bank', { bypassed: waived })) redirect(waived ? '/profile' : '/welcome');

  // Read whether or not the step is done: a row with no routing number leaves
  // it open, and its name, bank and account number should still be kept.
  const existing = await readBank(viewer.id).catch(() => null);
  const needsRouting = Boolean(existing) && !existing?.routingNumber;
  const back = previousStep('bank', { bypassed: waived });
  const { index, total } = stepPosition('bank', { bypassed: waived });

  return (
    <div>
      <div className="rise">
        <p className="label-cap">
          Step {index} of {total}
        </p>
        <h1 className="mt-1.5 font-display text-[26px] leading-[1.15]">Where the money goes</h1>
        <p className="plain mt-2.5">
          Commission is paid monthly by ACH. This is the account it lands in.
        </p>
      </div>

      <div className="mt-6">
        <OnboardingRail current="bank" state={state} bypassed={waived} />
      </div>

      {needsRouting ? (
        <p role="alert" className="warn-note mt-5">
          <span aria-hidden className="warn-note-mark">
            !
          </span>
          We now need your bank&rsquo;s routing number to send ACH payments. Add it below and save. Your
          account number is already on file, so leave that field empty.
        </p>
      ) : existing ? (
        <div className="panel mt-5 border-leaf-edge bg-leaf-wash p-5">
          <p className="text-[13px] text-ink">
            <span aria-hidden className="mr-1.5 font-semibold text-leaf-text">
              ✓
            </span>
            On file{existing.savedAt ? ` since ${formatDateTime(existing.savedAt)}` : ''}:{' '}
            <strong>{existing.accountName}</strong> at <strong>{existing.bankName}</strong>, routing{' '}
            <span className="tnum">{existing.routingNumber}</span>, account{' '}
            <span className="tnum">{maskAccount(existing.accountLast4)}</span>.
          </p>
          <p className="plain mt-1.5">
            Nothing changes unless you save.{' '}
            <Link href="/" className="link-text">
              Or go to your dashboard
            </Link>
            .
          </p>
        </div>
      ) : null}

      <BankForm
        alreadySaved={Boolean(existing)}
        initialAccountName={existing?.accountName ?? ''}
        initialBankName={existing?.bankName ?? ''}
        initialRoutingNumber={existing?.routingNumber ?? ''}
        accountLast4={existing?.accountLast4 ?? ''}
        backTo={back ? { path: back.path, label: back.label } : undefined}
        continueTo="/"
        continueLabel="Go to the dashboard"
      />

      {!existing ? (
        <p className="plain mt-5">
          Do not have these to hand?{' '}
          <Link href="/" className="link-text">
            Skip for now
          </Link>
          .{' '}
          {waived
            ? 'Nothing is blocking your dashboard either way.'
            : 'Everything else is done, so the dashboard is open to you.'}{' '}
          We will keep asking until this is filled in, because nothing can be paid out without it.
        </p>
      ) : null}
    </div>
  );
}
