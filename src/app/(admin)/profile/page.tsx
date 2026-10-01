import type { Metadata } from 'next';
import Link from 'next/link';
import { ApprovalPill } from '@/components/ApprovalPill';
import { formatDateTime } from '@/lib/analytics';
import { isBypassed } from '@/lib/approval';
import { maskAccount, maskTin } from '@/lib/mask';
import { canOpen, isLocked, stepsFor, waivedSteps, type Step, type StepKey } from '@/lib/onboarding';
import { onboardingFor } from '@/lib/onboarding-guard';
import { readAgreement, readBank, readW9 } from '@/lib/onboarding-store';
import { findUserById } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your profile' };

/**
 * Your own paperwork, from inside the app.
 *
 * The four forms already existed, but only as a corridor: you walked them once,
 * in order, before you were let in. That works for somebody arriving through
 * the front door and not at all for somebody an admin waved through, who is
 * already inside and now needs to file a W-9 on Friday and nothing else today.
 *
 * So this is the list rather than the queue. Every item, what state it is in,
 * and a way into each one on its own. It is shown to everybody, not only to
 * waived accounts: "where is the thing I signed" is a reasonable question from
 * anyone, and the answer should not be "you cannot get back to it".
 */
export default async function ProfilePage() {
  const viewer = await requireViewer();
  const { state, applies, approval, bypass } = await onboardingFor(viewer);
  const waived = isBypassed(bypass);
  /*
   * Two lists, because a waiver produces two different kinds of item: things
   * somebody is waiting on, and things nobody is. Both are fillable. Keeping
   * them apart is what stops the second kind reading as work outstanding, and
   * putting the same controls on both is what stops it reading as a door.
   */
  const mine = stepsFor({ bypassed: waived });
  const spare = waivedSteps({ bypassed: waived });
  const approved = approval.status === 'approved';

  /** The two steps that produce a file. The other two produce rows. */
  const pdfFor: Partial<Record<StepKey, string>> = {
    agreement: `/api/onboarding/${encodeURIComponent(viewer.id)}/agreement.pdf`,
    w9: `/api/onboarding/${encodeURIComponent(viewer.id)}/w9.pdf`,
  };

  const [account, agreement, w9, bank] = await Promise.all([
    findUserById(viewer.id).catch(() => null),
    applies ? readAgreement(viewer.id).catch(() => null) : null,
    applies ? readW9(viewer.id).catch(() => null) : null,
    applies ? readBank(viewer.id).catch(() => null) : null,
  ]);

  const detail: Record<StepKey, string> = {
    profile: state.profile
      ? [account?.position, account?.mobile].filter(Boolean).join(', ') || 'On file'
      : 'Your name, how to reach you, and a password of your own.',
    agreement: agreement
      ? `Signed ${formatDateTime(agreement.signedAt)}`
      : 'The terms of the engagement, signed.',
    w9: w9
      ? `Filed ${formatDateTime(w9.signedAt)}, ${maskTin(w9.tinLast4, w9.tinType)}`
      : 'What the IRS needs before anyone can be paid.',
    bank: bank
      ? bank.routingNumber
        ? `${bank.bankName}, routing ${bank.routingNumber}, ${maskAccount(bank.accountLast4)}`
        : `${bank.bankName}, ${maskAccount(bank.accountLast4)}. Add your routing number.`
      : 'Where the ACH payment goes.',
  };

  /* When each document was filed. A waiver settles what was on file when it was
     granted and nothing after it, so the lock needs the date and not just the
     fact that a row exists. */
  const signedOn: Partial<Record<StepKey, string | null>> = {
    agreement: agreement?.signedAt ?? null,
    w9: w9?.signedAt ?? null,
  };

  /*
   * One row, drawn the same way in both lists. Required and merely available
   * differ in what the heading above them says, not in what you can do with
   * them: an item you may fill in gets a button that fills it in.
   */
  function paperworkRow(step: Step) {
    const done = state[step.key];
    const open = canOpen(state, step.key, { bypassed: waived });
    const settled = isLocked(step.key, state, {
      approved,
      reviewedAt: approval.reviewedAt,
      bypassedAt: bypass.at,
      signedAt: signedOn[step.key] ?? null,
    });
    const pdf = done ? pdfFor[step.key] : undefined;
    return (
      <li
        key={step.key}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge-faint px-5 py-4 last:border-b-0"
      >
        <span
          aria-hidden
          className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[2px] text-[11px] font-semibold ${
            done ? 'bg-leaf-wash text-leaf-text' : 'bg-paper-sunk text-ink-dim'
          }`}
        >
          {done ? '✓' : ''}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-ink">{step.label}</span>
          <span className="block text-[12px] text-ink-dim">{detail[step.key]}</span>
        </span>

        {pdf ? (
          <a href={pdf} className="link-text flex-none text-[12px] font-medium">
            Download PDF
          </a>
        ) : null}

        {open ? (
          <Link href={step.path} className="btn-outline btn-sm flex-none">
            {settled ? 'View' : done ? 'Change' : 'Fill it in'}
          </Link>
        ) : (
          <span className="flex-none text-[12px] text-ink-dim">Earlier steps come first</span>
        )}
      </li>
    );
  }

  /*
   * Centred, like the welcome pages this is the sequel to. A 900px column
   * pinned to the left edge of a wide window reads as a page that failed to
   * load the rest of itself.
   */
  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">Your profile</h1>
        <p className="plain mt-2.5">
          {account?.fullName || viewer.username}
          {account?.email ? ` · ${account.email}` : ''}
          {viewer.usr ? (
            <>
              {' · '}
              <span className="tnum">usr={viewer.usr}</span>
            </>
          ) : null}
        </p>
      </div>

      {!applies ? (
        <p className="panel mt-5 p-5 text-[13px] text-ink-soft">
          Onboarding does not apply to this account, so there is nothing to fill in here.
        </p>
      ) : (
        <>
          {waived ? (
            <div className="panel mt-5 border-gold-edge bg-gold-faint p-5 sm:p-6">
              <p className="text-[14px] leading-relaxed text-ink">
                <strong className="font-semibold">An admin has let you straight in.</strong> You do
                not have to finish these before using the dashboard. Work through whichever ones you
                need, in any order.
              </p>
              <p className="plain mt-1.5">
                The agreement and the W-9 are waived, so nobody is waiting on them. You can still
                fill either one in if you would rather have it on file. Your bank details are the
                one thing a payment needs, so they are worth doing before your first one is due.
                {bypass.by ? ` Waived by ${bypass.by}` : ''}
                {bypass.at ? ` on ${formatDateTime(bypass.at)}` : ''}
                {bypass.by || bypass.at ? '.' : ''}
              </p>
            </div>
          ) : (
            <div className="panel mt-5 p-5 sm:p-6">
              <p className="flex flex-wrap items-center gap-3 text-[14px] text-ink">
                <span>Account status</span>
                <ApprovalPill approval={approval} bypass={bypass} />
              </p>
              {approval.status === 'declined' && approval.note ? (
                <p className="plain mt-2">{approval.note}</p>
              ) : null}
            </div>
          )}

          <section className="panel mt-5 overflow-hidden">
            <div className="border-b border-edge px-5 py-3.5">
              <h2 className="text-[15px] font-semibold">Your paperwork</h2>
              <p className="plain mt-1">
                Open any of these to fill it in or change what is there. Nothing is lost by looking.
                The agreement and the W-9 settle once your account does: after that they are yours
                to read and download, and an admin has to be asked to change one.
              </p>
            </div>

            <ul>{mine.map(paperworkRow)}</ul>

            {spare.length > 0 ? (
              <div className="border-t border-edge bg-paper-card">
                <div className="px-5 py-3.5">
                  <p className="text-[13px] font-semibold text-ink">
                    Not required for your account
                  </p>
                  {/* These used to end here, as two greyed lines saying there
                      was nothing to sign. Not required is not the same as not
                      allowed, and only the first was ever meant. */}
                  <p className="plain mt-1">
                    An admin waived these, so nobody is waiting on either one. Fill one in anyway
                    if you would rather have it on file.
                  </p>
                </div>
                <ul className="border-t border-edge-faint">{spare.map(paperworkRow)}</ul>
              </div>
            ) : null}
          </section>

          <p className="plain mt-5">
            Your taxpayer number and bank account number are encrypted. Nobody, including an admin,
            can read either of them back in full from this app.
          </p>
        </>
      )}
    </div>
  );
}
