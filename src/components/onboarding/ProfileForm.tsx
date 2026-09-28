'use client';

import { useState } from 'react';
import { BusyLabel } from '@/components/Spinner';
import { ContinueLink } from '@/components/onboarding/StepControls';
import { MIN_PASSWORD, profileProblems, type ProfileInput } from '@/lib/onboarding';

/**
 * Step 1: who they are, and a password only they know.
 *
 * The two halves belong together. An account whose password an admin typed out
 * and read aloud is an account that cannot meaningfully sign anything — so the
 * password change is not a separate step to be skipped, it is the same submit
 * as the details, and nothing else in the flow opens until it lands.
 */
export function ProfileForm({
  initialName,
  initialEmail,
  initialPosition = '',
  initialMobile = '',
  initialSmsOptIn = false,
  revisiting = false,
  continueTo = '',
  continueLabel = 'Continue',
}: {
  initialName: string;
  initialEmail: string;
  initialPosition?: string;
  initialMobile?: string;
  /** Whether they have already agreed to approval texts. */
  initialSmsOptIn?: boolean;
  /** Already done once. Changes what the password half asks for. */
  revisiting?: boolean;
  /** Where "leave without saving" goes, when there is anywhere to go. */
  continueTo?: string;
  continueLabel?: string;
}) {
  const [values, setValues] = useState<ProfileInput>({
    fullName: initialName,
    email: initialEmail,
    position: initialPosition,
    mobile: initialMobile,
    smsOptIn: initialSmsOptIn,
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Checked here and again on the server. This half is for the person typing;
    // the other half is the one that counts.
    const problems = profileProblems(values, { passwordSet: revisiting });
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/onboarding/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not save.');
        if (data.fields) setErrors(data.fields);
        return;
      }
      /*
       * The password just changed, which invalidates every session minted
       * under the old one — including this one. The route sends back a fresh
       * cookie, so what follows is a full navigation rather than a soft
       * refresh: it re-reads the session from scratch instead of trusting a
       * cached router state built a moment before the password moved.
       */
      globalThis.location.assign(data.next || '/welcome/agreement');
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mt-5 p-6 sm:p-7" noValidate>
      {error ? (
        <p role="alert" className="warn-note mb-5">
          <span aria-hidden className="warn-note-mark">
            ⚠
          </span>
          <span>{error}</span>
        </p>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Full name</span>
          <input
            className="field mt-1.5"
            value={values.fullName}
            onChange={(e) => set('fullName', e.target.value)}
            placeholder="Arthur Reyes"
            autoComplete="name"
            aria-invalid={errors.fullName ? true : undefined}
          />
          <span className="field-note">As it should appear on your agreement.</span>
          {errors.fullName ? <span className="field-error">{errors.fullName}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Email</span>
          <input
            className="field mt-1.5"
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="arthur@example.com"
            autoComplete="email"
            aria-invalid={errors.email ? true : undefined}
          />
          <span className="field-note">Where we reach you about payments.</span>
          {errors.email ? <span className="field-error">{errors.email}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Position</span>
          <input
            className="field mt-1.5"
            value={values.position}
            onChange={(e) => set('position', e.target.value)}
            placeholder="Affiliate"
            autoComplete="organization-title"
            aria-invalid={errors.position ? true : undefined}
          />
          <span className="field-note">What you do, in your own words.</span>
          {errors.position ? <span className="field-error">{errors.position}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Mobile number</span>
          <input
            className="field mt-1.5"
            type="tel"
            value={values.mobile}
            onChange={(e) => set('mobile', e.target.value)}
            placeholder="+1 415 555 0123"
            autoComplete="tel"
            aria-invalid={errors.mobile ? true : undefined}
          />
          <span className="field-note">Include the country or area code.</span>
          {errors.mobile ? <span className="field-error">{errors.mobile}</span> : null}
        </label>
      </div>

      {/* Unticked until they tick it. This box is the consent the carriers ask
          about, so it is theirs to give, and the wording is what they agreed to. */}
      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0"
          checked={Boolean(values.smsOptIn)}
          onChange={(e) => set('smsOptIn', e.target.checked)}
        />
        <span>
          <span className="field-label">Text me when an approval comes in</span>
          <span className="field-note block">
            A text to the mobile number above each time your approvals land, one per sync. Message
            frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help.
          </span>
        </span>
      </label>

      <div className="mt-6 border-t border-edge-faint pt-6">
        <h2 className="text-[15px] font-semibold">
          {revisiting ? 'Change your password' : 'Choose a password'}
        </h2>
        <p className="plain mt-1">
          {revisiting
            ? 'Only if you want to. Leave both boxes empty and the password you already chose stays as it is.'
            : 'The one you were given was typed by somebody else and is not yours. Replace it now, and nobody but you knows how to sign in as you.'}
        </p>

        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">{revisiting ? 'New password' : 'Password'}</span>
            <input
              className="field mt-1.5"
              type="password"
              value={values.password}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
              aria-invalid={errors.password ? true : undefined}
            />
            <span className="field-note">
              At least {MIN_PASSWORD} characters. A few words you will remember beats a short
              scramble you will not.
            </span>
            {errors.password ? <span className="field-error">{errors.password}</span> : null}
          </label>

          <label className="block">
            <span className="field-label">Type it again</span>
            <input
              className="field mt-1.5"
              type="password"
              value={values.confirmPassword}
              onChange={(e) => set('confirmPassword', e.target.value)}
              autoComplete="new-password"
              aria-invalid={errors.confirmPassword ? true : undefined}
            />
            <span className="field-note">Nothing stores it, so a typo is a reset.</span>
            {errors.confirmPassword ? (
              <span className="field-error">{errors.confirmPassword}</span>
            ) : null}
          </label>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {/* No Back here: this is the first step, and there is nothing behind it. */}
        <button type="submit" className="btn-gold" disabled={busy} aria-busy={busy}>
          <BusyLabel
            busy={busy}
            idle={revisiting ? 'Save changes' : 'Save and continue'}
            busyLabel="Saving…"
          />
        </button>
        {revisiting && continueTo ? (
          <ContinueLink to={continueTo} label={continueLabel} />
        ) : (
          <span className="text-[12px] text-ink-dim">Next: the affiliate agreement.</span>
        )}
      </div>
    </form>
  );
}
