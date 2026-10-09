import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { LinkForm, type KnownPerson } from '@/components/LinkForm';
import { linkKey } from '@/lib/analytics';
import { defaultCampaigns, type CampaignOption } from '@/lib/campaigns';
import { captureFormEnabled, configuredBaseUrl } from '@/lib/config';
import { loadAll } from '@/lib/load';
import { originFromHeaders } from '@/lib/request';
import { getStore, storageStatus } from '@/lib/store';
import { findUserById, listUsers, usersEnabled } from '@/lib/users';
import { requireService } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create a link' };

const STORAGE_NOTE = {
  supabase: 'Written to your database straight away.',
  sheets: 'Written to your Links sheet straight away.',
  local: 'Written to local storage straight away.',
  unconfigured: 'Storage is not configured, so saving will fail until it is.',
} as const;

/**
 * Anyone signed in may make a link. Who it belongs to is the part that is not
 * a free choice: an admin picks from the affiliate accounts, and an affiliate
 * gets themselves and no one else. The form is given a locked person rather
 * than a shorter list, so there is no picker to defeat — and the route it posts
 * to re-decides the same thing server-side regardless of what arrives.
 */
export default async function NewLinkPage() {
  // A card page: an affiliate on tradelines alone is sent to theirs.
  const viewer = await requireService('personal_cards');
  const isAdmin = viewer.role === 'admin';
  const origin = originFromHeaders(await headers(), configuredBaseUrl());

  // Scoped: an affiliate's slug can only ever collide with their own links,
  // because a link is unique on (slug, usr) — so the availability check on the
  // form is complete even though they are only shown their own.
  const { links } = await loadAll(viewer);

  // An affiliate with no tracking key owns nothing and can be given nothing.
  // The database will not produce one, but the page must not offer a form whose
  // only outcome is a refusal.
  if (!isAdmin && !viewer.usr) redirect('/links');

  // Who a link can belong to: the affiliate accounts, each with the tracking
  // key it was given when it was created.
  //
  // This used to be assembled from whoever already owned a link, which meant a
  // link could be created for a key with no account behind it — traffic nobody
  // could sign in and see. Reading the accounts instead makes every new link
  // belong to a real person, and takes the key out of the admin's hands.
  const people: KnownPerson[] = [];
  if (isAdmin && usersEnabled()) {
    try {
      for (const account of await listUsers()) {
        if (account.role !== 'affiliate' || !account.active) continue;
        people.push({
          usr: account.usr,
          assignee: account.fullName || account.username,
          email: account.email,
          username: account.username,
        });
      }
    } catch {
      // A database that will not answer should not take the page down: the form
      // still works for a house link, and the empty state says why it is empty.
    }
  } else if (isAdmin) {
    // No accounts table (Sheets or local storage). Fall back to the people who
    // already own links, so the form is not reduced to house links only.
    const seen = new Map<string, KnownPerson>();
    for (const link of links) {
      if (!link.usr || seen.has(link.usr)) continue;
      seen.set(link.usr, {
        usr: link.usr,
        assignee: link.assignee || link.usr,
        email: link.assigneeEmail,
      });
    }
    people.push(...seen.values());
  }

  /*
   * The offers this link can point at, and where each one sends people.
   *
   * Read here rather than fetched by the form: it is a short list the page
   * already has a server round trip for, and a picker that populates a moment
   * after the form appears invites a submit in between.
   *
   * A store that will not answer falls back to the built-in category names, so
   * the worst case is the form this page had before campaigns had URLs — not a
   * form with no campaigns at all.
   */
  let campaigns: CampaignOption[] = [];
  try {
    campaigns = await getStore().listCampaigns();
  } catch {
    // Fall through to the defaults below.
  }
  if (campaigns.length === 0) campaigns = defaultCampaigns();

  // The affiliate's own name and email, to prefill the fields that carry them.
  // Best effort: none of it decides ownership, which comes from the session.
  let lockedTo: KnownPerson | null = null;
  if (!isAdmin) {
    let account = null;
    if (usersEnabled()) {
      try {
        account = await findUserById(viewer.id);
      } catch {
        // Fall back to what the session already knows.
      }
    }
    lockedTo = {
      usr: viewer.usr,
      assignee: account?.fullName || viewer.username,
      email: account?.email ?? '',
      username: viewer.username,
    };
  }

  return (
    <div className="w-full">
      <LinkForm
        origin={origin}
        campaigns={campaigns}
        people={people}
        lockedTo={lockedTo}
        takenSlugKeys={links.map(linkKey)}
        storageLabel={STORAGE_NOTE[storageStatus()]}
        /* With the capture form hidden the visitor never sees a page of ours,
           so there is nothing to write copy for. */
        capture={captureFormEnabled()}
      />
    </div>
  );
}
