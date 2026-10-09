# Tradelines Storefront and Cart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public storefront where a customer arriving through an affiliate's link browses the live tradelines, picks some and fills a cart, with the affiliate's reference number remembered for the checkout that comes later.

**Architecture:** The tracker (Next 15) gains one public read-only endpoint that returns the priced tradelines, and shows each tradelines affiliate their real link. The storefront (`Tradeline-LGF`, a static Vite + React site) gains client-side routes for issuer pages and a cart, reads inventory from that endpoint, and keeps the cart and the reference number in `localStorage`. All logic lives in small pure modules with tests; pages are thin.

**Tech Stack:** Tracker: Next 15, TypeScript, Supabase, `tsx` check scripts. Storefront: Vite 5, React 18, `react-router-dom` 6, `motion`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-10-10-tradelines-storefront-design.md`

**Two repositories.** Paths below are prefixed:

- `TRACKER/` = `/Users/gimson/Desktop/Development Projects/affiliate-tracker/affiliate-tracker`
- `SITE/` = `/Users/gimson/Desktop/Development Projects/Tradeline-LGF`

## Global Constraints

- The price a customer sees is the tradeline's `userPrice` from the tracker. A tradeline whose price is null or not greater than 0 is never offered.
- The reference number pattern is `^TL-[0-9]{5}$`, the same as `TRADELINE_REF_PATTERN` in `TRACKER/src/lib/tradeline-ref.ts`.
- The reference number never expires and the first one seen is never replaced.
- Quantity is a whole number from 1 to 12. One quantity is three months.
- Nothing is recorded anywhere. The Checkout button is disabled and reads `Checkout coming soon`.
- The public endpoint returns only: `id`, `issuer`, `name`, `creditLimit`, `openDate`, `age`, `price` per tradeline, and `key`, `label`, `count`, `fromPrice` per issuer.
- No em dash or en dash in any text a person reads, in either repository. The tracker's check scripts fail on one.
- Tracker comments follow the file-header style already in `TRACKER/src/lib/*.ts`: what the thing is and why, in plain sentences.
- Commits are local only. Never push. No `Co-Authored-By` or "Generated with" lines in commit messages (owner's standing preference).
- The tracker's `.env.local` points at the live database. Nothing in this plan writes to it. Do not run migrations.
- Four tracker check scripts fail before this work and are not part of it: `payout-api-checks`, `payout-request-store-checks`, `payslip-view-checks`, `updates-checks`. Any other red script is yours.

## Review Focus

1. **A stored cart that is not what the code wrote** (hand-edited, an older shape, `"null"`, a quantity of `"3"` or `999`): the site opens with a usable cart, never a blank page. Pinned in Task 6.
2. **`localStorage` that throws** (Safari private mode, storage blocked): browsing, adding to the cart for the visit, and the link all still work; nothing crashes. Pinned in Tasks 5 and 6.
3. **An inventory response with a bad row** (price as a string, a missing name, an issuer this site does not know): the bad row is dropped and the rest show; totals are never `NaN`. Pinned in Task 7.
4. **A reference number typed or pasted loosely** (`tl-48213`, ` TL-48213 `, `?ref=TL-48213&ref=TL-99999`): case and padding are forgiven, the first parameter is the one read. Pinned in Task 5.
5. **Reloading or opening a deep address directly** (`/tradelines/citi`, `/cart`, `/tradelines/CITI`, `/tradelines/nope`): the right page, or the not-found page, never the host's 404. Pinned in Tasks 4 and 8.

---

## File Structure

Tracker:

| File | Responsibility |
|---|---|
| `TRACKER/src/lib/tradelines-public.ts` (new) | Rows in, public inventory out; which origin may read it. Pure. |
| `TRACKER/src/app/api/public/tradelines/route.ts` (new) | Reads the table, shapes it, sets cache and CORS headers. |
| `TRACKER/src/lib/tradeline-ref.ts` (modify) | Adds `tradelineLinkFor`. |
| `TRACKER/src/components/TradelinesSummary.tsx` (modify) | The panel shows the link when there is one. |
| `TRACKER/src/app/(admin)/tradelines/page.tsx` (modify) | Passes the link to the panel. |
| `TRACKER/scripts/tradelines-public-checks.ts` (new) | Checks for the two pure functions. |

Storefront:

| File | Responsibility |
|---|---|
| `SITE/src/data/issuers.ts` (new) | The six issuers: key, name, logo, colour. |
| `SITE/src/data/content.ts` (modify) | Loses prices, product ids, old store addresses and inventory. |
| `SITE/src/lib/format.ts` (new) | Money, limit, date and age as text. Pure. |
| `SITE/src/lib/ref.ts` (new) | Reads, validates and keeps the reference number. Pure. |
| `SITE/src/lib/cart.ts` (new) | Cart lines, quantities, totals. Pure. |
| `SITE/src/lib/inventory.ts` (new) | Parses and fetches the inventory. Pure parse, thin fetch. |
| `SITE/src/lib/storage.ts` (new) | `localStorage` that never throws. |
| `SITE/src/state/inventory.tsx`, `SITE/src/state/cart.tsx` (new) | React context around the two libs. |
| `SITE/src/pages/HomePage.tsx`, `IssuerPage.tsx`, `CartPage.tsx`, `NotFoundPage.tsx` (new) | The pages. |
| `SITE/src/App.tsx`, `SITE/src/components/Nav.tsx` and the landing components (modify) | Routing, cart badge, links into the site. |
| `SITE/vercel.json` (new) | Serve `index.html` for every path. |

---

### Task 1: Public inventory shape (tracker)

**Files:**
- Create: `TRACKER/src/lib/tradelines-public.ts`
- Test: `TRACKER/scripts/tradelines-public-checks.ts`

**Interfaces:**
- Consumes: `TRADELINE_ISSUERS`, `IssuerKey`, `Tradeline` from `TRACKER/src/lib/tradelines.ts`. `Tradeline` is `{ id: string; issuer: IssuerKey; name: string; creditLimit: number; openDate: string; age: string | null; userPrice: number | null }`.
- Produces:
  - `type PublicTradeline = { id: string; issuer: IssuerKey; name: string; creditLimit: number; openDate: string; age: string | null; price: number }`
  - `type PublicIssuer = { key: IssuerKey; label: string; count: number; fromPrice: number | null }`
  - `type PublicInventory = { issuers: PublicIssuer[]; tradelines: PublicTradeline[] }`
  - `publicInventory(rows: readonly Tradeline[]): PublicInventory`
  - `allowedOrigin(origin: string | null, siteUrl: string | undefined, production: boolean): string`

- [ ] **Step 1: Write the failing check**

Create `TRACKER/scripts/tradelines-public-checks.ts`:

```ts
// What the tradelines storefront is allowed to read.
//
// The storefront is a public site, so this is the one place tradelines leave
// the app without a sign-in. What is pinned is that only what a shopper may
// see goes out: priced tradelines, with nothing about who entered them, and
// that only the storefront's own address may read it from a browser.
//
//   npx tsx scripts/tradelines-public-checks.ts

import { allowedOrigin, publicInventory } from '../src/lib/tradelines-public';
import { TRADELINE_ISSUERS, type Tradeline } from '../src/lib/tradelines';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const rows: Tradeline[] = [
  { id: '1', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2012-04-10', age: '13.38356164', userPrice: 450 },
  { id: '2', issuer: 'capital-one', name: 'Capital One Walmart', creditLimit: 1524, openDate: '2017-12-31', age: null, userPrice: 1250.5 },
  { id: '3', issuer: 'capital-one', name: 'No price yet', creditLimit: 5000, openDate: '2011-04-02', age: '14.4', userPrice: null },
  { id: '4', issuer: 'citi', name: 'Free is not a price', creditLimit: 7500, openDate: '2015-03-03', age: '10.4', userPrice: 0 },
  { id: '5', issuer: 'us-bank', name: 'US Bank A', creditLimit: 9000, openDate: '2010-01-01', age: '15.6', userPrice: 700 },
];

console.log('- what goes out -');
const out = publicInventory(rows);
check('only priced tradelines are offered', out.tradelines.map((row) => row.id).join() === '1,2,5', out.tradelines);
check('the price is the user price', out.tradelines[0]?.price === 450 && out.tradelines[1]?.price === 1250.5);
check('the age is the text as stored', out.tradelines[0]?.age === '13.38356164' && out.tradelines[1]?.age === null);
const fields = 'age,creditLimit,id,issuer,name,openDate,price';
check('a tradeline carries those seven fields and no others', out.tradelines.every((row) => Object.keys(row).sort().join() === fields), Object.keys(out.tradelines[0] ?? {}));
const leaky = publicInventory([{ ...rows[0]!, createdBy: 'marvin', updatedBy: 'marvin' } as Tradeline]);
check('nothing extra on a row is passed through', Object.keys(leaky.tradelines[0] ?? {}).sort().join() === fields);

console.log('- the issuers -');
check('every issuer is there, in the usual order', out.issuers.map((issuer) => issuer.key).join() === TRADELINE_ISSUERS.map((issuer) => issuer.key).join());
const capitalOne = out.issuers.find((issuer) => issuer.key === 'capital-one');
check('the count is of priced tradelines', capitalOne?.count === 2, capitalOne);
check('from is the lowest price', capitalOne?.fromPrice === 450, capitalOne);
const citi = out.issuers.find((issuer) => issuer.key === 'citi');
check('an issuer with nothing priced has none and no from', citi?.count === 0 && citi?.fromPrice === null, citi);
check('an issuer carries those four fields and no others', out.issuers.every((issuer) => Object.keys(issuer).sort().join() === 'count,fromPrice,key,label'));
const none = publicInventory([]);
check('no tradelines at all is six empty issuers', none.tradelines.length === 0 && none.issuers.length === 6 && none.issuers.every((issuer) => issuer.count === 0));

console.log('- who may read it from a browser -');
const SITE = 'https://tradelines.example.com';
check('the storefront may', allowedOrigin(SITE, SITE, true) === SITE);
check('with a trailing slash in the setting', allowedOrigin(SITE, `${SITE}/`, true) === SITE);
check('another site may not', allowedOrigin('https://evil.example.com', SITE, true) === '');
check('nor a lookalike', allowedOrigin(`${SITE}.evil.com`, SITE, true) === '');
check('nobody may when the setting is empty', allowedOrigin(SITE, '', true) === '' && allowedOrigin(SITE, undefined, true) === '');
check('a request with no origin gets no header', allowedOrigin(null, SITE, true) === '');
check('a local site may, outside production', allowedOrigin('http://localhost:5173', SITE, false) === 'http://localhost:5173');
check('and on 127.0.0.1', allowedOrigin('http://127.0.0.1:4173', undefined, false) === 'http://127.0.0.1:4173');
check('but not in production', allowedOrigin('http://localhost:5173', SITE, true) === '');
check('and not something merely starting with localhost', allowedOrigin('http://localhost.evil.com', SITE, false) === '');

console.log(`\ntradelines-public: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to see it fail**

Run (in `TRACKER/`): `npx tsx scripts/tradelines-public-checks.ts`
Expected: `Error: Cannot find module '../src/lib/tradelines-public'`

- [ ] **Step 3: Write the module**

Create `TRACKER/src/lib/tradelines-public.ts`:

```ts
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
 * The Access-Control-Allow-Origin to answer a browser with, or '' for none.
 *
 * The storefront's own address (TRADELINES_SITE_URL) and nothing else. Outside
 * production a site running on this machine may read it too, so the two can be
 * worked on together. Compared whole: an address that merely begins with the
 * storefront's is somebody else's.
 */
