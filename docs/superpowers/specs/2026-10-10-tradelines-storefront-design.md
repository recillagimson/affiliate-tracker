# Tradelines storefront and cart: design

Date: 2026-10-10
Status: awaiting review

## Purpose

Affiliates onboarded for Tradelines need a site they can send customers to. A
customer arrives through an affiliate's link, sees which tradelines are in
stock, picks the ones they want and puts them in a cart. The affiliate's
reference number travels with them, so that when checkout exists the sale can
be recorded against the right person: who sold it, for how much, and who is
owed.

This is the first of several builds. It ends at the cart.

## Where things stand

- `Tradeline-LGF` (Vite, React 18, `motion`, Montserrat) is a marketing landing
  page: hero, video, how it works, six issuer cards, FAQ. Each issuer card links
  out to the current store at `funding.letsgetfunded.com`. Prices and one
  issuer's inventory are typed into `src/data/content.ts`. It is not a git
  repository.
- `affiliate-tracker` (Next 15, Supabase) holds the real tradelines table, kept
  by admins: issuer, name, credit limit, open date, age, user price. Affiliates
  on Tradelines have a reference number (`TL-` and five digits) and a dashboard
  panel whose link reads "Coming soon".

## Scope

In this build:

1. The storefront in `Tradeline-LGF`: issuer pages with a tradeline picker, and
   a cart.
2. Live inventory and prices, read from the tracker.
3. The affiliate link, and remembering the reference number in the customer's
   browser.
4. The affiliate's real link in the tracker, in place of "Coming soon".

Not in this build, each a later build of its own:

- The checkout form and customer details.
- Payment. It will go through GoHighLevel. Nothing here assumes how.
- Recording orders, commission rules, payouts, and the dashboard's real figures.

## Decisions already made

- The storefront stays its own static site and reads from the tracker. It does
  not move into the tracker and does not read the database directly.
- The price a customer sees is the tradeline's `user_price` in the tracker. A
  tradeline with no price is not offered.
- One quantity is three months, as on the current store.
- The Checkout button says checkout is coming soon. Nothing is recorded.

## The tracker

### Public inventory endpoint

`GET /api/public/tradelines`. No sign-in. Not added to the middleware matcher,
which is what keeps it open, the way `/api/submissions` is.

Response:

```json
{
  "issuers": [
    { "key": "capital-one", "label": "Capital One", "count": 13, "fromPrice": 450 }
  ],
  "tradelines": [
    {
      "id": "41",
      "issuer": "capital-one",
      "name": "Capital One/Cabelas",
      "creditLimit": 500,
      "openDate": "2012-04-10",
      "age": "13.38356164",
      "price": 450
    }
  ]
}
```

Rules:

- Only tradelines with a price greater than nought are returned. `count` and
  `fromPrice` are worked out from those, so an issuer with nothing priced has
  `count` 0 and `fromPrice` null.
- Every issuer in `TRADELINE_ISSUERS` is present, in that order.
- Nothing else leaves: no `created_by`, `updated_by` or timestamps.
- `age` is the text as stored, as it is on the admin table. Null when none was
  given.
- Cached for sixty seconds (`Cache-Control: public, max-age=60`), so a busy shop
  does not read the database on every page view, and a new paste shows within a
  minute.
- CORS: `Access-Control-Allow-Origin` is the value of a new environment
  variable, `TRADELINES_SITE_URL`, when the request's `Origin` matches it, and
  also any `http://localhost:<port>` origin outside production. `GET` and
  `OPTIONS` only.
- When the database is not configured or the read fails, `503` with
  `{ "error": "..." }`.

The shaping is a pure function in a new `src/lib/tradelines-public.ts`
(`publicInventory(rows)`), so it is checked without a database. The route is a
thin wrapper around `listTradelines()` and that function.

### The affiliate's link

`TRADELINES_SITE_URL` is the storefront's public address, with no trailing
slash. A pure function, `tradelineLinkFor(siteUrl, ref)` in
`src/lib/tradeline-ref.ts`, returns `<siteUrl>/?ref=<ref>`, or `''` when either
is missing or the reference number is not well formed.

`TradelinesSummaryPanel` takes the link. With a link it shows the address and a
"Copy link" button, and the reference number beneath. Without one it reads
"Coming soon" exactly as now. So the panel changes the day the variable is set,
with no further deploy of logic.

## The storefront

### Pages

Client-side routes, using `react-router-dom`:

| Address | Page |
|---|---|
| `/` | The landing page as it is. Issuer cards link to the issuer pages. |
| `/tradelines/:issuer` | One issuer's tradelines, and the picker. |
| `/cart` | The cart. |
| anything else | A short "page not found" with a way home. |

The host must serve `index.html` for every path. A `vercel.json` rewrite is
added for that.

### Issuer page

Replaces the current store's product page, where the list is a set of
screenshots with one row highlighted and the choice is made in a dropdown.

