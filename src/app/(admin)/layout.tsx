import Link from 'next/link';
import { MobileTabs, Nav } from '@/components/Nav';
import { SignOutButton } from '@/components/SignOutButton';
// Update pop-up switched off for now; uncomment these, and the lines below, to bring it back.
// import { UpdateNotice } from '@/components/UpdateNotice';
import { ViewAsBanner } from '@/components/ViewAsBanner';
import { authConfigured } from '@/lib/auth';
import { initialsOf } from '@/lib/analytics';
import { storageStatus, type StorageStatus } from '@/lib/store';
import { isBypassed } from '@/lib/approval';
import { stepsFor } from '@/lib/onboarding';
import { requireOnboarded } from '@/lib/onboarding-guard';
// import { currentAnnouncement } from '@/lib/updates';
// import { loginStamp } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

/*
 * The storage badge, which says nothing when there is nothing to say.
 *
 * It used to sit there reading "Database connected" on every page of every
 * working day — a permanent green light confirming that the normal thing was
 * happening, which is a sentence nobody needs twice. The two states left are
 * the ones worth interrupting for: rows going to a file on somebody's laptop,
 * and no store configured at all.
 */
type Badge = { text: string; tone: 'quiet' | 'warn' };

const STORAGE: Partial<Record<StorageStatus, Badge>> = {
  local: { text: 'Local storage', tone: 'quiet' },
  unconfigured: { text: 'Storage not set up', tone: 'warn' },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Undefined on a healthy deployment, which is the point.
  const badge = STORAGE[storageStatus()];
  // Resolved here as well as in each page. The layout renders the navigation,
  // and a nav built from an unverified guess at who is looking is a nav that
  // offers an affiliate the admin tabs.
  //
  // This is also the one door every page in the group is behind, which makes it
  // the right place for the onboarding gate: an affiliate who still owes a
  // signed agreement or W-9 is sent to the step they owe rather than reaching
  // any page inside.
  const { viewer, state, applies, bypass } = await requireOnboarded();
  const isAdmin = viewer.role === 'admin';
  // The one step that nags instead of barring. §2 of the agreement makes a
  // payment impossible without it, so it is worth a standing line — but there
  // are two weeks of Net-15 slack to produce it in, so it is not worth a wall.
  const bankMissing = applies && !state.bank;
  /*
   * A waived account can be missing its own details as well as its bank
   * account, and a banner that only ever mentions one of them would be quietly
   * wrong about the other. So for those it names the count and points at the
   * list. The two waived documents are not counted: nobody is waiting on them.
   */
  const waived = applies && isBypassed(bypass);
  const owed = waived
    ? stepsFor({ bypassed: true }).filter((step) => !state[step.key]).length
    : 0;
  // Every role, admins included. After every sign-in, on whichever page is first.
  // const announcement = currentAnnouncement(isAdmin);
  // const login = announcement ? await loginStamp() : '';

  return (
    <div className="min-h-screen bg-paper">
      {/* Above everything, including the identity bar, because it is the one
          thing that reframes what the identity bar is telling you. */}
      {viewer.actingAs ? (
        <ViewAsBanner
          username={viewer.username}
          usr={viewer.usr}
          adminName={viewer.actingAs.adminName}
        />
      ) : null}

      {/*
        Two bars, and they do different jobs. The navy one is identity — which
        product, which account — and never changes as you move around. The white
        one is location, and it is the only thing that does. Putting both on one
        line is what makes an app's header read as a toolbar of unrelated
        controls.
      */}
      <header className="no-print">
        <div className="flex h-[52px] items-center justify-between gap-6 bg-navy px-5 text-white sm:px-7">
          <Link href="/" className="flex flex-none items-center gap-2.5">
            <span aria-hidden className="h-[18px] w-[18px] flex-none bg-gold" />
            <span className="text-[15px] font-semibold tracking-[0.02em]">Ledger</span>
          </Link>

          <div className="flex min-w-0 items-center gap-4">
            {badge ? (
              <span
                className={`hidden text-[11px] font-semibold uppercase tracking-[0.06em] lg:inline ${
                  badge.tone === 'warn' ? 'text-gold' : 'text-navy-mute'
                }`}
              >
                {badge.text}
              </span>
            ) : null}

            {/* Who you are signed in as. An affiliate sees a filtered version of
                every figure on every page, so the one thing that must never be
                ambiguous is whose numbers these are. */}
            {viewer.open ? null : (
              <span className="flex min-w-0 items-center gap-2.5 border-l border-navy-rule pl-4">
                <span
                  aria-hidden
                  className="flex h-[26px] w-[26px] flex-none items-center justify-center bg-navy-rule text-[10px] font-semibold text-navy-chip"
                >
                  {initialsOf(viewer.username)}
                </span>
                <span className="hidden min-w-0 leading-[1.25] sm:block">
                  <span className="block truncate text-[12px] font-medium">{viewer.username}</span>
                  <span className="block truncate text-[10px] uppercase tracking-[0.05em] text-navy-mute">
                    {isAdmin ? 'Administrator' : `usr=${viewer.usr}`}
                  </span>
                </span>
              </span>
            )}

            {/* Only when there is a session to end. With nothing configured the
                admin surface is open and "Sign out" would do nothing. */}
            {authConfigured() ? <SignOutButton /> : null}
          </div>
        </div>

        <div className="border-b border-edge bg-panel px-5 sm:px-7">
          <Nav isAdmin={isAdmin} />
        </div>
      </header>

      {waived && owed > 0 ? (
        <div className="border-b border-gold-wash bg-gold-faint px-5 py-2.5 sm:px-7">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-soft">
            <span aria-hidden>⚑</span>
            <strong className="font-semibold text-ink">
              {owed === 1 ? 'One thing is still outstanding.' : `${owed} things are still outstanding.`}
            </strong>
            <span>Nothing is blocked, but a payment needs your bank details.</span>
            <Link href="/profile" className="link-text font-medium">
              See what is left
            </Link>
          </p>
        </div>
      ) : bankMissing ? (
        <div className="border-b border-gold-wash bg-gold-faint px-5 py-2.5 sm:px-7">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-soft">
            <span aria-hidden>⚑</span>
            <strong className="font-semibold text-ink">
              We still need your bank details.
            </strong>
            <span>Nothing can be paid out until they are on file.</span>
            <Link href="/welcome/bank" className="link-text font-medium">
              Add them
            </Link>
          </p>
        </div>
      ) : null}

      {/* The tables here are the point of the tool, and a rate card or a QMP
          report has more columns than a reading column can hold — so the page
          runs the full width and every paragraph carries its own measure
          instead.

          pb-24 on phones clears the fixed tab bar; the last panel would
          otherwise sit underneath it at the end of a scroll. */}
      <main className="w-full px-5 pb-24 pt-6 sm:px-7 2xl:px-8 md:pb-14">{children}</main>

      {/* {announcement ? <UpdateNotice update={announcement} login={login} /> : null} */}

      <div className="no-print">
        <MobileTabs isAdmin={isAdmin} />
      </div>
    </div>
  );
}
