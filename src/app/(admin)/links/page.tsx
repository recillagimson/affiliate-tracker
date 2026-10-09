import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LinksBrowser, type LinkRow } from '@/components/LinksBrowser';
import { SharingRule } from '@/components/SharingRule';
import { countsByLink, linkKey } from '@/lib/analytics';
import { captureFormEnabled, configuredBaseUrl } from '@/lib/config';
import { loadAll } from '@/lib/load';
import { originFromHeaders } from '@/lib/request';
import { affiliateUrl } from '@/lib/url';
import { requireService } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Links' };

export default async function LinksPage() {
  // A card page: an affiliate on tradelines alone is sent to theirs.
  const viewer = await requireService('personal_cards');
  const isAdmin = viewer.role === 'admin';
  const { links, submissions, visits, error } = await loadAll(viewer);
  const origin = originFromHeaders(await headers(), configuredBaseUrl());

  if (error) {
    return <ErrorPanel title="Could not read your links" message={error} />;
  }

  const counts = countsByLink(links, submissions, visits);
  const rows: LinkRow[] = links.map((link) => ({
    ...link,
    ...(counts.get(linkKey(link)) ?? { visits: 0, submissions: 0 }),
    url: affiliateUrl(link, origin),
  }));

  const live = links.filter((l) => l.active).length;
  const people = new Set(links.filter((l) => l.usr).map((l) => l.usr)).size;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div>
          <h1 className="font-display text-[26px] leading-[1.15]">
            {isAdmin ? 'Affiliate links' : 'Your links'}
          </h1>
          <p className="mt-2.5 text-[13px] text-ink-soft">
            {links.length === 0
              ? 'Nothing here yet.'
              : `${links.length} link${links.length === 1 ? '' : 's'} · ${live} live, ${
                  links.length - live
                } paused${isAdmin ? ` · ${people} ${people === 1 ? 'person' : 'people'}` : ''}`}
          </p>
        </div>
        {/* Everyone signed in can make a link now. An affiliate's is bound to
            their own key, so the button leads somewhere they are allowed. */}
        <Link href="/links/new" className="btn-gold">
          + New link
        </Link>
      </div>

      {/*
        Where the rule is read is where the link is copied, which is this page.
        Shown whether or not there are any links yet, and to admins as well as
        affiliates: it is a standing rule about how these are shared, not a
        warning about a particular one.
      */}
      <SharingRule />

      {links.length === 0 ? (
        <div className="mt-8">
          {isAdmin ? (
            <EmptyState
              title="No affiliate links yet"
              body="Create one by pairing a destination URL with the person it belongs to. You'll get a shareable link like /cashback?usr=arthur."
              ctaHref="/links/new"
              ctaLabel="Create a link"
            />
          ) : (
            <EmptyState
              title="No links yet"
              body={`Nothing is assigned to usr=${viewer.usr} yet. Make one by pairing a destination with your key, and you'll get a shareable link like /cashback?usr=${viewer.usr}.`}
              ctaHref="/links/new"
              ctaLabel="Create a link"
            />
          )}
        </div>
      ) : (
        // Leads only exist while the capture form is on; with it off the column
        // would sit at zero forever, which reads as a bug rather than a setting.
        <LinksBrowser rows={rows} capture={captureFormEnabled()} canEdit={isAdmin} />
      )}
    </div>
  );
}
