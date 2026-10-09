/**
 * The tradelines reference number: the code, like TL-48213, that says which
 * affiliate sold a tradeline.
 *
 * Everybody onboarded for tradelines has one and nobody shares one. It is what
 * the tradelines checkout will carry, so that a sale is recorded against a
 * person: who sold it, for how much, and so who is owed.
 *
 * The database hands them out, not the app (migration 20261013120000): a
 * trigger gives an account a code the moment tradelines is among its services
 * and it has none. That covers a new account created on tradelines and an
 * existing one that has tradelines added, and no route can forget to. Once
 * given it is never changed, taken away or handed to somebody else, including
 * when tradelines is unticked again: a sale already made has to keep pointing
 * at the person who made it.
 *
 * So the app only ever reads one. This file is what a code looks like, the
 * same shape as the check constraint on users.tradeline_ref.
 *
 * Pure. scripts/tradeline-ref-checks.ts pins it, and reads the migration to
 * make sure the two shapes are the same shape.
 */

/** TL- and five digits. The same pattern, character for character, as the check constraint. */
export const TRADELINE_REF_PATTERN = /^TL-[0-9]{5}$/;

export function isTradelineRef(value: unknown): value is string {
  return typeof value === 'string' && TRADELINE_REF_PATTERN.test(value);
}

/**
 * A stored code, as the app reads it: the code, or '' for somebody who has
 * none. Anything that is not a code reads as none rather than being shown, so
 * a database without the column yet reads as nobody having one.
 */
export function readTradelineRef(value: unknown): string {
  return isTradelineRef(value) ? value : '';
}

/**
 * The link an affiliate hands to a customer: the storefront, with their
 * reference number on it.
 *
 * '' when there is no storefront address yet (TRADELINES_SITE_URL is unset),
 * when they have no number, or when either is not what it should be. The
 * page then says the link is coming rather than showing one that goes nowhere.
 */
export function tradelineLinkFor(siteUrl: string | undefined, ref: string): string {
  const site = (siteUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(site) || !isTradelineRef(ref)) return '';
  return `${site}/?ref=${ref}`;
}
