'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { badgeText } from '@/lib/support';

type Item = { href: string; label: string; adminOnly?: boolean; affiliateOnly?: boolean };

const ITEMS: Item[] = [
  { href: '/', label: 'Overview' },
  { href: '/links', label: 'Links' },
  // Not admin-only: an affiliate may create links, but only ever their own.
  // The page hands them themselves instead of a picker, and the route decides
  // ownership again from the session whatever the form posts.
  { href: '/links/new', label: 'Create' },
  // Everyone: an affiliate quoting a card needs to know what it pays as much
  // as an admin does, and none of it is anybody's personal data. Only the
  // upload on that page is admin-only, and the route enforces that itself.
  { href: '/cpa', label: 'Cards' },
  // Everyone, and the same page for both: an affiliate sees their own tickets
  // and an admin sees all of them. The page and the route decide which, from
  // the session.
  { href: '/support', label: 'Support' },
  { href: '/reports', label: 'Reports', adminOnly: true },
  { href: '/users', label: 'People', adminOnly: true },
  // Who is owed what, and by when. Admin-only: it is everybody's money on one
  // page, and the affiliate's half of the same records is their payslip below.
  { href: '/payouts', label: 'Payouts', adminOnly: true },
  { href: '/settings', label: 'Settings', adminOnly: true },
  // Their own pay history. Affiliates only, for the same reason Profile is:
  // an admin has no payslips of their own, and reaches everybody's through
  // Payouts.
  { href: '/payslips', label: 'Payslip', affiliateOnly: true },
  // Their own paperwork. Affiliates only: an admin reaches anybody's, including
  // their own, through People, and a tab that duplicates a page they already
  // have is a tab that makes the row longer for nothing.
  { href: '/profile', label: 'Profile', affiliateOnly: true },
];

/**
 * Hiding a tab is presentation, not protection. Every page behind these
 * re-checks the role server-side, because a hidden link is still a URL anyone
 * can type. This exists so an affiliate is not shown doors that all say no.
 */
export function visibleItems(isAdmin: boolean): Item[] {
  return ITEMS.filter((item) => (isAdmin ? !item.affiliateOnly : !item.adminOnly));
}

/** Which item owns the current URL. `/affiliate/*` belongs to Overview — it is
 *  the page you reach by opening a row there, not a section of its own. */
function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/affiliate');
  if (href === '/links') return pathname === '/links';
  if (href === '/cpa') return pathname.startsWith('/cpa');
  if (href === '/support') return pathname.startsWith('/support');
  if (href === '/reports') return pathname.startsWith('/reports');
  if (href === '/users') return pathname.startsWith('/users');
  if (href === '/payouts') return pathname.startsWith('/payouts');
  if (href === '/payslips') return pathname.startsWith('/payslips');
  if (href === '/settings') return pathname.startsWith('/settings');
  if (href === '/profile') return pathname.startsWith('/profile');
  return pathname.startsWith('/links/new');
}

/**
 * How many support tickets have something this viewer has not read.
 *
 * Nothing at all for zero: a badge that is always there stops being a signal.
 * The number is repeated in words for a screen reader, which would otherwise
 * announce a bare "3" after the tab's name.
 */
function SupportBadge({ count }: { count: number }) {
  const text = badgeText(count);
  if (!text) return null;
  return (
    <span
      data-support-unread={count}
      className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-gold px-1.5 text-[10px] font-semibold leading-[18px] text-ink"
    >
      {text}
      <span className="sr-only"> {count} unread</span>
    </span>
  );
}

/**
 * The header tabs. Hidden on phones, where the bar at the bottom takes over.
 *
 * No gap between them: these are underline tabs, and the underline has to run
 * the width of the label it belongs to with nothing between it and the next
 * one, or the row reads as a set of separate buttons again.
 */
export function Nav({ isAdmin, supportUnread = 0 }: { isAdmin: boolean; supportUnread?: number }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className="hidden items-stretch md:flex">
      {visibleItems(isAdmin).map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(item.href, pathname) ? 'page' : undefined}
          className="pill-tab"
        >
          {item.label}
          {item.href === '/support' ? <SupportBadge count={supportUnread} /> : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The same three destinations pinned to the bottom of a phone screen, where
 * the thumb is. Full-width targets, 17px labels, and a thick bar over the
 * active one so "where am I" survives being read at arm's length.
 */
export function MobileTabs({ isAdmin, supportUnread = 0 }: { isAdmin: boolean; supportUnread?: number }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex items-stretch px-2">
        {visibleItems(isAdmin).map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-xl px-2 pb-3 pt-3"
            >
              <span
                aria-hidden
                className={`h-[2px] w-10 ${active ? 'bg-navy' : 'bg-edge-faint'}`}
              />
              <span
                className={`text-[12px] ${active ? 'font-semibold text-ink' : 'text-ink-dim'}`}
              >
                {item.label}
                {item.href === '/support' ? <SupportBadge count={supportUnread} /> : null}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
