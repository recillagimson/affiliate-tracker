/**
 * Editing somebody's account from the People list: what the dialog holds, and
 * what it sends when Save is pressed.
 *
 * Four things can change at once: the name, the email, the role, and the
 * services. Each already has, or now has, its own action on
 * /api/users/[id], and each of those carries its own guards (you cannot
 * change your own role, the last admin cannot be demoted, an admin has no
 * services). So the dialog does not get a route of its own that would have to
 * repeat them. It sends only what changed, one action after another, in an
 * order that makes each write make sense, and stops at the first refusal.
 *
 * Pure: a form in, a list of request bodies out. scripts/account-edit-checks.ts
 * pins it, including that every body is one the route's schema accepts.
 */

import { accessRole, personRole, type PersonRole } from './roles';
import { DEFAULT_SERVICES, normalizeServices, servicesProblem, type Service } from './services';

/** What the dialog holds for one person. */
export type AccountForm = {
  fullName: string;
  email: string;
  role: PersonRole;
  services: Service[];
};

export const MAX_FULL_NAME = 120;

/** The form as it starts, from what is on file. */
export function formFor(row: {
  fullName: string;
  email: string;
  role: 'admin' | 'affiliate';
  lgfEmployee?: boolean;
  services?: readonly Service[];
}): AccountForm {
  return {
    fullName: row.fullName,
    email: row.email,
    role: personRole(row.role, Boolean(row.lgfEmployee)),
    services: normalizeServices(row.services),
  };
}

/** One sentence per field that cannot be saved as it stands. Empty when it can. */
export function accountProblems(form: AccountForm): Record<string, string> {
  const problems: Record<string, string> = {};
  if (form.fullName.trim().length > MAX_FULL_NAME) {
    problems.fullName = `Keep the name to ${MAX_FULL_NAME} characters.`;
  }
  const email = form.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.email = 'Enter a valid email, or leave it blank.';
  // An admin is not onboarded for anything, so their boxes are not shown and
  // whatever the form still holds for them does not count.
  if (accessRole(form.role) !== 'admin') {
    const none = servicesProblem(form.services);
    if (none) problems.services = none;
  }
  return problems;
}

export type AccountStep =
  | { action: 'set-details'; fullName: string; email: string }
  | { action: 'set-role'; role: PersonRole }
  | { action: 'set-services'; services: Service[] };

/**
 * What to send, in order, to turn `before` into `after`. Nothing for a field
 * nobody touched.
 *
 * Details first: they can never be refused for a reason the other two care
 * about. Then the role, and the services last, because whether there is a
 * services write at all depends on what the role ends up as. An account that
 * is an admin afterwards gets none. One that has just stopped being an admin
 * was reading as the default, so it only needs one if the choice differs from
 * that.
 */
export function planAccountSave(before: AccountForm, after: AccountForm): AccountStep[] {
  const steps: AccountStep[] = [];

  const fullName = after.fullName.trim();
  const email = after.email.trim();
  if (fullName !== before.fullName.trim() || email !== before.email.trim()) {
    steps.push({ action: 'set-details', fullName, email });
  }

  if (after.role !== before.role) steps.push({ action: 'set-role', role: after.role });

  if (accessRole(after.role) !== 'admin') {
    const was = accessRole(before.role) === 'admin' ? [...DEFAULT_SERVICES] : normalizeServices(before.services);
    const now = normalizeServices(after.services);
    if (now.join() !== was.join()) steps.push({ action: 'set-services', services: now });
  }

  return steps;
}