export function allowedOrigin(origin: string | null, siteUrl: string | undefined, production: boolean): string {
  if (!origin) return '';
  const site = (siteUrl ?? '').trim().replace(/\/+$/, '');
  if (site && origin === site) return origin;
  if (!production && LOCAL.test(origin)) return origin;
  return '';
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx tsx scripts/tradelines-public-checks.ts`
Expected: `tradelines-public: 21 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/tradelines-public.ts scripts/tradelines-public-checks.ts
git commit -m "feat(tradelines): the shape the storefront may read"
```

---

### Task 2: Public inventory endpoint (tracker)

**Files:**
- Create: `TRACKER/src/app/api/public/tradelines/route.ts`
- Modify: `TRACKER/.env.example` (add `TRADELINES_SITE_URL` under the `# App` section)

**Interfaces:**
- Consumes: `publicInventory`, `allowedOrigin` (Task 1); `listTradelines(): Promise<Tradeline[]>` and `tradelinesEnabled(): boolean` from `TRACKER/src/lib/tradelines-store.ts`.
- Produces: `GET /api/public/tradelines` returning `PublicInventory` as JSON, status 200; `503` with `{ error: string }` when it cannot be read. `OPTIONS` returns 204. The storefront's Task 7 depends on this address and shape.

`TRACKER/src/middleware.ts` gates only the paths in its `matcher`. `/api/public` is not among them and must stay out: that is what makes this route open. Do not edit the middleware.

- [ ] **Step 1: Write the route**

Create `TRACKER/src/app/api/public/tradelines/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { allowedOrigin, publicInventory } from '@/lib/tradelines-public';
import { listTradelines, tradelinesEnabled } from '@/lib/tradelines-store';

/**
 * The tradelines on offer, for the storefront. No sign-in.
 *
 * This is the one route that hands tradelines to somebody who is not signed
 * in, and it is meant to: the storefront is a public site and this is its
 * stock list. It is deliberately absent from the middleware's matcher. What
 * goes out is decided in lib/tradelines-public, which leaves out anything
 * unpriced and everything about who entered a row.
 *
 * Read-only. Kept by a browser and by the edge for a minute, so a busy shop
 * is not a read of the table per page view, and a new paste shows within the
 * minute.
 *
 * Only the storefront's own address may read it from a browser (see
 * allowedOrigin). That is not secrecy, the list is public; it stops another
 * site presenting this stock as its own from a visitor's browser.
 */

export const dynamic = 'force-dynamic';

function headersFor(request: Request): Record<string, string> {
  const origin = allowedOrigin(
    request.headers.get('origin'),
    process.env.TRADELINES_SITE_URL,
    process.env.NODE_ENV === 'production',
  );
  return {
    // The answer depends on who asked, so a cache must not hand one site's to another.
    Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } : {}),
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(request) });
}

export async function GET(request: Request) {
  const headers = headersFor(request);
  if (!tradelinesEnabled()) {
    return NextResponse.json({ error: 'The tradelines are not available right now.' }, { status: 503, headers });
  }
  try {
    const inventory = publicInventory(await listTradelines());
    return NextResponse.json(inventory, {
      headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' },
    });
  } catch {
    // The reason stays in the server log. A shopper is told only that it is not there.
    return NextResponse.json({ error: 'The tradelines are not available right now.' }, { status: 503, headers });
  }
}
```

- [ ] **Step 2: Document the setting**

In `TRACKER/.env.example`, directly after the `NEXT_PUBLIC_BASE_URL=` line, add:

```
# The public address of the tradelines storefront, with no trailing slash, for
# example https://tradelines.letsgetfunded.com. It is the one site allowed to
# read /api/public/tradelines from a browser, and it is what each tradelines
# affiliate's link is built from. Leave blank until the storefront has an
# address: affiliates then see "Coming soon" in place of a link.
TRADELINES_SITE_URL=
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Verify against the running app**

Start the tracker if it is not running: `npm run dev -- -p 3001` (port 3000 belongs to another project on this machine). Then, signed out:

```bash
curl -s -D - -o /dev/null -H 'Origin: http://localhost:5173' http://localhost:3001/api/public/tradelines | grep -i -E '^HTTP|access-control|cache-control|vary'
curl -s http://localhost:3001/api/public/tradelines | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.issuers.length, j.tradelines.length, Object.keys(j.tradelines[0]||{}).sort().join())})"
curl -s -D - -o /dev/null -H 'Origin: https://evil.example.com' http://localhost:3001/api/public/tradelines | grep -i -c 'access-control-allow-origin'
```

Expected: first command shows `HTTP/1.1 200`, `access-control-allow-origin: http://localhost:5173`, `cache-control: public, max-age=60, s-maxage=60`, `vary: Origin`. Second prints `6 <n> age,creditLimit,id,issuer,name,openDate,price` (or `6 0 ` if nothing is priced yet; then say so in the report, because the storefront will look empty). Third prints `0`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/tradelines/route.ts .env.example
git commit -m "feat(tradelines): public read-only stock list for the storefront"
```

---

### Task 3: The affiliate's real link (tracker)

**Files:**
- Modify: `TRACKER/src/lib/tradeline-ref.ts`
- Modify: `TRACKER/src/components/TradelinesSummary.tsx` (`TradelinesSummaryPanel`)
- Modify: `TRACKER/src/app/(admin)/tradelines/page.tsx`
- Test: `TRACKER/scripts/tradeline-ref-checks.ts`, `TRACKER/scripts/tradelines-render-checks.tsx`

**Interfaces:**
- Consumes: `isTradelineRef(value: unknown): value is string` in `tradeline-ref.ts`; `CopyButton({ value, label, idle })`.
- Produces:
  - `tradelineLinkFor(siteUrl: string | undefined, ref: string): string` returning `<site>/?ref=<ref>` or `''`.
  - `TradelinesSummaryPanel` gains an optional prop `link?: string`.

- [ ] **Step 1: Write the failing checks**

In `TRACKER/scripts/tradeline-ref-checks.ts`, add `tradelineLinkFor` to the import from `'../src/lib/tradeline-ref'`, and insert before the `console.log('- the migration -');` line:

```ts
console.log('- the link an affiliate hands out -');
const SITE = 'https://tradelines.example.com';
check('is the storefront with their number on it', tradelineLinkFor(SITE, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('a trailing slash in the setting is not doubled', tradelineLinkFor(`${SITE}/`, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('padding round the setting is ignored', tradelineLinkFor(`  ${SITE} `, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('no storefront address, no link', tradelineLinkFor('', 'TL-48213') === '' && tradelineLinkFor(undefined, 'TL-48213') === '');
check('no number, no link', tradelineLinkFor(SITE, '') === '');
check('something that is not a number, no link', tradelineLinkFor(SITE, 'arthur-smith') === '');
check('an address that is not a web address, no link', tradelineLinkFor('tradelines.example.com', 'TL-48213') === '' && tradelineLinkFor('javascript:alert(1)', 'TL-48213') === '');
```

In `TRACKER/scripts/tradelines-render-checks.tsx`, insert after the `noRef` checks (the line that begins `check('and still their link and figures'`):

```tsx
const linked = render(
  <TradelinesSummaryPanel tradelineRef="TL-48213" link="https://tradelines.example.com/?ref=TL-48213" summary={NONE} />,
);
check('with a storefront, their link is shown whole', linked.includes('https://tradelines.example.com/?ref=TL-48213') && !linked.includes('Coming soon'));
check('and is what gets copied', linked.includes('Copy your link'));
check('their number is still said', linked.includes('TL-48213'));
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx tsx scripts/tradeline-ref-checks.ts`
Expected: a TypeScript/ESM error that `tradelineLinkFor` is not exported.

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradelines-render-checks.tsx`
Expected: `FAIL: with a storefront, their link is shown whole` and `FAIL: and is what gets copied`.

- [ ] **Step 3: Add `tradelineLinkFor`**

Append to `TRACKER/src/lib/tradeline-ref.ts`:

```ts
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
```

- [ ] **Step 4: Show the link in the panel**

In `TRACKER/src/components/TradelinesSummary.tsx`, replace the whole `TradelinesSummaryPanel` function's props and its first `<div className="flex flex-wrap ...">` block (the "Your link" block, up to and including its closing `</div>`) with:

```tsx
export function TradelinesSummaryPanel({
  tradelineRef,
  link = '',
  summary,
}: {
  tradelineRef: string;
  /** Their storefront link, or '' while the storefront has no address. */
  link?: string;
  summary: TradelineSummary;
}) {
  return (
    <section className="rise panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-edge px-5 py-4">
        <div className="min-w-0">
          <h2 className="label-cap text-[10px]">Your link</h2>
          {link ? (
            <p className="tnum mt-1.5 break-all text-[14px] font-medium text-ink">{link}</p>
          ) : (
            <p className="mt-1.5 text-[14px] font-medium text-ink">Coming soon</p>
          )}
          <p className="mt-1 text-[12px] text-ink-dim">
            {link ? (
              <>
                Send this to a customer. What they buy through it is yours, under reference number{' '}
                <span className="tnum font-medium text-ink">{tradelineRef}</span>.
              </>
            ) : tradelineRef ? (
              <>
                Your checkout link is on its way. It will carry your reference number,{' '}
                <span className="tnum font-medium text-ink">{tradelineRef}</span>.
              </>
            ) : (
              'Your checkout link is on its way.'
            )}
          </p>
        </div>
        {link ? (
          <CopyButton value={link} label="Copy your link" idle="Copy link" />
        ) : tradelineRef ? (
          <CopyButton value={tradelineRef} label="Copy your reference number" idle="Copy number" />
        ) : null}
      </div>
```

Leave the rest of the function (`<TradelineFigures>`, the "View all" row, `</section>`) as it is. Update the doc comment above the function: replace the paragraph beginning "The link is a placeholder." with:

```
 * The link is their storefront link once the storefront has an address
 * (lib/tradeline-ref, tradelineLinkFor). Until then it says it is coming
 * rather than showing an address that goes nowhere. Their reference number is
 * shown either way; somebody the database has not given one to is shown none.
```

- [ ] **Step 5: Pass the link from the page**

In `TRACKER/src/app/(admin)/tradelines/page.tsx`:

Add the import: `import { tradelineLinkFor } from '@/lib/tradeline-ref';`

Change the panel line to:

```tsx
      {mine ? (
        <TradelinesSummaryPanel
          tradelineRef={mine.tradelineRef}
          link={tradelineLinkFor(process.env.TRADELINES_SITE_URL, mine.tradelineRef)}
          summary={mine.summary}
        />
      ) : null}
```

- [ ] **Step 6: Run the checks and typecheck**

Run: `npx tsx scripts/tradeline-ref-checks.ts && npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradelines-render-checks.tsx && npm run typecheck`
Expected: `tradeline-ref: 33 passed, 0 failed`, `tradelines-render: 90 passed, 0 failed`, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tradeline-ref.ts src/components/TradelinesSummary.tsx "src/app/(admin)/tradelines/page.tsx" scripts/tradeline-ref-checks.ts scripts/tradelines-render-checks.tsx
git commit -m "feat(tradelines): an affiliate's storefront link, once the storefront has an address"
```

---

### Task 4: Storefront foundations: repository, routing, data clean-up

**Files (all under `SITE/`):**
- Create: `vercel.json`, `.env.example`, `src/data/issuers.ts`, `src/lib/format.ts`, `src/lib/format.test.ts`, `src/pages/HomePage.tsx`, `src/pages/NotFoundPage.tsx`
- Modify: `package.json`, `vite.config.ts`, `src/App.tsx`, `src/main.tsx`, `src/data/content.ts`, `src/components/Nav.tsx`, `Shop.tsx`, `ProductCard.tsx`, `Hero.tsx`, `FinalCta.tsx`, `StickyCta.tsx`, `Pill.tsx`
- Rename: `public/assets/capitalonewebp` to `public/assets/capitalone.webp`

**Interfaces:**
- Produces:
  - `type IssuerKey = 'capital-one' | 'citi' | 'discover' | 'fidelity-elan' | 'pnc' | 'us-bank'`
  - `interface Issuer { key: IssuerKey; name: string; logo: string; color: string }`
  - `ISSUERS: Issuer[]`, `issuerByKey(key: string | undefined): Issuer | null` (case-insensitive)
  - `formatMoney(amount: number): string` (`$1,250.50`), `formatLimit(amount: number): string` (`$1,524`), `formatOpenDate(iso: string): string` (`10 Apr 2012`), `formatAge(age: string | null): string` (`13.38 yrs`, or `Not given`)
  - Routes `/`, `/tradelines/:issuer`, `/cart`, `*`. Tasks 8 and 9 replace the two placeholders registered here.

- [ ] **Step 1: Make it a repository**

```bash
cd "/Users/gimson/Desktop/Development Projects/Tradeline-LGF"
git init -b main
printf '\n.playwright-mcp\n_shots*.cjs\n*.png\n!src/assets/*.png\n' >> .gitignore
git mv -k public/assets/capitalonewebp public/assets/capitalone.webp 2>/dev/null || mv public/assets/capitalonewebp public/assets/capitalone.webp
git add -A && git commit -m "chore: the landing page as it stands"
```

- [ ] **Step 2: Add the dependencies and the test runner**

```bash
npm install react-router-dom@^6.26.0
npm install -D vitest@^2.1.0
```

In `package.json` scripts, add `"test": "vitest run"`.

Replace `vite.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The libs are pure, so they are tested without a browser.
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

Create `vercel.json`:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

Create `.env.example`:

```
# Where the stock list is read from: the affiliate tracker's address, with no
# trailing slash. Locally that is the tracker's dev server.
VITE_TRACKER_URL=http://localhost:3001
```

Copy it for local work: `cp .env.example .env.local` (`*.local` is already ignored).

- [ ] **Step 3: Write the failing format tests**

Create `src/lib/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatAge, formatLimit, formatMoney, formatOpenDate } from './format';

describe('formatMoney', () => {
  it('is to the cent', () => {
    expect(formatMoney(450)).toBe('$450.00');
    expect(formatMoney(1250.5)).toBe('$1,250.50');
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('never shows NaN', () => {
    expect(formatMoney(Number.NaN)).toBe('$0.00');
  });
});

describe('formatLimit', () => {
  it('is whole dollars with commas', () => {
    expect(formatLimit(500)).toBe('$500');
    expect(formatLimit(1524)).toBe('$1,524');
  });
});

describe('formatOpenDate', () => {
  it('reads as a date', () => {
    expect(formatOpenDate('2012-04-10')).toBe('10 Apr 2012');
    expect(formatOpenDate('2017-12-31')).toBe('31 Dec 2017');
  });
  it('does not shift a day in any timezone', () => {
    expect(formatOpenDate('2011-01-01')).toBe('1 Jan 2011');
  });
  it('gives back what it cannot read', () => {
    expect(formatOpenDate('soon')).toBe('soon');
  });
});

describe('formatAge', () => {
  it('is two decimals and says years', () => {
    expect(formatAge('13.38356164')).toBe('13.38 yrs');
    expect(formatAge('16.10')).toBe('16.10 yrs');
    expect(formatAge('7')).toBe('7.00 yrs');
  });
  it('says so when there is none', () => {
    expect(formatAge(null)).toBe('Not given');
    expect(formatAge('')).toBe('Not given');
    expect(formatAge('old')).toBe('Not given');
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./format`.

- [ ] **Step 4: Write `format.ts` and `issuers.ts`**

Create `src/lib/format.ts`:

```ts
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "$1,250.50". Nought rather than NaN for something that is not a number. */
export function formatMoney(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A credit limit: "$1,524". Limits are whole dollars. */
export function formatLimit(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * "10 Apr 2012" from "2012-04-10". Read from the text, not through Date, so a
 * visitor west of Greenwich is not shown the day before.
 */
export function formatOpenDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** "13.38 yrs" from the tracker's "13.38356164". */
export function formatAge(age: string | null): string {
  const years = age === null || age.trim() === '' ? Number.NaN : Number(age);
  return Number.isFinite(years) ? `${years.toFixed(2)} yrs` : 'Not given';
}
```

Create `src/data/issuers.ts`:

```ts
/** The six institutions, keyed the way the tracker keys them. */
export type IssuerKey = 'capital-one' | 'citi' | 'discover' | 'fidelity-elan' | 'pnc' | 'us-bank';

export interface Issuer {
  key: IssuerKey;
  name: string;
  logo: string;
  color: string;
}

export const ISSUERS: Issuer[] = [
  { key: 'capital-one', name: 'Capital One', logo: '/assets/capitalone.webp', color: '#004977' },
  { key: 'citi', name: 'Citi', logo: '/assets/citi.webp', color: '#0f6cbd' },
  { key: 'discover', name: 'Discover', logo: '/assets/discover.webp', color: '#ff6000' },
  { key: 'fidelity-elan', name: 'Fidelity/Elan', logo: '/assets/Fidelity.webp', color: '#368727' },
  { key: 'pnc', name: 'PNC', logo: '/assets/pnc.webp', color: '#ef7622' },
  { key: 'us-bank', name: 'US Bank', logo: '/assets/usbank.webp', color: '#0c2074' },
];

/** The issuer an address names, whatever its case, or null. */
export function issuerByKey(key: string | undefined): Issuer | null {
  const wanted = (key ?? '').trim().toLowerCase();
  return ISSUERS.find((issuer) => issuer.key === wanted) ?? null;
}
```

Run: `npm test`
Expected: PASS, 8 tests.

- [ ] **Step 5: Strip the hard-coded shop data**

In `src/data/content.ts` delete: `BASE`, `PriceFilter`, `SortKey`, `Product`, `RAW_PRODUCTS`, `PRODUCTS`, `COUNT_LABEL`, `InventoryItem`, `RAW_INVENTORY`, `INVENTORY`, `PRICE_FILTERS`, `SORT_OPTIONS`. Keep `PHONE_DISPLAY`, `PHONE_HREF`, `VIDEO_URL`, `Step`, `STEPS`, `Faq`, `FAQS`.

Replace the FAQ entry whose question is `Why are prices different between banks?` with:

```ts
  {
    q: 'Why are prices different?',
    a: 'Each tradeline is priced on its own. The institution, the age of the account and its credit limit all count, and every price is shown beside the tradeline before you add it to your cart.',
  },
```

- [ ] **Step 6: Point the landing page into the site**

`src/components/ProductCard.tsx`, whole file:

```tsx
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import type { Issuer } from '../data/issuers';
import { SPRING_LAYOUT, SPRING_PRESS, SPRING_UI } from './motion';

const MotionLink = motion.create(Link);

/** An institution's tile; the whole card opens that institution's tradelines. */
export function ProductCard({ issuer }: { issuer: Issuer }) {
  return (
    <MotionLink
      layout="position"
      to={`/tradelines/${issuer.key}`}
      className="product-card"
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.98 }}
      transition={{ ...SPRING_UI, layout: SPRING_LAYOUT, scale: SPRING_PRESS }}
    >
      <img className="product-logo" src={issuer.logo} alt={`${issuer.name} logo`} loading="lazy" />
      <span className="product-name">{issuer.name} Tradeline</span>
    </MotionLink>
  );
}
```

In `src/components/Shop.tsx`: import `ISSUERS` from `'../data/issuers'` instead of `PRODUCTS`, map `ISSUERS.map((issuer) => (<RevealItem key={issuer.key}><ProductCard issuer={issuer} /></RevealItem>))`, change the lede to `Choose a bank to see every tradeline we have in stock for it, with its price.`, and fix the comment to `/** The six institutions. Each opens its own page of tradelines. */`.

In `src/components/Hero.tsx`: remove the `PRODUCTS` import and the `lowestPrice` constant; the stats line becomes `Capital One, Citi, Discover, Fidelity/Elan, PNC, US Bank`.

In `src/components/FinalCta.tsx`: the lede becomes `Six institutions in stock today.`

In `src/components/StickyCta.tsx`: the span becomes `Seasoned tradelines, in stock`.

(A live "from" price in these three places is Task 10, once the inventory exists.)

- [ ] **Step 7: Routing, the home page and the not-found page**

Create `src/pages/HomePage.tsx`:

```tsx
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Faq } from '../components/Faq';
import { FinalCta } from '../components/FinalCta';
import { Hero } from '../components/Hero';
import { HowItWorks } from '../components/HowItWorks';
import { Shop } from '../components/Shop';
import { StickyCta } from '../components/StickyCta';
import { VideoSection } from '../components/VideoSection';

/** The landing page. Arriving with a #section in the address scrolls to it. */
export function HomePage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <>
      <main>
        <Hero />
        <VideoSection />
        <HowItWorks />
        <Shop />
        <Faq />
        <FinalCta />
      </main>
      <StickyCta />
    </>
  );
}
```

Create `src/pages/NotFoundPage.tsx`:

```tsx
import { Link } from 'react-router-dom';

/** An address that is not a page here. */
export function NotFoundPage() {
  return (
    <main className="page">
      <div className="page-inner page-narrow">
        <p className="eyebrow">Page not found</p>
        <h1 className="page-title">That page is not here.</h1>
        <p className="section-lede">The address may be mistyped, or the page may have moved.</p>
        <p className="page-actions">
          <Link to="/#shop" className="btn">
            See available tradelines
          </Link>
        </p>
      </div>
    </main>
  );
}
```

Replace `src/App.tsx`:

```tsx
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Footer } from './components/Footer';
import { Nav } from './components/Nav';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

/** A new page starts at its top, unless the address names a section. */
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function Shell() {
  const { pathname } = useLocation();
  return (
    <>
      <ScrollToTop />
      <Nav isHome={pathname === '/'} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/tradelines/:issuer" element={<NotFoundPage />} />
        <Route path="/cart" element={<NotFoundPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Footer />
    </>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </MotionConfig>
  );
}
```

Replace `src/components/Nav.tsx`:

```tsx
import { Link } from 'react-router-dom';
import logo from '../assets/logo.png';
import logoWhite from '../assets/logo-white.png';
import { useScrollState } from '../hooks/useScrollState';

interface NavProps {
  isHome: boolean;
}

/** Fixed nav: transparent with white text over the hero, frosted once scrolled or on inner pages. */
export function Nav({ isHome }: NavProps) {
  const { top } = useScrollState();
  const transparent = isHome && top;

  return (
    <nav className="nav" data-top={transparent}>
      <div className="nav-inner">
        <Link to="/" className="nav-logo">
          <img src={transparent ? logoWhite : logo} alt="Let's Get Funded" />
        </Link>
        <div className="nav-right">
          <Link to="/#video" className="nav-link">
            Watch first
          </Link>
          <Link to="/#how" className="nav-link">
            How it works
          </Link>
          <Link to="/#faq" className="nav-link">
            FAQ
          </Link>
          <Link to="/#shop" className="btn-pill">
            Shop tradelines
          </Link>
        </div>
      </div>
    </nav>
  );
}
```

In `src/components/Pill.tsx`, `PrimaryButton` and `PillLink` keep rendering `motion.a` (they are used for same-page `#shop` anchors on the home page, where a plain anchor is right). Leave them.

Append to `src/styles/global.css`, before the `@media print` block:

```css
/* ---------- Inner pages ---------- */
.page {
  flex: 1;
  padding: 120px 0 96px;
  background: var(--bg);
}

.page-inner {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: 0 var(--page-pad);
}

.page-narrow {
  max-width: 720px;
}

.page-title {
  font-size: clamp(34px, 5vw, 52px);
  font-weight: 800;
  font-style: italic;
  letter-spacing: -0.03em;
  line-height: 1.05;
  margin: 8px 0 16px;
  text-wrap: balance;
}

.page-actions {
  margin-top: 32px;
}
```

- [ ] **Step 8: Build, test, and check deep addresses**

Run: `npm test && npm run build`
Expected: tests pass; `tsc --noEmit` reports nothing (it will name any component still importing a deleted export; fix those by the rule in Step 6); the build completes.

Run `npm run dev`, then confirm in a browser or with `curl -s http://localhost:5173/tradelines/citi | grep -c 'id="root"'` (expected `1`): `/`, `/cart`, `/tradelines/citi` and `/nope` all return the app, the last three showing "That page is not here." for now, and `/#faq` scrolls to the FAQ.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: routes, issuer data keyed like the tracker, and no hard-coded stock"
```

---

### Task 5: The reference number (storefront)

**Files (under `SITE/`):**
- Create: `src/lib/storage.ts`, `src/lib/ref.ts`, `src/lib/ref.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces:
  - `type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - `safeStore(): Store` — `localStorage` when it works, otherwise an in-memory store for the visit. Never throws.
  - `REF_KEY = 'lgf.ref'`
  - `readRef(raw: string | null | undefined): string` — the number, trimmed and upper-cased, or `''`.
  - `captureRef(search: string, store: Store): { ref: string; search: string }` — saves a first valid number, returns the number now held and the search string with every `ref` removed.
  - `savedRef(store: Store): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ref.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { captureRef, readRef, REF_KEY, savedRef } from './ref';
import type { Store } from './storage';

function memory(initial: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const broken: Store = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('readRef', () => {
  it('accepts TL- and five digits', () => {
    expect(readRef('TL-48213')).toBe('TL-48213');
  });
  it('forgives case and padding', () => {
    expect(readRef('tl-48213')).toBe('TL-48213');
    expect(readRef('  TL-48213 ')).toBe('TL-48213');
  });
  it('refuses anything else', () => {
    for (const bad of ['', null, undefined, 'TL-4821', 'TL-482130', '48213', 'TL48213', 'TL-4821a', 'arthur', '<script>']) {
      expect(readRef(bad)).toBe('');
    }
  });
});

describe('captureRef', () => {
  it('keeps a number that arrives on the link', () => {
    const store = memory();
    expect(captureRef('?ref=TL-48213', store)).toEqual({ ref: 'TL-48213', search: '' });
    expect(store.data[REF_KEY]).toBe('TL-48213');
  });
  it('takes it off the address and leaves everything else', () => {
    expect(captureRef('?utm_source=fb&ref=TL-48213&x=1', memory()).search).toBe('?utm_source=fb&x=1');
  });
  it('reads the first when there are two, and removes both', () => {
    expect(captureRef('?ref=TL-48213&ref=TL-99999', memory())).toEqual({ ref: 'TL-48213', search: '' });
  });
  it('the first affiliate keeps the customer', () => {
    const store = memory({ [REF_KEY]: 'TL-11111' });
    expect(captureRef('?ref=TL-48213', store).ref).toBe('TL-11111');
    expect(store.data[REF_KEY]).toBe('TL-11111');
  });
  it('never drops a saved number for arriving without one', () => {
    const store = memory({ [REF_KEY]: 'TL-11111' });
    expect(captureRef('', store)).toEqual({ ref: 'TL-11111', search: '' });
    expect(captureRef('?page=2', store)).toEqual({ ref: 'TL-11111', search: '?page=2' });
  });
  it('ignores a malformed number but still cleans the address', () => {
    const store = memory();
    expect(captureRef('?ref=nonsense', store)).toEqual({ ref: '', search: '' });
    expect(REF_KEY in store.data).toBe(false);
  });
  it('a saved value that is not a number is replaced by a good one', () => {
    const store = memory({ [REF_KEY]: 'garbage' });
    expect(captureRef('?ref=TL-48213', store).ref).toBe('TL-48213');
  });
  it('still reads the link when storage is blocked', () => {
    expect(captureRef('?ref=TL-48213', broken)).toEqual({ ref: 'TL-48213', search: '' });
  });
});

describe('savedRef', () => {
  it('is the number held, or nothing', () => {
    expect(savedRef(memory({ [REF_KEY]: 'TL-48213' }))).toBe('TL-48213');
    expect(savedRef(memory())).toBe('');
    expect(savedRef(memory({ [REF_KEY]: 'garbage' }))).toBe('');
    expect(savedRef(broken)).toBe('');
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./ref`.

- [ ] **Step 2: Write `storage.ts` and `ref.ts`**

Create `src/lib/storage.ts`:

```ts
/** The two things this site asks of a store. */
export type Store = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * localStorage when it works, and a store that lasts the visit when it does
 * not. Private windows and blocked site data make localStorage throw, and a
 * shop that goes blank over that has lost a customer for nothing.
 */
export function safeStore(): Store {
  const memory = new Map<string, string>();
  const fallback: Store = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  };
  try {
    const real = window.localStorage;
    const probe = 'lgf.probe';
    real.setItem(probe, '1');
    real.removeItem(probe);
    return real;
  } catch {
    return fallback;
  }
}
```

Create `src/lib/ref.ts`:

```ts
import type { Store } from './storage';

/**
 * The affiliate reference number a customer arrived with.
 *
 * An affiliate's link is this site with ?ref=TL-48213 on it. The number is
 * kept in the customer's browser so that whatever they buy, on this visit or
 * a later one, is that affiliate's sale.
 *
 * It does not expire, and the first affiliate keeps the customer: a later
 * link carrying somebody else's number does not replace it. It is not checked
 * against anything here. The checkout does that when an order is made.
 */

/** The same pattern the tracker gives them out in. */
const REF_PATTERN = /^TL-[0-9]{5}$/;

export const REF_KEY = 'lgf.ref';

/** A reference number, tidied, or '' if it is not one. */
export function readRef(raw: string | null | undefined): string {
  const tidy = (raw ?? '').trim().toUpperCase();
  return REF_PATTERN.test(tidy) ? tidy : '';
}

/** The number this browser is holding, or ''. */
export function savedRef(store: Store): string {
  try {
    return readRef(store.getItem(REF_KEY));
  } catch {
    return '';
  }
}

/**
 * Read a link's ?ref, keep it if this browser holds none, and hand back the
 * address without it. Taken off so that a customer who copies the address to
 * a friend does not pass the number on by accident.
 */
export function captureRef(search: string, store: Store): { ref: string; search: string } {
  const params = new URLSearchParams(search);
  const arriving = readRef(params.get('ref'));
  params.delete('ref');
  const rest = params.toString();

  const held = savedRef(store);
  const ref = held || arriving;
  if (!held && arriving) {
    try {
      store.setItem(REF_KEY, arriving);
    } catch {
      // Nowhere to keep it. It still counts for this page.
    }
  }
  return { ref, search: rest ? `?${rest}` : '' };
}
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Capture it on arrival**

In `src/App.tsx`, add inside `Shell`, above the `return`:

```tsx
  const location = useLocation();
  const navigate = useNavigate();
  // Once, on arrival. Whatever page the link opens on.
  useEffect(() => {
    const { search } = captureRef(location.search, safeStore());
    if (search !== location.search) {
      navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Use `location.pathname` in place of the existing `const { pathname } = useLocation();`, and add the imports: `useNavigate` from `react-router-dom`, `captureRef` from `./lib/ref`, `safeStore` from `./lib/storage`.

- [ ] **Step 4: Verify in the browser**

With `npm run dev` running, open `http://localhost:5173/?ref=tl-48213&utm_source=test`. Expected: the address becomes `/?utm_source=test`; in the console, `localStorage.getItem('lgf.ref')` is `"TL-48213"`. Then open `/?ref=TL-99999`: the address becomes `/` and the stored value is still `"TL-48213"`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: remember the affiliate a customer arrived through"
```

---

### Task 6: The cart logic (storefront)

**Files (under `SITE/`):**
- Create: `src/lib/cart.ts`, `src/lib/cart.test.ts`, `src/state/cart.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `Store`, `safeStore` (Task 5).
- Produces:
  - `type CartLine = { id: string; quantity: number }`
  - `type Priceable = { id: string; price: number }`
  - `type PricedLine<T> = { id: string; quantity: number; item: T | null; lineTotal: number }`
  - `MIN_QUANTITY = 1`, `MAX_QUANTITY = 12`, `CART_KEY = 'lgf.cart'`
  - `clampQuantity(value: unknown): number`
  - `parseCart(raw: string | null): CartLine[]`
  - `addToCart(lines: CartLine[], id: string, quantity: number): CartLine[]`
  - `setQuantity(lines: CartLine[], id: string, quantity: number): CartLine[]`
  - `removeFromCart(lines: CartLine[], id: string): CartLine[]`
  - `priceCart<T extends Priceable>(lines: CartLine[], items: readonly T[]): { lines: PricedLine<T>[]; subtotal: number }`
  - `CartProvider`, and `useCart(): { lines: CartLine[]; add(id: string, quantity: number): void; setQuantity(id: string, quantity: number): void; remove(id: string): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/cart.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addToCart, clampQuantity, parseCart, priceCart, removeFromCart, setQuantity } from './cart';

describe('clampQuantity', () => {
  it('keeps a whole number from 1 to 12', () => {
    expect(clampQuantity(1)).toBe(1);
    expect(clampQuantity(12)).toBe(12);
  });
  it('pulls anything else into range', () => {
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(-4)).toBe(1);
    expect(clampQuantity(13)).toBe(12);
    expect(clampQuantity(999)).toBe(12);
    expect(clampQuantity(2.7)).toBe(2);
    expect(clampQuantity('3')).toBe(3);
    expect(clampQuantity('lots')).toBe(1);
    expect(clampQuantity(Number.NaN)).toBe(1);
    expect(clampQuantity(null)).toBe(1);
  });
});

describe('parseCart', () => {
  it('reads what the site wrote', () => {
    expect(parseCart('[{"id":"41","quantity":2}]')).toEqual([{ id: '41', quantity: 2 }]);
  });
  it('is empty for nothing, and for anything that is not a cart', () => {
    for (const raw of [null, '', 'null', '{}', '"cart"', '42', 'not json', '[1,2,3]', '[null]', '[{"quantity":2}]', '[{"id":"","quantity":2}]']) {
      expect(parseCart(raw)).toEqual([]);
    }
  });
  it('keeps the good lines and drops the bad', () => {
    expect(parseCart('[{"id":"41","quantity":2},{"id":7},"x",{"id":"9","quantity":1}]')).toEqual([
      { id: '41', quantity: 2 },
      { id: '9', quantity: 1 },
    ]);
  });
  it('repairs a quantity out of range', () => {
    expect(parseCart('[{"id":"41","quantity":999},{"id":"42","quantity":"3"},{"id":"43","quantity":0}]')).toEqual([
      { id: '41', quantity: 12 },
      { id: '42', quantity: 3 },
      { id: '43', quantity: 1 },
    ]);
  });
  it('merges a tradeline listed twice', () => {
    expect(parseCart('[{"id":"41","quantity":2},{"id":"41","quantity":3}]')).toEqual([{ id: '41', quantity: 5 }]);
  });
  it('reads a numeric id as text', () => {
    expect(parseCart('[{"id":41,"quantity":1}]')).toEqual([{ id: '41', quantity: 1 }]);
  });
});

describe('changing the cart', () => {
  it('adds a line at the end', () => {
    expect(addToCart([{ id: '1', quantity: 1 }], '2', 3)).toEqual([
      { id: '1', quantity: 1 },
      { id: '2', quantity: 3 },
    ]);
  });
  it('adding one already there raises its quantity', () => {
    expect(addToCart([{ id: '1', quantity: 2 }], '1', 3)).toEqual([{ id: '1', quantity: 5 }]);
  });
  it('but never past twelve', () => {
    expect(addToCart([{ id: '1', quantity: 10 }], '1', 5)).toEqual([{ id: '1', quantity: 12 }]);
  });
  it('sets a quantity, within range', () => {
    expect(setQuantity([{ id: '1', quantity: 2 }], '1', 7)).toEqual([{ id: '1', quantity: 7 }]);
    expect(setQuantity([{ id: '1', quantity: 2 }], '1', 0)).toEqual([{ id: '1', quantity: 1 }]);
    expect(setQuantity([{ id: '1', quantity: 2 }], 'nope', 7)).toEqual([{ id: '1', quantity: 2 }]);
  });
  it('removes a line', () => {
    expect(removeFromCart([{ id: '1', quantity: 2 }, { id: '2', quantity: 1 }], '1')).toEqual([{ id: '2', quantity: 1 }]);
  });
  it('never changes the list it was given', () => {
    const lines = [{ id: '1', quantity: 2 }];
    addToCart(lines, '1', 1);
    setQuantity(lines, '1', 9);
    removeFromCart(lines, '1');
    expect(lines).toEqual([{ id: '1', quantity: 2 }]);
  });
});

describe('priceCart', () => {
  const items = [
    { id: '1', price: 450 },
    { id: '2', price: 1250.5 },
    { id: '3', price: 0.1 },
  ];
  it('prices each line and adds them up', () => {
    const priced = priceCart([{ id: '1', quantity: 2 }, { id: '2', quantity: 1 }], items);
    expect(priced.lines.map((line) => line.lineTotal)).toEqual([900, 1250.5]);
    expect(priced.subtotal).toBe(2150.5);
  });
  it('adds cents exactly', () => {
    expect(priceCart([{ id: '3', quantity: 3 }], items).subtotal).toBe(0.3);
  });
  it('a tradeline that has gone is kept, unpriced, and left out of the total', () => {
    const priced = priceCart([{ id: '1', quantity: 1 }, { id: 'gone', quantity: 4 }], items);
    expect(priced.lines[1]).toEqual({ id: 'gone', quantity: 4, item: null, lineTotal: 0 });
    expect(priced.subtotal).toBe(450);
  });
  it('an empty cart is nought', () => {
    expect(priceCart([], items)).toEqual({ lines: [], subtotal: 0 });
  });
  it('is never NaN for a price that is not a number', () => {
    const priced = priceCart([{ id: 'x', quantity: 2 }], [{ id: 'x', price: Number.NaN }]);
    expect(priced.subtotal).toBe(0);
    expect(priced.lines[0]?.lineTotal).toBe(0);
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./cart`.

- [ ] **Step 2: Write `cart.ts`**

Create `src/lib/cart.ts`:

```ts
/**
 * The cart: which tradelines, and how many of each.
 *
 * Only ids and quantities are kept. What a tradeline is called and what it
 * costs are read from the live stock list every time, so a price changed in
 * the tracker is the price the cart shows, and a tradeline taken off sale is
 * seen to be gone rather than sold at a price that no longer exists.
 *
 * One quantity is three months, and a tradeline can be had for up to twelve.
 *
 * Pure. What is in the browser's storage is treated as something anybody may
 * have edited: parseCart keeps what it can read and drops the rest.
 */

export type CartLine = { id: string; quantity: number };
export type Priceable = { id: string; price: number };
export type PricedLine<T> = { id: string; quantity: number; item: T | null; lineTotal: number };

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 12;
export const CART_KEY = 'lgf.cart';

/** A whole number from 1 to 12, whatever it is given. */
export function clampQuantity(value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return MIN_QUANTITY;
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(number)));
}

/** A stored cart, as far as it can be read. Never throws. */
export function parseCart(raw: string | null): CartLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  let lines: CartLine[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, quantity } = entry as { id?: unknown; quantity?: unknown };
    const key = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
    if (!key || quantity === undefined) continue;
    lines = addToCart(lines, key, clampQuantity(quantity));
  }
  return lines;
}

export function addToCart(lines: CartLine[], id: string, quantity: number): CartLine[] {
  const adding = clampQuantity(quantity);
  if (!lines.some((line) => line.id === id)) return [...lines, { id, quantity: adding }];
  return lines.map((line) => (line.id === id ? { id, quantity: clampQuantity(line.quantity + adding) } : line));
}

export function setQuantity(lines: CartLine[], id: string, quantity: number): CartLine[] {
  return lines.map((line) => (line.id === id ? { id, quantity: clampQuantity(quantity) } : line));
}

export function removeFromCart(lines: CartLine[], id: string): CartLine[] {
  return lines.filter((line) => line.id !== id);
}

/** In cents, so that three at $0.10 is $0.30 and not $0.30000000000000004. */
function cents(price: number): number {
  return Number.isFinite(price) ? Math.round(price * 100) : 0;
}

/** Each line against the stock list, and the total of the ones still on offer. */
export function priceCart<T extends Priceable>(
  lines: CartLine[],
  items: readonly T[],
): { lines: PricedLine<T>[]; subtotal: number } {
  let total = 0;
  const priced = lines.map((line) => {
    const item = items.find((candidate) => candidate.id === line.id) ?? null;
    const lineCents = item ? cents(item.price) * line.quantity : 0;
    total += lineCents;
    return { id: line.id, quantity: line.quantity, item, lineTotal: lineCents / 100 };
  });
  return { lines: priced, subtotal: total / 100 };
}
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: The provider**

Create `src/state/cart.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { addToCart, CART_KEY, parseCart, removeFromCart, setQuantity as withQuantity, type CartLine } from '../lib/cart';
import { safeStore } from '../lib/storage';

type CartValue = {
  lines: CartLine[];
  add(id: string, quantity: number): void;
  setQuantity(id: string, quantity: number): void;
  remove(id: string): void;
};

const CartContext = createContext<CartValue | null>(null);

/** The cart, shared by every page and written to the browser on each change. */
export function CartProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => safeStore(), []);
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      return parseCart(store.getItem(CART_KEY));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      store.setItem(CART_KEY, JSON.stringify(lines));
    } catch {
      // Nowhere to keep it. The cart still works for this visit.
    }
  }, [lines, store]);

  // Another tab changed the cart: follow it rather than overwrite it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CART_KEY) setLines(parseCart(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const add = useCallback((id: string, quantity: number) => setLines((current) => addToCart(current, id, quantity)), []);
  const setQuantity = useCallback(
    (id: string, quantity: number) => setLines((current) => withQuantity(current, id, quantity)),
    [],
  );
  const remove = useCallback((id: string) => setLines((current) => removeFromCart(current, id)), []);

  const value = useMemo(() => ({ lines, add, setQuantity, remove }), [lines, add, setQuantity, remove]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart needs a CartProvider above it.');
  return value;
}
```

In `src/App.tsx`, wrap `<Shell />` in `<CartProvider>` (inside `<BrowserRouter>`), importing it from `./state/cart`.

- [ ] **Step 4: Build**

Run: `npm test && npm run build`
Expected: all pass, build completes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cart lines, quantities and totals"
```

---

### Task 7: The live stock list (storefront)

**Files (under `SITE/`):**
- Create: `src/lib/inventory.ts`, `src/lib/inventory.test.ts`, `src/state/inventory.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `IssuerKey`, `ISSUERS` (Task 4); the endpoint from Task 2.
- Produces:
  - `type Tradeline = { id: string; issuer: IssuerKey; name: string; creditLimit: number; openDate: string; age: string | null; price: number }`
  - `parseInventory(json: unknown): Tradeline[]` — never throws; drops what it cannot read.
  - `fetchInventory(baseUrl: string, fetcher?: typeof fetch): Promise<Tradeline[]>` — rejects on a network failure or a non-200.
  - `forIssuer(tradelines: readonly Tradeline[], issuer: IssuerKey): Tradeline[]`
  - `fromPrice(tradelines: readonly Tradeline[]): number | null`
  - `InventoryProvider`, and `useInventory(): { status: 'loading' | 'ready' | 'error'; tradelines: Tradeline[]; retry(): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/inventory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fetchInventory, forIssuer, fromPrice, parseInventory } from './inventory';

const good = {
  id: '41',
  issuer: 'capital-one',
  name: 'Capital One/Cabelas',
  creditLimit: 500,
  openDate: '2012-04-10',
  age: '13.38356164',
  price: 450,
};

describe('parseInventory', () => {
  it('reads the tracker response', () => {
    expect(parseInventory({ issuers: [], tradelines: [good] })).toEqual([good]);
  });
  it('is empty for anything that is not one', () => {
    for (const json of [null, undefined, 'x', 42, [], {}, { tradelines: 'none' }, { tradelines: null }]) {
      expect(parseInventory(json)).toEqual([]);
    }
  });
  it('drops a row it cannot read and keeps the rest', () => {
    const rows = [
      good,
      { ...good, id: '42', price: '450' },
      { ...good, id: '43', price: 0 },
      { ...good, id: '44', price: -5 },
      { ...good, id: '45', name: '' },
      { ...good, id: '46', issuer: 'chase' },
      { ...good, id: '47', creditLimit: null },
      { ...good, id: '', name: 'No id' },
      null,
      'row',
      { ...good, id: '48', openDate: 20120410 },
    ];
    expect(parseInventory({ tradelines: rows }).map((row) => row.id)).toEqual(['41']);
  });
  it('reads a numeric id as text and a missing age as none', () => {
    const [row] = parseInventory({ tradelines: [{ ...good, id: 41, age: undefined }] });
    expect(row?.id).toBe('41');
    expect(row?.age).toBeNull();
  });
  it('carries nothing extra through', () => {
    const [row] = parseInventory({ tradelines: [{ ...good, createdBy: 'marvin' }] });
    expect(Object.keys(row ?? {}).sort().join()).toBe('age,creditLimit,id,issuer,name,openDate,price');
  });
});

describe('forIssuer and fromPrice', () => {
  const rows = parseInventory({
    tradelines: [good, { ...good, id: '2', price: 300 }, { ...good, id: '3', issuer: 'citi', price: 650 }],
  });
  it('picks one issuer, in the order given', () => {
    expect(forIssuer(rows, 'capital-one').map((row) => row.id)).toEqual(['41', '2']);
    expect(forIssuer(rows, 'pnc')).toEqual([]);
  });
  it('finds the lowest price, or none', () => {
    expect(fromPrice(rows)).toBe(300);
    expect(fromPrice([])).toBeNull();
  });
});

describe('fetchInventory', () => {
  const answer = (status: number, body: unknown) =>
    (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

  it('asks the tracker and reads the answer', async () => {
    let asked = '';
    const fetcher = (async (url: string) => {
      asked = url;
      return { ok: true, status: 200, json: async () => ({ tradelines: [good] }) };
    }) as unknown as typeof fetch;
    expect(await fetchInventory('http://localhost:3001/', fetcher)).toEqual([good]);
    expect(asked).toBe('http://localhost:3001/api/public/tradelines');
  });
  it('fails when the tracker says it cannot', async () => {
    await expect(fetchInventory('http://x', answer(503, { error: 'no' }))).rejects.toThrow();
  });
  it('fails when the network does', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchInventory('http://x', down)).rejects.toThrow();
  });
  it('fails when no tracker address is set', async () => {
    await expect(fetchInventory('', answer(200, { tradelines: [good] }))).rejects.toThrow();
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./inventory`.

- [ ] **Step 2: Write `inventory.ts`**

Create `src/lib/inventory.ts`:

```ts
import { ISSUERS, type IssuerKey } from '../data/issuers';

/**
 * The tradelines on offer, read from the affiliate tracker.
 *
 * The tracker is where the list is kept, so this site has no stock of its own
 * to go out of date. What comes back is read row by row and anything that
 * does not look like a tradeline is dropped, so one bad row costs that row
 * and not the page.
 */

export type Tradeline = {
  id: string;
  issuer: IssuerKey;
  name: string;
  creditLimit: number;
  /** YYYY-MM-DD. */
  openDate: string;
  /** In years, as text. Null when none was given. */
  age: string | null;
  /** In dollars. Always greater than nought. */
  price: number;
};

function isIssuerKey(value: unknown): value is IssuerKey {
  return ISSUERS.some((issuer) => issuer.key === value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toTradeline(row: unknown): Tradeline | null {
  if (typeof row !== 'object' || row === null) return null;
  const { id, issuer, name, creditLimit, openDate, age, price } = row as Record<string, unknown>;
  const key = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
  if (!key || !isIssuerKey(issuer)) return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (!positive(creditLimit) || !positive(price) || typeof openDate !== 'string') return null;
  return {
    id: key,
    issuer,
    name: name.trim(),
    creditLimit,
    openDate,
    age: typeof age === 'string' && age.trim() !== '' ? age : null,
    price,
  };
}

/** The tradelines in a tracker response. Empty for anything that is not one. */
export function parseInventory(json: unknown): Tradeline[] {
  const rows = (json as { tradelines?: unknown } | null | undefined)?.tradelines;
  if (!Array.isArray(rows)) return [];
  return rows.map(toTradeline).filter((row): row is Tradeline => row !== null);
}

export async function fetchInventory(baseUrl: string, fetcher: typeof fetch = fetch): Promise<Tradeline[]> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('No tracker address is set (VITE_TRACKER_URL).');
  const response = await fetcher(`${base}/api/public/tradelines`);
  if (!response.ok) throw new Error(`The stock list could not be read (${response.status}).`);
  return parseInventory(await response.json());
}

export function forIssuer(tradelines: readonly Tradeline[], issuer: IssuerKey): Tradeline[] {
  return tradelines.filter((row) => row.issuer === issuer);
}

/** The lowest price among some tradelines, or null when there are none. */
export function fromPrice(tradelines: readonly Tradeline[]): number | null {
  return tradelines.length > 0 ? Math.min(...tradelines.map((row) => row.price)) : null;
}
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: The provider**

Create `src/state/inventory.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchInventory, type Tradeline } from '../lib/inventory';

type InventoryValue = {
  status: 'loading' | 'ready' | 'error';
  tradelines: Tradeline[];
  retry(): void;
};

const InventoryContext = createContext<InventoryValue | null>(null);

/** The stock list, read once per visit and shared by every page. */
export function InventoryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<InventoryValue['status']>('loading');
  const [tradelines, setTradelines] = useState<Tradeline[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setStatus('loading');
    fetchInventory(import.meta.env.VITE_TRACKER_URL ?? '')
      .then((rows) => {
        if (!current) return;
        setTradelines(rows);
        setStatus('ready');
      })
      .catch(() => {
        if (current) setStatus('error');
      });
    return () => {
      current = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const value = useMemo(() => ({ status, tradelines, retry }), [status, tradelines, retry]);
  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventory(): InventoryValue {
  const value = useContext(InventoryContext);
  if (!value) throw new Error('useInventory needs an InventoryProvider above it.');
  return value;
}
```

Add `VITE_TRACKER_URL` to the env typings: create `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRACKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

In `src/App.tsx`, wrap `<CartProvider>` in `<InventoryProvider>`.

- [ ] **Step 4: Build and verify against the tracker**

Run: `npm test && npm run build`. Then, with the tracker on 3001 and `npm run dev` here, open the site and confirm in the Network panel that `api/public/tradelines` is requested once, returns 200, and has no CORS error in the console.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: read the stock list from the tracker"
```

---

### Task 8: The issuer page (storefront)

**Files (under `SITE/`):**
- Create: `src/pages/IssuerPage.tsx`, `src/components/QuantityStepper.tsx`, `src/components/StockUnavailable.tsx`, `src/lib/sort.ts`, `src/lib/sort.test.ts`
- Modify: `src/App.tsx`, `src/styles/global.css`

**Interfaces:**
- Consumes: `issuerByKey`, `ISSUERS` (Task 4); format functions (Task 4); `useInventory`, `forIssuer`, `fromPrice`, `Tradeline` (Task 7); `useCart` (Task 6); `MIN_QUANTITY`, `MAX_QUANTITY`, `clampQuantity` (Task 6); `PHONE_DISPLAY`, `PHONE_HREF` from `src/data/content.ts`.
- Produces:
  - `type SortKey = 'entered' | 'limit' | 'age' | 'price'`
  - `sortTradelines(rows: readonly Tradeline[], key: SortKey, direction: 'asc' | 'desc'): Tradeline[]`
  - `QuantityStepper({ value, onChange, label }: { value: number; onChange(next: number): void; label: string })`
  - `StockUnavailable({ onRetry }: { onRetry(): void })`
  - The route `/tradelines/:issuer`.

- [ ] **Step 1: Write the failing sort tests**

Create `src/lib/sort.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Tradeline } from './inventory';
import { sortTradelines } from './sort';

const row = (id: string, creditLimit: number, age: string | null, price: number): Tradeline => ({
  id,
  issuer: 'citi',
  name: `Citi ${id}`,
  creditLimit,
  openDate: '2015-03-03',
  age,
  price,
});

const rows = [row('a', 3000, '9.5', 700), row('b', 500, '13.38', 450), row('c', 7500, null, 900), row('d', 500, '10.25', 450)];
const ids = (list: Tradeline[]) => list.map((item) => item.id).join('');

describe('sortTradelines', () => {
  it('leaves the order entered alone', () => {
    expect(ids(sortTradelines(rows, 'entered', 'asc'))).toBe('abcd');
  });
  it('sorts by limit', () => {
    expect(ids(sortTradelines(rows, 'limit', 'desc'))).toBe('cabd');
    expect(ids(sortTradelines(rows, 'limit', 'asc'))).toBe('bdac');
  });
  it('sorts by price, ties in the order entered', () => {
    expect(ids(sortTradelines(rows, 'price', 'asc'))).toBe('bdac');
  });
  it('sorts by age as a number, with none given last either way', () => {
    expect(ids(sortTradelines(rows, 'age', 'desc'))).toBe('bdac');
    expect(ids(sortTradelines(rows, 'age', 'asc'))).toBe('adbc');
  });
  it('does not change the list it was given', () => {
    sortTradelines(rows, 'price', 'desc');
    expect(ids(rows)).toBe('abcd');
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./sort`.

- [ ] **Step 2: Write `sort.ts`**

Create `src/lib/sort.ts`:

```ts
import type { Tradeline } from './inventory';

export type SortKey = 'entered' | 'limit' | 'age' | 'price';

function ageOf(row: Tradeline): number | null {
  const years = row.age === null ? Number.NaN : Number(row.age);
  return Number.isFinite(years) ? years : null;
}

/**
 * One issuer's tradelines in the order asked for. Ties keep the order they
 * were entered in, and a tradeline with no age given goes last whichever way
 * the ages run, since it is neither the oldest nor the youngest.
 */
export function sortTradelines(rows: readonly Tradeline[], key: SortKey, direction: 'asc' | 'desc'): Tradeline[] {
  if (key === 'entered') return [...rows];
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (key === 'age') {
        const left = ageOf(a.row);
        const right = ageOf(b.row);
        if (left === null || right === null) {
          if (left === right) return a.index - b.index;
          return left === null ? 1 : -1;
        }
        return (left - right) * sign || a.index - b.index;
      }
      const left = key === 'limit' ? a.row.creditLimit : a.row.price;
      const right = key === 'limit' ? b.row.creditLimit : b.row.price;
      return (left - right) * sign || a.index - b.index;
    })
    .map((entry) => entry.row);
}
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: The two small components**

Create `src/components/QuantityStepper.tsx`:

```tsx
import { clampQuantity, MAX_QUANTITY, MIN_QUANTITY } from '../lib/cart';

/** A quantity from 1 to 12, by button or by typing. */
export function QuantityStepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange(next: number): void;
  /** What it is a quantity of, for a screen reader. */
  label: string;
}) {
  return (
    <div className="stepper" role="group" aria-label={`Quantity for ${label}`}>
      <button type="button" className="stepper-button" aria-label="One fewer" disabled={value <= MIN_QUANTITY} onClick={() => onChange(clampQuantity(value - 1))}>
        <span aria-hidden>&minus;</span>
      </button>
      <input
        className="stepper-value"
        type="number"
        inputMode="numeric"
        min={MIN_QUANTITY}
        max={MAX_QUANTITY}
        value={value}
        aria-label="Quantity"
        onChange={(event) => onChange(clampQuantity(event.target.value))}
      />
      <button type="button" className="stepper-button" aria-label="One more" disabled={value >= MAX_QUANTITY} onClick={() => onChange(clampQuantity(value + 1))}>
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}
```

Create `src/components/StockUnavailable.tsx`:

```tsx
import { PHONE_DISPLAY, PHONE_HREF } from '../data/content';

/** Shown where the stock list would be, when it could not be read. */
export function StockUnavailable({ onRetry }: { onRetry(): void }) {
  return (
    <div className="notice" role="alert">
      <h2 className="notice-title">We could not load the tradelines just now.</h2>
      <p className="notice-body">
        Nothing is wrong on your side. Try again in a moment, or call <a href={PHONE_HREF}>{PHONE_DISPLAY}</a> and we will
        tell you what is in stock.
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 4: The page**

Create `src/pages/IssuerPage.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QuantityStepper } from '../components/QuantityStepper';
import { StockUnavailable } from '../components/StockUnavailable';
import { ISSUERS, issuerByKey } from '../data/issuers';
import { formatAge, formatLimit, formatMoney, formatOpenDate } from '../lib/format';
import { forIssuer, fromPrice } from '../lib/inventory';
import { sortTradelines, type SortKey } from '../lib/sort';
import { useCart } from '../state/cart';
import { useInventory } from '../state/inventory';
import { NotFoundPage } from './NotFoundPage';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'limit', label: 'Credit limit' },
  { key: 'age', label: 'Age' },
  { key: 'price', label: 'Price' },
];

/**
 * One institution's tradelines, and choosing one.
 *
 * The list is the real list, not a picture of it: a row is chosen by pressing
 * it, and the panel beside the table says what is chosen, for how long, and
 * what it comes to before anything goes in the cart.
 */
export function IssuerPage() {
  const { issuer: param } = useParams();
  const issuer = issuerByKey(param);
  const { status, tradelines, retry } = useInventory();
  const cart = useCart();

  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'entered', direction: 'asc' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState<string | null>(null);

  const mine = useMemo(() => (issuer ? forIssuer(tradelines, issuer.key) : []), [tradelines, issuer]);
  const shown = useMemo(() => sortTradelines(mine, sort.key, sort.direction), [mine, sort]);
  const selected = mine.find((row) => row.id === selectedId) ?? null;
  const from = fromPrice(mine);

  if (!issuer) return <NotFoundPage />;

  function sortBy(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : // Limits and ages open on the big end, which is what people look for. Prices open on the low end.
          { key, direction: key === 'price' ? 'asc' : 'desc' },
    );
  }

  function choose(id: string) {
    setSelectedId(id);
    setQuantity(1);
    setAdded(null);
  }

  function addSelected() {
    if (!selected) return;
    cart.add(selected.id, quantity);
    setAdded(selected.id);
  }

  return (
    <main className="page">
      <div className="page-inner">
        <p className="crumb">
          <Link to="/#shop">All institutions</Link>
        </p>
        <header className="issuer-head">
          <img className="issuer-logo" src={issuer.logo} alt="" />
          <div>
            <h1 className="page-title">{issuer.name} tradelines</h1>
            <p className="section-lede">
              {status === 'ready' && from !== null
                ? `${mine.length === 1 ? '1 tradeline' : `${mine.length} tradelines`} in stock, from ${formatMoney(from)}. Choose one to see what it comes to.`
                : 'Every tradeline we have in stock for this institution, with its price.'}
            </p>
          </div>
        </header>

        {status === 'error' ? <StockUnavailable onRetry={retry} /> : null}

        {status === 'loading' ? (
          <div className="stock-skeleton" aria-busy="true" aria-label="Loading the tradelines">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="stock-skeleton-row" />
            ))}
          </div>
        ) : null}

        {status === 'ready' && mine.length === 0 ? (
          <div className="notice">
            <h2 className="notice-title">Nothing in stock for {issuer.name} right now.</h2>
            <p className="notice-body">New tradelines are added often. In the meantime, these institutions have stock:</p>
            <ul className="issuer-links">
              {ISSUERS.filter((other) => other.key !== issuer.key && forIssuer(tradelines, other.key).length > 0).map((other) => (
                <li key={other.key}>
                  <Link to={`/tradelines/${other.key}`}>{other.name}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {status === 'ready' && mine.length > 0 ? (
          <div className="picker">
            <div className="stock" role="radiogroup" aria-label={`${issuer.name} tradelines`}>
              <div className="stock-head">
                <span className="stock-col-name">Tradeline</span>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <button
                      key={column.key}
                      type="button"
                      className="stock-sort"
                      data-active={active}
                      aria-label={`Sort by ${column.label.toLowerCase()}`}
                      onClick={() => sortBy(column.key)}
                    >
                      {column.label}
                      <span aria-hidden className="stock-sort-arrow">
                        {active && sort.direction === 'asc' ? '▲' : '▼'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {shown.map((row) => {
                const chosen = row.id === selectedId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    className="stock-row"
                    data-chosen={chosen}
                    onClick={() => choose(row.id)}
                  >
                    <span className="stock-col-name">
                      <span className="stock-name">{row.name}</span>
                      <span className="stock-opened">Opened {formatOpenDate(row.openDate)}</span>
                    </span>
                    <span className="stock-cell" data-label="Credit limit">
                      {formatLimit(row.creditLimit)}
                    </span>
                    <span className="stock-cell" data-label="Age">
                      {formatAge(row.age)}
                    </span>
                    <span className="stock-cell stock-price" data-label="Price">
                      {formatMoney(row.price)}
                    </span>
                  </button>
                );
              })}
            </div>

            <aside className="choice" aria-live="polite">
              {selected ? (
                <>
                  <p className="eyebrow">Your choice</p>
                  <h2 className="choice-name">{selected.name}</h2>
                  <dl className="choice-facts">
                    <div>
                      <dt>Credit limit</dt>
                      <dd>{formatLimit(selected.creditLimit)}</dd>
                    </div>
                    <div>
                      <dt>Opened</dt>
                      <dd>{formatOpenDate(selected.openDate)}</dd>
                    </div>
                    <div>
                      <dt>Age</dt>
                      <dd>{formatAge(selected.age)}</dd>
                    </div>
                  </dl>
                  <div className="choice-quantity">
                    <QuantityStepper value={quantity} onChange={setQuantity} label={selected.name} />
                    <p className="choice-months">
                      1 quantity = 3 months. That is {quantity * 3} months.
                    </p>
                  </div>
                  <p className="choice-total">
                    <span>Total</span>
                    <strong>{formatMoney((Math.round(selected.price * 100) * quantity) / 100)}</strong>
                  </p>
                  <button type="button" className="btn choice-add" onClick={addSelected}>
                    {added === selected.id ? 'Added to cart' : 'Add to cart'}
                  </button>
                  {added === selected.id ? (
                    <Link to="/cart" className="text-link choice-view">
                      View cart ›
                    </Link>
                  ) : null}
                  <p className="choice-check">Please double-check the tradeline you have chosen before checking out.</p>
                </>
              ) : (
                <>
                  <p className="eyebrow">Your choice</p>
                  <p className="choice-empty">Choose a tradeline from the list to see its total.</p>
                </>
              )}
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}
```

In `src/App.tsx`, change the `/tradelines/:issuer` route's element to `<IssuerPage />` and import it.

- [ ] **Step 5: Styles**

Append to `src/styles/global.css` after the `.page-actions` rule:

```css
/* ---------- Issuer page ---------- */
.crumb {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 24px;
}

.issuer-head {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 40px;
}

.issuer-logo {
  flex: none;
  width: 96px;
  height: 96px;
  padding: 16px;
  border-radius: 24px;
  background: var(--bg-warm);
  object-fit: contain;
  mix-blend-mode: multiply;
}

.picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 32px;
  align-items: start;
}

.stock {
  border-radius: 24px;
  background: var(--bg-warm);
  padding: 8px;
}

.stock-head,
.stock-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) 1fr 1fr 1fr;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}

.stock-head {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.stock-sort {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  justify-content: flex-end;
  gap: 6px;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}

.stock-sort[data-active='true'] {
  color: var(--text);
}

.stock-sort:focus-visible,
.stock-row:focus-visible {
  outline: 3px solid var(--green);
  outline-offset: 2px;
}

.stock-sort-arrow {
  font-size: 9px;
  opacity: 0.4;
}

.stock-sort[data-active='true'] .stock-sort-arrow {
  opacity: 1;
}

.stock-row {
  width: 100%;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out);
}

.stock-row:hover {
  background: rgba(255, 255, 255, 0.7);
}

.stock-row[data-chosen='true'] {
  background: var(--bg);
  box-shadow: inset 0 0 0 2px var(--green), 0 12px 30px -18px rgba(0, 0, 0, 0.3);
}

.stock-name {
  display: block;
  font-size: 16px;
  font-weight: 700;
}

.stock-opened {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
}

.stock-cell {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.stock-price {
  font-weight: 700;
}

.stock-skeleton {
  display: grid;
  gap: 8px;
  border-radius: 24px;
  background: var(--bg-warm);
  padding: 8px;
}

.stock-skeleton-row {
  height: 64px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.6);
}

.choice {
  position: sticky;
  top: 96px;
  border-radius: 24px;
  border: 1px solid var(--divider);
  padding: 28px;
}

.choice-name {
  font-size: 22px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: -0.02em;
  margin: 4px 0 16px;
}

.choice-facts {
  display: grid;
  gap: 8px;
  margin: 0 0 24px;
}

.choice-facts div {
  display: flex;
  justify-content: space-between;
  font-size: 15px;
}

.choice-facts dt {
  color: var(--text-secondary);
}

.choice-facts dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.choice-months,
.choice-check,
.choice-empty {
  font-size: 13px;
  color: var(--text-secondary);
}

.choice-months {
  margin: 10px 0 0;
}

.choice-total {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 24px 0 16px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
  font-size: 15px;
}

.choice-total strong {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.choice-add {
  display: block;
  width: 100%;
  border: 0;
  font-family: inherit;
  text-align: center;
}

.choice-view {
  display: block;
  text-align: center;
}

.stepper {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--divider);
  border-radius: 980px;
  padding: 4px;
}

.stepper-button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: var(--bg-warm);
  font-size: 20px;
  font-weight: 600;
  cursor: pointer;
}

.stepper-button:disabled {
  opacity: 0.35;
  cursor: default;
}

.stepper-value {
  width: 48px;
  border: 0;
  background: transparent;
  font: inherit;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
  appearance: textfield;
  -moz-appearance: textfield;
}

.stepper-value::-webkit-inner-spin-button,
.stepper-value::-webkit-outer-spin-button {
  appearance: none;
  margin: 0;
}

.notice {
  border-radius: 24px;
  background: var(--bg-warm);
  padding: 40px;
}

.notice-title {
  font-size: 22px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
}

.notice-body {
  color: var(--text-secondary);
  margin: 0 0 24px;
  max-width: 560px;
}

.issuer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-weight: 600;
}

@media (max-width: 899px) {
  .picker {
    grid-template-columns: 1fr;
  }

  .choice {
    position: static;
  }
}

@media (max-width: 599px) {
  .issuer-head {
    align-items: flex-start;
    gap: 16px;
  }

  .issuer-logo {
    width: 64px;
    height: 64px;
    padding: 10px;
    border-radius: 16px;
  }

  .stock-head {
    grid-template-columns: repeat(3, 1fr);
  }

  .stock-head .stock-col-name {
    display: none;
  }

  /* Each tradeline is a card: its name across the top, its three facts beneath, each named. */
  .stock-row {
    grid-template-columns: repeat(3, 1fr);
    row-gap: 10px;
  }

  .stock-row .stock-col-name {
    grid-column: 1 / -1;
  }

  .stock-cell {
    text-align: left;
  }

  .stock-cell::before {
    content: attr(data-label);
    display: block;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  .stock-sort {
    justify-content: flex-start;
  }
}
```

- [ ] **Step 6: Build and look at it**

Run: `npm test && npm run build`. Then with both servers running open, at 1440px and 390px wide:

- `/tradelines/capital-one`: rows show; pressing one outlines it and fills the panel; quantity 3 reads "That is 9 months" and triples the total; Add to cart turns to "Added to cart" with "View cart".
- `/tradelines/CITI`: the Citi page (case forgiven).
- `/tradelines/nope`: "That page is not here."
- An issuer with no priced tradelines: "Nothing in stock for ... right now."
- Stop the tracker and reload: "We could not load the tradelines just now." with Try again; start it and press Try again: the list appears.
- Tab through the page: every row and button is reachable and shows a focus ring; Space or Enter on a row chooses it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: an issuer's tradelines, and choosing one"
```

---

### Task 9: The cart page and the header badge (storefront)

**Files (under `SITE/`):**
- Create: `src/pages/CartPage.tsx`
- Modify: `src/App.tsx`, `src/components/Nav.tsx`, `src/styles/global.css`

**Interfaces:**
- Consumes: `useCart` and `priceCart` (Task 6); `useInventory`, `Tradeline` (Task 7); `issuerByKey` (Task 4); format functions; `QuantityStepper`, `StockUnavailable` (Task 8); `PHONE_DISPLAY`, `PHONE_HREF`.
- Produces: the route `/cart`; a cart link in the nav showing the number of lines.

- [ ] **Step 1: The page**

Create `src/pages/CartPage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { QuantityStepper } from '../components/QuantityStepper';
import { StockUnavailable } from '../components/StockUnavailable';
import { PHONE_DISPLAY, PHONE_HREF } from '../data/content';
import { issuerByKey } from '../data/issuers';
import { priceCart } from '../lib/cart';
import { formatAge, formatLimit, formatMoney, formatOpenDate } from '../lib/format';
import { useCart } from '../state/cart';
import { useInventory } from '../state/inventory';

/**
 * The cart.
 *
 * Names and prices come from the live stock list, never from what was saved,
 * so the total is always today's. A tradeline that has since been taken off
 * sale stays on the page, marked, so its going is seen rather than silent,
 * and is left out of the total.
 *
 * There is no checkout yet. The button says so.
 */
export function CartPage() {
  const cart = useCart();
  const { status, tradelines, retry } = useInventory();
  const priced = priceCart(cart.lines, tradelines);

  return (
    <main className="page">
      <div className="page-inner">
        <h1 className="page-title">Your cart</h1>

        {cart.lines.length === 0 ? (
          <div className="notice">
            <h2 className="notice-title">Your cart is empty.</h2>
            <p className="notice-body">Choose an institution to see the tradelines we have in stock.</p>
            <Link to="/#shop" className="btn">
              See available tradelines
            </Link>
          </div>
        ) : status === 'error' ? (
          <StockUnavailable onRetry={retry} />
        ) : status === 'loading' ? (
          <div className="stock-skeleton" aria-busy="true" aria-label="Loading your cart">
            {cart.lines.map((line) => (
              <div key={line.id} className="stock-skeleton-row" />
            ))}
          </div>
        ) : (
          <div className="picker">
            <ul className="cart-lines">
              {priced.lines.map((line) => {
                const item = line.item;
                if (!item) {
                  return (
                    <li key={line.id} className="cart-line" data-gone="true">
                      <div className="cart-line-main">
                        <p className="cart-line-name">No longer available</p>
                        <p className="cart-line-facts">This tradeline has been taken off sale since you added it.</p>
                      </div>
                      <button type="button" className="cart-remove" onClick={() => cart.remove(line.id)}>
                        Remove
                      </button>
                    </li>
                  );
                }
                const issuer = issuerByKey(item.issuer);
                return (
                  <li key={line.id} className="cart-line">
                    {issuer ? <img className="cart-line-logo" src={issuer.logo} alt="" /> : null}
                    <div className="cart-line-main">
                      <p className="cart-line-name">{item.name}</p>
                      <p className="cart-line-facts">
                        {formatLimit(item.creditLimit)} limit · Opened {formatOpenDate(item.openDate)} · {formatAge(item.age)}
                      </p>
                      <p className="cart-line-facts">
                        {formatMoney(item.price)} each · {line.quantity * 3} months
                      </p>
                    </div>
                    <div className="cart-line-side">
                      <QuantityStepper value={line.quantity} onChange={(next) => cart.setQuantity(line.id, next)} label={item.name} />
                      <p className="cart-line-total">{formatMoney(line.lineTotal)}</p>
                      <button type="button" className="cart-remove" aria-label={`Remove ${item.name}`} onClick={() => cart.remove(line.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <aside className="choice">
              <p className="eyebrow">Summary</p>
              <p className="choice-total">
                <span>Subtotal</span>
                <strong>{formatMoney(priced.subtotal)}</strong>
              </p>
              <button type="button" className="btn choice-add" disabled aria-disabled="true">
                Checkout coming soon
              </button>
              <p className="choice-check">
                Online checkout is on its way. To buy now, call <a href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
              </p>
              <Link to="/#shop" className="text-link choice-view">
                Keep browsing ›
              </Link>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
```

In `src/App.tsx`, change the `/cart` route's element to `<CartPage />` and import it.

- [ ] **Step 2: The badge in the nav**

In `src/components/Nav.tsx`, import `useCart` from `'../state/cart'`, read `const { lines } = useCart();` and add, as the last child of `.nav-right`:

```tsx
          <Link to="/cart" className="nav-cart" aria-label={lines.length === 0 ? 'Cart, empty' : `Cart, ${lines.length} ${lines.length === 1 ? 'tradeline' : 'tradelines'}`}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="18" cy="20" r="1.5" />
              <path d="M2 3h3l2.7 12.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 7H6" />
            </svg>
            {lines.length > 0 ? <span className="nav-cart-count">{lines.length}</span> : null}
          </Link>
```

- [ ] **Step 3: Styles**

Append to `src/styles/global.css` after the issuer page rules:

```css
/* ---------- Cart ---------- */
.nav-cart {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  color: inherit;
}

.nav-cart-count {
  position: absolute;
  top: 2px;
  right: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 980px;
  background: var(--green);
  color: var(--text-on-dark);
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.cart-lines {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cart-line {
  display: flex;
  align-items: center;
  gap: 20px;
  border-radius: 24px;
  background: var(--bg-warm);
  padding: 20px 24px;
}

.cart-line[data-gone='true'] {
  background: transparent;
  border: 1px dashed var(--divider);
  color: var(--text-secondary);
}

.cart-line-logo {
  flex: none;
  width: 56px;
  height: 56px;
  object-fit: contain;
  mix-blend-mode: multiply;
}

.cart-line-main {
  flex: 1;
  min-width: 0;
}

.cart-line-name {
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 2px;
}

.cart-line-facts {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.cart-line-side {
  display: flex;
  align-items: center;
  gap: 20px;
}

.cart-line-total {
  min-width: 96px;
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.cart-remove {
  border: 0;
  background: none;
  padding: 12px 4px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: underline;
  cursor: pointer;
}

.btn:disabled {
  background: var(--divider);
  color: var(--text-secondary);
  cursor: default;
}

@media (max-width: 719px) {
  .cart-line {
    flex-wrap: wrap;
  }

  .cart-line-side {
    width: 100%;
    justify-content: space-between;
  }
}
```

- [ ] **Step 4: Build and look at it**

Run: `npm test && npm run build`. Then with both servers running, at 1440px and 390px:

- Add two different tradelines and one of them twice: the badge reads `2`; `/cart` shows two lines, the repeated one with the summed quantity; the subtotal is the sum of the line totals.
- Change a quantity: its line total and the subtotal follow, and the months line follows.
- Remove a line: it goes, the badge drops.
- Reload: the cart is as it was.
- In the console run `localStorage.setItem('lgf.cart', '[{"id":"0","quantity":2},{"id":"x"},7]')` and reload: one line, "No longer available", subtotal `$0.00`, no error in the console.
- Run `localStorage.setItem('lgf.cart', 'garbage')` and reload: "Your cart is empty."
- The Checkout button is greyed, reads "Checkout coming soon", and cannot be pressed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: the cart, with checkout marked as coming"
```

---

### Task 10: Design pass, live "from" prices, and the full run

**Files (under `SITE/`):**
- Modify: `src/components/Hero.tsx`, `FinalCta.tsx`, `StickyCta.tsx`, `src/styles/global.css`, `index.html`
- Create: `README.md`

**Interfaces:**
- Consumes: `useInventory`, `fromPrice` (Task 7); `formatMoney` (Task 4).

- [ ] **Step 1: Live "from" price on the landing page**

In `Hero.tsx`, `FinalCta.tsx` and `StickyCta.tsx`, read `const { status, tradelines } = useInventory();` and `const from = status === 'ready' ? fromPrice(tradelines) : null;`, and:

- Hero stats line: `{from !== null ? `From ${formatMoney(from)} · ` : ''}Capital One, Citi, Discover, Fidelity/Elan, PNC, US Bank`
- FinalCta lede: `{from !== null ? `Tradelines from ${formatMoney(from)}. ` : ''}Six institutions in stock today.`
- StickyCta span: `{from !== null ? `Tradelines from ${formatMoney(from)}` : 'Seasoned tradelines, in stock'}`

In `index.html`, remove ` Tradelines from $550.` from the description, so the page does not quote a price it cannot keep current.

- [ ] **Step 2: Design pass with the frontend-design skill**

Invoke the `frontend-design:frontend-design` skill and apply it to the three new surfaces only: the issuer page, the cart page and the not-found page. Brief:

- They must read as the same site as the landing page: Montserrat, the warm off-white `--bg-warm`, the green, 24px rounded surfaces, bold italic headings, the springs in `src/components/motion.tsx`.
- Use `Reveal` / `RevealItem` for entrance on the page heading and the stock list, and a `SPRING_PRESS` tap response on the row, the stepper buttons and Add to cart. Respect `prefers-reduced-motion`, which `MotionConfig reducedMotion="user"` already does for `motion` components.
- Do not change markup that the checks in Tasks 8 and 9 rely on: `role="radiogroup"` and `role="radio"` on the list and rows, the `data-label` attributes, the disabled Checkout button and its text.
- Do not touch the landing page sections beyond Step 1.
- Body text contrast at least 4.5:1; every interactive target at least 44px.

- [ ] **Step 3: Write the README**

Create `README.md`:

```markdown
# Tradeline-LGF

The tradelines storefront: the public site affiliates send customers to.

It has no stock of its own. The tradelines and their prices are read from the
affiliate tracker's `/api/public/tradelines`, so the table an admin keeps there
is the only list.

## Running it

    cp .env.example .env.local    # VITE_TRACKER_URL, the tracker's address
    npm install
    npm run dev

The tracker has to be running too. Locally it allows any `localhost` site to
read the stock list; in production it allows only the address in its
`TRADELINES_SITE_URL`.

    npm test         # the libs: cart, reference number, stock list, formats
    npm run build

## How a sale is traced

An affiliate's link is this site with `?ref=TL-48213` on it. The number is kept
in the customer's browser (`lgf.ref`), never expires, and the first affiliate
keeps the customer. The cart (`lgf.cart`) holds tradeline ids and quantities
only. There is no checkout yet: when there is, it will send the cart and the
number to the tracker.

## Deploying

A static site. The host must serve `index.html` for every path; `vercel.json`
does that on Vercel. Set `VITE_TRACKER_URL` at build time, and set
`TRADELINES_SITE_URL` in the tracker to this site's address.
```

- [ ] **Step 4: The full run, with screenshots**

Run both: tracker on 3001 (`npm run dev -- -p 3001` in `TRACKER/`), site on 5173 (`npm run dev` in `SITE/`). Run `npm test && npm run build` in `SITE/` and, in `TRACKER/`, `npm run typecheck` and every `scripts/*-checks.ts(x)` (`.tsx` ones with `--tsconfig scripts/render.tsconfig.json`); only the four scripts named in Global Constraints may be red.

Using the Playwright browser tools, capture each of these at 1440x900 and 390x844 into `SITE/shots/` (add `shots/` to `.gitignore`), and look at every one:

1. `/?ref=TL-48213` (then confirm the address bar no longer carries `ref`)
2. `/tradelines/capital-one` with a row chosen and quantity 2
3. An issuer with nothing priced
4. `/cart` with two lines
5. `/cart` empty
6. `/tradelines/citi` with the tracker stopped
7. `/nope`

For each, check: nothing overflows the viewport sideways, no text is clipped or overlapping, the nav and footer are intact, and the console has no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: live from-prices, design pass on the shop pages, README"
```

---

## What the owner does afterwards

1. Decide the storefront's address and deploy `Tradeline-LGF` with `VITE_TRACKER_URL` set to the tracker's address.
2. Set `TRADELINES_SITE_URL` in the tracker's environment to the storefront's address and redeploy the tracker. Affiliates on Tradelines then see their real link in place of "Coming soon".
3. Make sure the tradelines in the tracker have a user price. An unpriced tradeline is not shown in the shop.