- Heading with the issuer's logo and name, and "from $X".
- A table of that issuer's tradelines: name, credit limit, open date, age,
  price. Sortable by limit, age and price. On a phone each tradeline is a card
  rather than a table row.
- Choosing a row selects it. A panel beside the table (beneath it on a phone)
  shows the selection, a quantity stepper, the note "1 quantity = 3 months", the
  line total, and "Add to cart".
- After adding, the button confirms and offers "View cart". Adding a tradeline
  already in the cart raises its quantity.
- An issuer with nothing in stock says so and offers the other issuers.
- An unknown issuer in the address is the not-found page.

### Cart

- One line per tradeline: issuer, name, limit, open date, age, quantity stepper,
  line total, remove.
- Subtotal. An empty cart says so and links to the issuers.
- The cart icon in the header shows the number of lines, on every page.
- Kept in `localStorage` as tradeline ids and quantities only. Names and prices
  are always read from the live inventory, so a price changed in the tracker is
  the price the cart shows.
- A line whose tradeline is no longer offered is shown as "No longer available",
  left out of the subtotal, and can be removed.
- Quantity is a whole number from 1 to 12.
- The Checkout button is disabled and reads "Checkout coming soon", with the
  phone number beside it.

### The affiliate link

- Address: `https://<site>/?ref=TL-48213`. The parameter is read on any page.
- A well-formed reference number (`^TL-[0-9]{5}$`, the tracker's pattern) is
  saved in `localStorage`. It is not checked against the tracker in this build;
  that happens when an order is recorded.
- It does not expire. Once a customer has arrived through an affiliate's link,
  that affiliate's number stays with that browser for good.
- The first one seen is kept. A later link carrying a different affiliate's
  number does not replace it.
- A missing or malformed number is ignored. The customer shops as normal.
- The parameter is then removed from the address bar, so a customer who copies
  the address does not pass the number on by accident.
- Nothing about the affiliate is shown to the customer.

### Data

`src/data/content.ts` loses its prices, product ids, the old store's addresses
and the Capital One inventory. Issuer logos and brand colours stay, keyed by the
tracker's issuer keys. The FAQ answer that quotes prices is reworded so it
cannot go out of date.

Inventory is fetched once per visit from `VITE_TRACKER_URL` +
`/api/public/tradelines` and shared by every page. While it loads, pages show
skeletons. If it fails, the landing page still works; issuer pages and the cart
say the list cannot be loaded right now and show the phone number, with a retry.

### Look

The existing landing page's language is kept: Montserrat, the warm off-white,
the green, the soft rounded cards, the spring motion. The new pages are designed
with the frontend-design skill so that the table, the picker and the cart read
as part of the same site rather than as a generic shop template.

## Units

| Unit | Where | Does |
|---|---|---|
| `tradelines-public.ts` | tracker | Rows in, public inventory out. Pure. |
| `api/public/tradelines/route.ts` | tracker | Reads, shapes, sets cache and CORS headers. |
| `tradelineLinkFor` | tracker | Site address and reference number in, link out. Pure. |
| `lib/inventory.ts` | site | Fetches and holds the inventory; one request per visit. |
| `lib/cart.ts` | site | Cart lines, quantities, totals against an inventory. Pure, plus a storage wrapper. |
| `lib/ref.ts` | site | Reads, validates and keeps the reference number. Pure, plus a storage wrapper. |
| `pages/IssuerPage.tsx`, `pages/CartPage.tsx` | site | The two new pages. |

Checkout, when it is built, needs only `cart.ts` and `ref.ts` from the site, and
adds its own endpoint to the tracker.

## Testing

Tracker, in the style of the existing check scripts:

- `scripts/tradelines-public-checks.ts`: unpriced rows are dropped; counts and
  "from" prices are right; every issuer is present in order; no field outside
  the list above appears; age is passed through as text.
- `tradeline-ref-checks.ts` gains `tradelineLinkFor`: a good link, and `''` for
  a missing address, a missing number and a malformed one.
- `tradelines-render-checks.tsx`: the panel with a link shows it and a copy
  button; without one it still reads "Coming soon".

Site, with `vitest`, added for this:

- `cart`: adding, raising a quantity, the 1 to 12 bounds, removing, totals, a
  line whose tradeline has gone, a stored cart that is not valid JSON.
- `ref`: a good number is kept, a malformed one is not, the first one wins and
  is never replaced or dropped however old it is.

Then both run together locally, and each page is opened and screenshotted on a
desktop and a phone width: landing, an issuer page with a selection, an empty
issuer, the cart with lines, the empty cart, and the inventory-failed state.

## To be done by the owner

- Decide the storefront's public address and set `TRADELINES_SITE_URL` in the
  tracker and `VITE_TRACKER_URL` in the site. Until then the site works locally
  and the affiliate panel reads "Coming soon".
- Deploy the storefront.

## Open

- `Tradeline-LGF` is not a git repository. One is initialised as the first step
  of the build unless the owner says otherwise.
