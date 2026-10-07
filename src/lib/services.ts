/**
 * Which services somebody is onboarded for.
 *
 * There are two things an affiliate can be signed up to work on: personal
 * cards, which is all this app has ever tracked, and tradelines. A person can
 * be on either or both, and an admin decides which when they create the
 * account, and can change it afterwards from that person's page.
 *
 * For now it is a record and nothing more. Links, the rate card, approvals and
 * payouts are all still about cards and do not read this. It exists so that
 * when tradelines get tracking of their own, who it applies to is already on
 * file rather than something to go round asking.
 *
 * Kept on the account as a list (users.services, see migration
 * 20261009120000) rather than as a column per service, so a third service is
 * one more value here and in the check constraint, not another column and
 * another round of every query that names them.
 *
 * Meaningless on an admin, who is not onboarded for anything.
 *
 * Pure. scripts/services-checks.ts pins it, and reads the migration to make
 * sure the two lists are the same list.
 */

/** The same values, in the same order, as the check constraint on users.services. */
export const SERVICES = ['personal_cards', 'tradelines'] as const;
export type Service = (typeof SERVICES)[number];

export const SERVICE_LABELS: Record<Service, string> = {
  personal_cards: 'Personal Cards',
  tradelines: 'Tradelines',
};

/**
 * What everybody was doing before services existed, and so what an account is
 * on when nothing says otherwise: a row from before the column, a new account
 * created without a choice, a list this version cannot read.
 */
export const DEFAULT_SERVICES: readonly Service[] = ['personal_cards'];

export function isService(value: unknown): value is Service {
  return typeof value === 'string' && (SERVICES as readonly string[]).includes(value);
}

/** The services in a list, once each, in the order they are always shown. */
function inOrder(values: readonly unknown[]): Service[] {
  return SERVICES.filter((service) => values.includes(service));
}

/**
 * A stored list, as the app reads it.
 *
 * Anything it does not recognise is dropped rather than trusted, and a list
 * with nothing left in it reads as the default. That makes a database without
 * the column yet, and a value written by a newer version of this app, both
 * read as "personal cards", which is true of everybody until somebody says
 * otherwise. Always a fresh array, so a caller cannot change the default.
 */
export function normalizeServices(value: unknown): Service[] {
  const kept = Array.isArray(value) ? inOrder(value) : [];
  return kept.length > 0 ? kept : [...DEFAULT_SERVICES];
}

/** "Personal Cards, Tradelines". */
export function servicesLabel(services: readonly Service[]): string {
  return inOrder(services)
    .map((service) => SERVICE_LABELS[service])
    .join(', ');
}

/** A list with one box ticked or unticked, as a form holds it. May be empty; servicesProblem says so. */
export function toggleService(services: readonly Service[], service: Service, on: boolean): Service[] {
  const without = services.filter((value) => value !== service);
  return inOrder(on ? [...without, service] : without);
}

/** What is wrong with a choice, or '' when nothing is. Somebody onboarded for nothing is not onboarded. */
export function servicesProblem(services: readonly Service[]): string {
  return inOrder(services).length === 0 ? 'Tick at least one service.' : '';
}
