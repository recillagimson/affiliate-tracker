# Tradelines checkout and orders: design

Date: 2026-10-12
Status: awaiting review

## Purpose

The storefront ends at a cart whose Checkout button says "coming soon". This
build makes it a checkout: the customer gives their details and places an
order, and the order is recorded in the tracker against the affiliate who sent
them. From that record the owner sees every order and marks it paid, and the
affiliate sees what they have sold and what they have earned.

It is the second of the tradelines builds. Card payment (through GoHighLevel)
and paying commissions out through the payout system are the two that follow.

## Where things stand

- `Tradeline-LGF` (the storefront): issuer pages, a cart kept in the browser as
  tradeline ids and quantities, and an affiliate reference number kept in the
  browser (`lgf.ref`). Reads stock from the tracker's `/api/public/tradelines`.
- `affiliate-tracker`: the tradelines table; `users.tradeline_ref`; a dashboard
  for affiliates on Tradelines whose figures come from `tradelineSummaryFor` in
  `src/lib/tradeline-sales.ts`, which returns noughts.
- Sensitive numbers already kept by the tracker (W-9 tax ids, bank account
  numbers) are sealed with `src/lib/secret-box.ts` (AES-256-GCM, key in
  `ONBOARDING_SECRET_KEY`) and stored beside their last four digits.
- A tradeline row's id is not permanent: pasting a sheet with "replace" deletes
  an issuer's rows and inserts new ones.

## Decisions already made

- Guest checkout. No customer account.
- The checkout asks for: full name, email address, mobile number, date of
  birth, SSN, and address.
- Commission is a fixed $200 for each tradeline line in an order. Quantity does
  not multiply it.
- A commission is earned when an admin marks the order paid, not when it is
  placed.
- A customer with no reference number, or one that is not a tradelines
  affiliate's, can still buy. That is a house sale and earns nobody anything.
- An LGF employee earns no tradeline commission, as they earn none on cards.
- An affiliate sees the customer's name on their own orders and nothing else
  about the customer.
- Commissions will be paid out through the existing payout system. That is the
  next build, not this one. Until it exists, earned commissions accumulate
  under "Pending payout".

## Scope

In this build:

1. A checkout page and a confirmation page in the storefront.
2. A public endpoint in the tracker that takes an order.
3. Order records, with the customer's SSN and date of birth sealed.
4. An admin Orders page: list, detail, mark paid, cancel, reveal SSN.
5. Real figures and a real list on the affiliate's tradelines dashboard.
6. A confirmation email to the customer.

Not in this build:

- Taking a card. An order is placed unpaid and the owner collects the money by
  whatever means they use today.
- Tradeline commissions in monthly payouts and payslips.
- Refunds, editing an order after it is placed, customer accounts.

## Records

One migration, `20261014120000_tradeline_orders.sql`. Same access model as
every other table: RLS on, no policies, revoked from `anon` and
`authenticated`; only the server's service role reads or writes.

### `tradeline_orders`

| Column | Notes |
|---|---|
| `id` | bigint identity, primary key |
| `order_number` | text, unique. `LGF-` and six digits, drawn at random by trigger, the way reference numbers are. What the customer is given. |
| `created_at` | timestamptz |
| `status` | `awaiting_payment`, `paid` or `cancelled` |
| `paid_at`, `paid_by` | set together when marked paid; null otherwise |
| `cancelled_at`, `cancelled_by` | set together when cancelled; null otherwise |
| `customer_name`, `customer_email`, `customer_mobile` | text |
| `address_line1`, `address_line2`, `city`, `state`, `zip` | text. `state` is a two-letter US state or DC; `zip` is five digits or ZIP+4. |
| `ssn_encrypted`, `ssn_last4` | sealed SSN, and its last four digits |
| `dob_encrypted` | sealed date of birth |
| `tradeline_ref` | the reference number the order arrived with, or `''`. Kept as given, for the record. |
| `affiliate_user_id` | the affiliate credited, or null for a house sale. References `users(id)`; deleting a user with orders is refused. |
| `total` | numeric(12,2), the sum of the line totals |

Checks: the status and its timestamps agree (an order awaiting payment has
neither date, a paid one has `paid_at` and no `cancelled_at`, a cancelled one
has `cancelled_at`, and keeps its `paid_at` as history if it had been paid); `ssn_encrypted` and
`dob_encrypted` are not empty; `total` is greater than nought.

### `tradeline_order_items`

One row per tradeline in the order. A copy, not a pointer, because the
tradeline's own row may be gone tomorrow.

