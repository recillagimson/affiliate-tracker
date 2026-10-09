/**
 * What somebody may open, from what they are onboarded for.
 *
 * Personal cards and tradelines are two different jobs. An affiliate signed up
 * for one is not shown the other: the card pages (the overview, links, create
 * and the rate card) are for somebody on personal cards, and the tradelines
 * table is for somebody on tradelines. Somebody on both has both. What is not
 * about either, their payslip, support and their own profile, is everybody's.
 *
 * An admin is onboarded for nothing and opens everything.
 *
 * The tabs (components/Nav), the pages (requireService in lib/viewer) and the
 * routes all ask here, so that what is offered and what is allowed cannot
 * come apart.
 *
 * Services are read with normalizeServices before they get here, so a list
 * that could not be read arrives as personal cards. That is the direction to
 * fail in: nobody loses the pages they have always had, and nobody is shown
 * tradelines by accident.
 *
 * Pure. scripts/access-checks.ts pins it.
 */

import type { Service } from './services';

type Role = 'admin' | 'affiliate';

/** Whether this person may open the pages that belong to a service. */
export function canOpenService(role: Role, services: readonly Service[], service: Service): boolean {
  return role === 'admin' || services.includes(service);
}

/**
 * Where this person starts, and where they are sent from a page that is not
 * theirs. The overview is a card page, so somebody on tradelines alone starts
 * on the tradelines table instead.
 */
export function homeFor(role: Role, services: readonly Service[]): string {
  return canOpenService(role, services, 'personal_cards') ? '/' : '/tradelines';
}
