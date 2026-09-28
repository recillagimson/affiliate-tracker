import type { Metadata } from 'next';
import { OnboardingRail } from '@/components/OnboardingRail';
import { ProfileForm } from '@/components/onboarding/ProfileForm';
import { RevisitNotice } from '@/components/onboarding/StepControls';
import { isBypassed } from '@/lib/approval';
import { nextStep, stepPosition } from '@/lib/onboarding';
import { requireStep } from '@/lib/onboarding-guard';
import { readSmsSettings } from '@/lib/sms-store';
import { findUserById } from '@/lib/users';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your details' };

export default async function WelcomePage() {
  const { viewer, state, revisiting, bypass } = await requireStep('profile');
  // Waived accounts do two of these, not four, and are already inside the app.
  // Both facts change what this page should say to them.
  const waived = isBypassed(bypass);

  // Prefilled from whatever the admin typed when they made the account, which
  // is usually right and always editable. Asking somebody to retype their own
  // name into a form that already knows it reads as a form that is not paying
  // attention. On a return visit it is prefilled from what they themselves
  // saved, for the same reason.
  const account = await findUserById(viewer.id).catch(() => null);
  const sms = await readSmsSettings(viewer.id).catch(() => null);

  // Where "leave without saving" goes: whatever they still owe, or the app.
  const onward = nextStep(state, { bypassed: waived });
  const { index, total } = stepPosition('profile', { bypassed: waived });

  return (
    <div>
      <div className="rise">
        <p className="label-cap">
          Step {index} of {total}
        </p>
        <h1 className="mt-1.5 font-display text-[26px] leading-[1.15]">
          {revisiting || waived ? 'Your details' : 'Welcome. Let’s get you set up.'}
        </h1>
        <p className="plain mt-2.5">
          {revisiting
            ? 'What you told us about yourself. Change anything that is wrong and save, or leave it be.'
            : waived
              ? 'An admin has already let you in, so nothing here is holding anything up. This is who you are, how to reach you, and a password only you know.'
              : 'Four short steps. The first three have to be done before the dashboard opens: the agreement and the W-9 are what make it possible to pay you at all.'}
        </p>
      </div>

      <div className="mt-6">
        <OnboardingRail current="profile" state={state} bypassed={waived} />
      </div>

      {revisiting ? <RevisitNotice what="This is what is on file." /> : null}

      <ProfileForm
        initialName={account?.fullName ?? ''}
        initialEmail={account?.email ?? ''}
        initialPosition={account?.position ?? ''}
        initialMobile={account?.mobile ?? ''}
        initialSmsOptIn={Boolean(sms?.optInAt)}
        revisiting={revisiting}
        continueTo={onward?.path ?? '/'}
        continueLabel={onward ? `Continue to ${onward.label.toLowerCase()}` : 'Go to the dashboard'}
      />
    </div>
  );
}