| Column | Notes |
|---|---|
| `id` | bigint identity, primary key. Stable, so the payout build can refer to it. |
| `order_id` | references `tradeline_orders(id)`, cascade |
| `issuer`, `name`, `credit_limit`, `open_date`, `age_years` | as the tradeline read when ordered |
| `unit_price`, `quantity`, `line_total` | `quantity` from 1 to 12 |
| `commission` | numeric(12,2). 200.00 when the order has an affiliate who earns, otherwise 0. Fixed here at order time, so changing the rate later does not rewrite what was agreed. |

### `tradeline_ssn_reveals`

`id`, `order_id`, `revealed_at`, `revealed_by`. One row each time an admin
reveals an order's SSN and date of birth.

### Placing an order

A SQL function, `place_tradeline_order(p_order jsonb, p_items jsonb)`, inserts
the order and its items in one transaction and returns the order number, so an
order is never saved without its lines.

## The tracker

### Taking an order

`POST /api/public/tradeline-orders`. No sign-in; outside the middleware's
matcher, like the stock list.

Request:

```json
{
  "ref": "TL-48213",
  "items": [{ "id": "64", "quantity": 2 }],
  "expectedTotal": 2200,
  "customer": {
    "name": "", "email": "", "mobile": "", "dob": "1990-04-10", "ssn": "123-45-6789",
    "address": { "line1": "", "line2": "", "city": "", "state": "NY", "zip": "12345" }
  },
  "confirmed": true,
  "company": ""
}
```

What the route does, in order:

1. Refuses when `secretsConfigured()` is false, with a plain "checkout is not
   available right now". An SSN is never stored unsealed.
2. Rate limit by address: 5 orders in 10 minutes (`lib/ratelimit`).
3. `company` is a field no person sees. If it is filled in, answer as if the
   order was placed and save nothing.
4. Validates every field (see below). A failure answers `422` with a message
   per field.
5. Reads the live tradelines and prices each line from them. The prices in the
   request are never used. A line whose id is not on offer answers `409` with
   `{ "error": ..., "gone": ["64"] }`.
6. Compares the total it worked out with `expectedTotal`. A difference answers
   `409` with `{ "error": ..., "total": <the real total> }`, so a customer never
   agrees to one price and is recorded at another.
7. Finds the affiliate: a user whose `tradeline_ref` equals `ref`, who is an
   active affiliate with `tradelines` among their services. Otherwise a house
   sale. Each line's commission is 200 if there is an affiliate and they are
   not an LGF employee, else 0.
8. Seals the SSN and the date of birth, keeps the SSN's last four, and calls
   `place_tradeline_order`.
9. Sends the confirmation email. A failure to send does not fail the order.
10. Answers `201` with `{ "orderNumber": "LGF-204871", "total": 2200 }`.

Nothing from the request body is ever logged.

CORS: the same rule as the stock list (`allowedOrigin`), with `POST` and the
`content-type` header allowed.

### Validation

A pure module, `src/lib/tradeline-order.ts`, so it is checked without a
database:

- `name`: 2 to 120 characters.
- `email`: looks like an address; at most 200 characters.
- `mobile`: ten digits once punctuation is removed, or eleven beginning with 1.
  Stored as ten digits.
- `dob`: a real date, `YYYY-MM-DD`; the customer is at least 18 and at most 120.
- `ssn`: nine digits once dashes and spaces are removed; not all one digit; the
  area is not `000`, `666` or `9xx`; the group is not `00`; the serial is not
  `0000`.
- `address`: `line1` 3 to 120 characters; `line2` optional, at most 120; `city`
  2 to 80; `state` one of the fifty states or DC; `zip` five digits or ZIP+4.
- `items`: 1 to 20 lines, each a known id once, quantity a whole number from 1
  to 12.
- `confirmed`: must be true.

### The Orders page

`/tradelines/orders`, admins only (`requireAdmin`), linked from the Tradelines
page. The Tradelines tab stays lit.

- A list, newest first: order number, date, customer, tradelines (count),
  total, affiliate (or "House sale"), status. Filter by status. Search by order
  number, customer name or email.
- `/tradelines/orders/[orderNumber]`: the customer's details, the lines, the
  affiliate and commission, and the order's history (placed, paid, cancelled,
  by whom).
- The SSN shows as `•••-••-1234` and the date of birth as hidden. "Reveal"
  asks for confirmation, then shows both for that page view and writes a row
  to `tradeline_ssn_reveals`.
- "Mark paid" on an order awaiting payment. "Cancel order" on one awaiting
  payment or paid; both ask for confirmation. A cancelled order cannot be
  brought back. A paid order's commission stops counting once cancelled.

Admin actions go through `POST /api/tradeline-orders` (`pay`, `cancel`,
`reveal`), which is inside the middleware's matcher and checks
`requireApiAdmin` itself.

### The affiliate's dashboard

`tradelineSummaryFor` takes the affiliate's user id and reads their orders:

- **Income:** the commissions on their paid orders.
- **Pending payout:** the same figure, until the payout build subtracts what
  has been paid out.
