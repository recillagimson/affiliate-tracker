/**
 * What the tradelines storefront is allowed to read.
 *
 * The storefront is a separate, public site: the one affiliates send customers
 * to. It shows the tradelines on offer and what each costs, and it reads them
 * from here, so that the table an admin keeps is the only list there is.
 *
 * Only what a shopper may see goes out. A tradeline with no price is not on
 * offer and is left out, and nothing about who entered a row or when goes with
 * the ones that are. Each row is built field by field rather than copied, so a
 * column added to the table later stays private until somebody adds it here
 * on purpose.
 *
 * Pure. scripts/tradelines-public-checks.ts pins it.
 */

import { storefrontOrigin } from './tradeline-ref';
import { TRADELINE_ISSUERS, type IssuerKey, type Tradeline } from './tradelines';

export type PublicTradeline = {
  id: string;
  issuer: IssuerKey;
  name: string;
  creditLimit: number;
  /** YYYY-MM-DD. */
  openDate: string;
  /** In years, as the text it was entered as. Null when none was given. */
  age: string | null;
  /** What the customer pays, in dollars. Always greater than nought. */
  price: number;
};

export type PublicIssuer = {
  key: IssuerKey;
  label: string;
  /** How many of its tradelines are on offer. */
  count: number;
  /** The lowest price among them, or null when there are none. */
  fromPrice: number | null;
};

export type PublicInventory = { issuers: PublicIssuer[]; tradelines: PublicTradeline[] };

function onOffer(row: Tradeline): row is Tradeline & { userPrice: number } {
  return typeof row.userPrice === 'number' && Number.isFinite(row.userPrice) && row.userPrice > 0;
}

export function publicInventory(rows: readonly Tradeline[]): PublicInventory {
  const tradelines: PublicTradeline[] = rows.filter(onOffer).map((row) => ({
    id: row.id,
    issuer: row.issuer,
    name: row.name,
    creditLimit: row.creditLimit,
    openDate: row.openDate,
    age: row.age,
    price: row.userPrice,
  }));
  const issuers: PublicIssuer[] = TRADELINE_ISSUERS.map((issuer) => {
    const prices = tradelines.filter((row) => row.issuer === issuer.key).map((row) => row.price);
    return {
      key: issuer.key,
      label: issuer.label,
      count: prices.length,
      fromPrice: prices.length > 0 ? Math.min(...prices) : null,
    };
  });
  return { issuers, tradelines };
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

/**
 * The Access-Control-Allow-Origin to answer with, or '' for none.
 *
 * In production it is the storefront's own address (TRADELINES_SITE_URL) and
 * nothing else, whoever asked. Always the same answer, so a cache in front of
 * this route cannot keep one made for somebody else, without the header, and
 * hand it to the storefront. A browser on any other site is told the
 * storefront's address, sees it is not its own, and refuses the response.
 *
 * Outside production a site running on this machine is answered with its own
 * address, so the two can be worked on together.
 */
export function allowedOrigin(origin: string | null, siteUrl: string | undefined, production: boolean): string {
  const site = storefrontOrigin(siteUrl);
  if (!production && origin && LOCAL.test(origin)) return origin;
  return site;
}
