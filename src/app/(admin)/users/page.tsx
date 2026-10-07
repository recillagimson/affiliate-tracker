import type { Metadata } from 'next';
import { ErrorPanel } from '@/components/ErrorPanel';
import { UsersPanel, type AccountRow } from '@/components/UsersPanel';
import { authConfigured } from '@/lib/auth';
import { NO_BYPASS, UNREVIEWED } from '@/lib/approval';
import { NOTHING_DONE } from '@/lib/onboarding';
import { listOnboarding } from '@/lib/onboarding-store';
import { normalizeServices } from '@/lib/services';
import { listLgfEmployeeIds, listUserServices, listUsers, usersEnabled } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'People' };

export default async function UsersPage() {
  const viewer = await requireAdmin();

  if (!usersEnabled()) {
    return (
      <ErrorPanel
        title="Accounts need a database"
        message={
          'Sign-in accounts are stored in Supabase, not in the Google Sheet, because a spreadsheet is the wrong place for a password hash. ' +
          'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page. Until then the built-in ADMIN_USER account is the only way in.'
        }
      />
    );
  }

  // The accounts exist but nothing can mint a session for them. Worth saying
  // here rather than letting someone create three people who then cannot sign
  // in and have no idea why.
  if (!authConfigured()) {
    return (
      <ErrorPanel
        title="Sign-in is not configured"
        message={
          'Accounts can be stored, but no session can be issued for them, so nobody could actually sign in. ' +
          'Set SESSION_SECRET (or ADMIN_PASSWORD) and restart, then come back.'
        }
      />
    );
  }

  /*
   * Who has finished what. Read once for everybody rather than per row: the
   * table wants one column out of it, and twenty round trips to draw twenty
   * ticks would be twenty round trips.
   *
   * A failure here is not a failure of the page — the accounts are still worth
   * listing without their onboarding state — so it degrades to "nothing known"
   * rather than to an error panel.
   */
  const setup = new Map<string, AccountRow['setup']>();
  const approvals = new Map<string, AccountRow['approval']>();
  const bypasses = new Map<string, AccountRow['bypass']>();
  let onboardingRead = true;
  try {
    for (const row of await listOnboarding()) {
      setup.set(row.userId, row.state);
      approvals.set(row.userId, row.approval);
      bypasses.set(row.userId, row.bypass);
    }
  } catch {
    /*
     * Tracked rather than swallowed into an empty map. "No row for this person"
     * and "the read failed" produce the same empty map and mean opposite
     * things: the first is somebody who has not started, the second is nothing
     * known about anybody. Drawing the first when it is the second would print
     * "Not submitted" beside every account on the page, which is a confident
     * wrong answer.
     */
    onboardingRead = false;
  }

  // Which affiliates are LGF employees. Empty rather than an error when it
  // cannot be read: everybody then shows as admin or affiliate, which is true.
  const lgfEmployees = await listLgfEmployeeIds().catch(() => new Set<string>());

  // What each person is onboarded for. An empty map when it cannot be read,
  // and then everybody shows as personal cards, which is the default.
  const services = await listUserServices().catch(() => new Map());

  let rows: AccountRow[];
  try {
    rows = (await listUsers()).map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role,
      lgfEmployee: user.role === 'affiliate' && lgfEmployees.has(user.id),
      services: user.role === 'affiliate' ? normalizeServices(services.get(user.id)) : undefined,
      usr: user.usr,
      fullName: user.fullName,
      email: user.email,
      active: user.active,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      createdBy: user.createdBy,
      setup:
        user.role === 'affiliate' && onboardingRead
          ? (setup.get(user.id) ?? { ...NOTHING_DONE })
          : null,
      approval:
        user.role === 'affiliate' && onboardingRead
          ? (approvals.get(user.id) ?? { ...UNREVIEWED })
          : null,
      bypass:
        user.role === 'affiliate' && onboardingRead
          ? (bypasses.get(user.id) ?? { ...NO_BYPASS })
          : null,
    }));
  } catch (error) {
    return (
      <ErrorPanel
        title="Could not read the accounts"
        message={error instanceof Error ? error.message : 'Unknown error'}
        // Accounts live in Supabase, never in the sheet, so the default hint
        // would point at the wrong system entirely.
        hint="Accounts are stored in Supabase. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and that every migration in supabase/migrations has been applied."
      />
    );
  }

  return (
    <div className="w-full">
      <div className="rise">
        <h1 className="font-display leading-[1.05] text-[26px]">People</h1>
        <p className="mt-3 max-w-[680px] text-[13px] leading-relaxed text-ink-soft">
          Everyone who can sign in. An affiliate or LGF - Employee account is tied to one tracking
          key and sees only the links, leads and earnings recorded against it. An admin sees all of
          it. Change somebody&rsquo;s role, or the services they are onboarded for, from their page.
        </p>
        {viewer.isEnvAdmin ? (
          <p className="plain-note mt-4 max-w-[680px]">
            You are signed in as the built-in <strong>{viewer.username}</strong> account, which
            comes from the environment and is not listed below. It cannot be edited or deleted from
            here, which is what makes it the way back in if these accounts ever go wrong.
          </p>
        ) : null}
      </div>

      <UsersPanel rows={rows} viewerId={viewer.id} viewerUsername={viewer.username} />
    </div>
  );
}
