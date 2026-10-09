/**
 * Who is asking, for a page.
 *
 * Uses cookies(), headers() and redirect(), all of which belong to the React
 * Server Component layer — which is exactly why route handlers get their own
 * entry point in lib/api-auth.ts instead of importing this. The shared logic
 * lives in lib/viewer-core.ts, so "is this session still valid" is written once.
 */

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { canOpenService, homeFor } from './access';
import { authConfigured, readSessionToken, SESSION_COOKIE } from './auth';
import { resolveViewAs, VIEW_AS_COOKIE } from './impersonation';
import { DEFAULT_SERVICES, type Service } from './services';
import { readUserServices } from './users';
import { openViewer, readBasic, resolveSession, type Viewer } from './viewer-core';

export type { Viewer } from './viewer-core';
export { isAdmin } from './viewer-core';

/**
 * Memoised for the life of one request by React's cache(). The layout and the
 * page it wraps both need the viewer, and without this every render would spend
 * a second round trip to Postgres asking the same question.
 */
export const currentViewer = cache(async (): Promise<Viewer | null> => {
  const real = await realViewer();
  if (!real) return null;

  // Applied on top, never instead. A ticket that is missing, expired, forged or
  // held by someone who is not an admin leaves `real` untouched, so the failure
  // direction is always "you are yourself".
  const jar = await cookies();
  return (await resolveViewAs(real, jar.get(VIEW_AS_COOKIE)?.value)) ?? real;
});

/** The session as signed in, before any view-as ticket is considered. */
async function realViewer(): Promise<Viewer | null> {
  if (!authConfigured()) return openViewer();

  const headerBag = await headers();
  const basic = readBasic(headerBag.get('authorization'));
  if (basic) return basic;

  const jar = await cookies();
  const session = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return resolveSession(session);
}

/** For a page that any signed-in person may open. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect('/login');
  return viewer;
}

/**
 * For a page only an admin may open.
 *
 * Sends an affiliate to their own dashboard rather than to an error: these
 * pages are not in their navigation, so arriving at one means a stale bookmark
 * or a typed URL far more often than it means an attempt at something.
 */
export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role !== 'admin') redirect(homeFor(viewer.role, await viewerServices()));
  return viewer;
}

/**
 * What the viewer is onboarded for. Memoised for the request, like the viewer:
 * the layout asks for its tabs and the page asks again for its door.
 *
 * Nothing for an admin, who is onboarded for nothing and opens everything.
 * Personal cards for an affiliate whose services cannot be read, which is what
 * readUserServices says too, so a failed read never opens tradelines.
 */
export const viewerServices = cache(async (): Promise<readonly Service[]> => {
  const viewer = await currentViewer();
  if (!viewer || viewer.role === 'admin') return [];
  if (!viewer.id) return DEFAULT_SERVICES;
  return readUserServices(viewer.id).catch(() => DEFAULT_SERVICES);
});

/**
 * For a page that belongs to one service: the card pages, or tradelines.
 *
 * An admin opens it. An affiliate opens it only if they are onboarded for
 * that service (see lib/access), and is otherwise sent to where they start,
 * for the reason requireAdmin sends them home: the page is not in their
 * navigation, so they are here by a bookmark or a typed address.
 */
export async function requireService(service: Service): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role === 'admin') return viewer;
  const services = await viewerServices();
  if (!canOpenService(viewer.role, services, service)) redirect(homeFor(viewer.role, services));
  return viewer;
}

/**
 * Something that differs between one sign-in and the next, for "once per
 * login" on the page. The session's expiry does: it is set when the token is
 * minted and never slides. '' when there is no session cookie (open, or Basic).
 */
export async function loginStamp(): Promise<string> {
  const jar = await cookies();
  const session = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  return session ? String(session.expiresAt) : '';
}