- **Checkouts:** the number of their orders that are not cancelled.

`/tradelines/dashboard` lists their orders, newest first: date, order number,
customer name, the tradelines, order total, status, and commission. An order
awaiting payment shows its commission as "$200.00 when paid"; a cancelled one
shows none. Nothing else about the customer is sent to the page.

### Email

`src/lib/emails/tradeline-order.ts`: to the customer, on placing an order. The
order number, the lines and total, that the order is awaiting payment and how
they will be contacted, and the phone number. No SSN, date of birth or address.
Skipped quietly when email is not configured.

## The storefront

### Pages

| Address | Page |
|---|---|
| `/checkout` | The form and the order summary. |
| `/checkout/done` | The order number and what happens next. |

The cart's button becomes "Checkout" and goes to `/checkout`. With an empty
cart, `/checkout` sends the customer back to the cart.

### The form

Summary beside the form on a wide screen, above it on a phone: each line, its
quantity and months, and the total.

Fields, each with a visible label and the right keyboard and autofill hints:
full name; email; mobile; date of birth; Social Security number; address line
1; address line 2 (optional); city; state (a list); ZIP. A sentence beside the
SSN says why it is needed (to add them to the account as an authorized user)
and that it is encrypted. A tick-box: "I have checked the tradelines above and
my details are correct."

- Checked in the browser with the same rules as the tracker, for speed; the
  tracker's answer is the one that counts, and its per-field messages are shown
  beside the fields.
- The SSN field is masked as it is typed, with a show/hide control. Nothing the
  customer types is written to browser storage.
- "Place order" is disabled while sending, so a double press is one order.
- A `409` for a gone tradeline or a changed total explains what changed,
  refreshes the stock list, and leaves the form filled in.
- A network failure says so and leaves the form filled in.

On success the cart is emptied and the customer is taken to `/checkout/done`,
which shows the order number and says a confirmation has been emailed. Opened
directly with no order, it goes to the home page.

The reference number is sent with the order and is not shown.

## Units

| Unit | Where | Does |
|---|---|---|
| `tradeline-order.ts` | tracker | Reads and validates an order request; prices it against the stock list; decides commission. Pure. |
| `tradeline-order-store.ts` | tracker | Places, lists, reads, pays, cancels; records and performs a reveal. |
| `api/public/tradeline-orders/route.ts` | tracker | The public door: limits, validation, sealing, email. |
| `api/tradeline-orders/route.ts` | tracker | Admin actions. |
| `tradeline-sales.ts` | tracker | An affiliate's summary and order list, from their orders. |
| Orders pages, `TradelineOrders.tsx` | tracker | Admin list and detail. |
| `lib/checkout.ts` | site | The same field rules, and the request body from cart, form and reference number. Pure. |
| `pages/CheckoutPage.tsx`, `CheckoutDonePage.tsx` | site | The two pages. |

The field rules exist twice, once per repository. A check in each pins the same
table of examples, so they cannot drift apart unnoticed.

## Testing

Tracker check scripts:

- `tradeline-order-checks.ts`: every field rule, good and bad; pricing from
  the stock list ignores request prices; a gone id; a total mismatch; the
  commission for an affiliate, a house sale and an LGF employee; duplicate ids
  and out-of-range quantities.
- `tradeline-orders-migration-checks.ts`: reads the migration and pins the
  status values, the paired-timestamp checks, the access model, the cascade,
  and that it can be run twice.
- `tradeline-sales-checks.ts`: income counts paid orders only; cancelled paid
  orders stop counting; awaiting-payment orders are listed and earn nothing
  yet; the list carries the customer's name and no other customer field.
- Render checks: the admin detail masks the SSN and hides the date of birth
  until revealed; the affiliate's list never contains an SSN, date of birth,
  email, mobile or address.

Site, with vitest:

- `checkout`: the field rules against the same examples; the request body;
  what a `409` and a `422` turn into for the page.

Then both run together locally with the migration applied, and a real order is
placed through the browser at desktop and phone width: house sale, affiliate
sale, a tampered total, a tradeline removed mid-checkout, marking paid,
cancelling, revealing, and the affiliate's dashboard before and after.

## To be done by the owner

- Run `20261014120000_tradeline_orders.sql` in the Supabase SQL Editor before
  the checkout is used. `20261013120000_tradeline_ref.sql` must already be in.
- Confirm `ONBOARDING_SECRET_KEY` is set wherever the tracker runs. Without it
  the checkout refuses orders rather than store an SSN unsealed.
- Have a privacy notice the checkout can link to that covers collecting SSNs.
  The build links to the existing privacy policy address.

## Open

- Testing places real rows in the live database, since localhost uses it. Test
  orders are placed with obviously fake details and cancelled afterwards; the
  owner may prefer to delete them.
