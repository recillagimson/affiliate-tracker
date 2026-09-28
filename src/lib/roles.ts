import type { Role } from './auth';

/**
 * The roles the People page shows, which are one more than the app enforces.
 *
 * An LGF employee is an affiliate: the same tracking key, onboarding, earnings
 * and scoping, the same everything. What differs is who they are, not what they
 * can see, so the database stores them as role 'affiliate' with lgf_employee
 * set. Every "is this an affiliate" check in the app keeps working for them
 * without knowing this file exists, which is the point: a third access level
 * would mean touching every one of those checks, and missing one would lock
 * somebody out of their own earnings.
 */
export const PERSON_ROLES = ['admin', 'affiliate', 'lgf_employee'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const ROLE_LABELS: Record<PersonRole, string> = {
  admin: 'Admin',
  affiliate: 'Affiliate',
  lgf_employee: 'LGF - Employee',
};

/** What the People page calls somebody, from the two columns that say it. */
export function personRole(role: Role, lgfEmployee: boolean): PersonRole {
  if (role === 'admin') return 'admin';
  return lgfEmployee ? 'lgf_employee' : 'affiliate';
}

/** The access level behind a People-page role. */
export function accessRole(role: PersonRole): Role {
  return role === 'admin' ? 'admin' : 'affiliate';
}
