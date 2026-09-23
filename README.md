# Affiliate Ledger

Create affiliate links assigned to a person, capture the client's details on a short
landing page, log every one to Google Sheets, and forward the client to the merchant.

```
https://www.cardratings.com/bestcards/cash-back-credit-cards.php?src=714025   ← destination
http://localhost:3000/cashback?usr=arthur                                     ← your affiliate link
```

## What's in it

| Page | Path | What it does |
| --- | --- | --- |
| Dashboard | `/` | Earnings, a five-week chart, one row per person, recorded approvals |
| One person | `/affiliate/<usr>` | The same numbers broken down per card, and the approvals behind them |
| Affiliate links | `/links` | Every link with its shareable URL, assignee and visits; pause / delete |
| Create link | `/links/new` | Build a link: destination + slug + assignee, with a live URL preview |
| Sign in | `/login` | Username and password, once a password is set |
| Landing page | `/<slug>?usr=<person>` | The client's fill-up form, then a redirect to the destination |

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
```

It works immediately with no configuration — data goes to `./.data/*.json`. Wire up
Google Sheets when you're ready; the app switches over automatically.

## Connect Google Sheets

1. **Create a spreadsheet.** A blank one is fine — the tabs and headers are created
   for you on first write.
2. **Google Cloud Console** → create (or pick) a project → **APIs & Services** →
   **Enable APIs** → enable **Google Sheets API**.
3. **IAM & Admin → Service Accounts** → *Create service account* → then
   **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
4. **Share the spreadsheet** with the `client_email` from that JSON file, as an
   **Editor**. This step is the one people forget — without it you get a 403.
5. Copy `.env.example` to `.env.local` and set the spreadsheet id:

```bash
GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
```

That id is the long string between `/d/` and `/edit` in the sheet URL — **not** the
number after `#gid=`, which identifies a tab.

6. Give it the credentials, either way you prefer:

**A — the JSON key file** (simplest locally). Drop the file Google gave you into the
project root as `service-account.json`. Nothing else to configure; it's gitignored.
Keeping it elsewhere, or reusing one you already have, works too:

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=../lgf-automation/service-account.json
```

`GOOGLE_APPLICATION_CREDENTIALS` (Google's own convention) is honoured as well.

**B — environment variables**, for hosts with no filesystem to put a key on, such as
Vercel. Copy the two fields out of the same JSON file:

```bash
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-bot@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```

Keep the quotes and the literal `\n` sequences exactly as they appear in the JSON key.
If both are set, the environment variables win — a deployed environment is never
silently overridden by a stray file.

7. Restart the dev server. The header will read **Google Sheets connected**.

> Don't commit the key file, and don't put real values in `.env.example` — that file
> is the template that gets committed. Real values belong in `.env.local`.

### Sheet layout

Three tabs, created automatically:

- **Links** — `id, created_at, slug, usr, assignee, assignee_email, campaign, destination, headline, subheadline, cta_label, require_phone, pass_usr_param, active, notes`
- **Visits** — `id, created_at, slug, usr, referrer, user_agent, ip`
- **Conversions** — `created_at, approved_on, slug, usr, amount, notes`
- **Submissions** — `id, created_at, slug, usr, assignee, campaign, full_name, email, phone, destination, referrer, user_agent, ip, status` (only written while the capture form is on)

You can read, filter and pivot these rows in Sheets freely. Don't reorder or rename the
header columns — the app maps by position. Adding columns of your own to the *right* of
the last one is fine; putting one in the middle is refused with an error rather than
silently filing values under the wrong headings.

## Tell Slack about approvals

Every approval recorded — by hand on the dashboard, from the Approve button on a
lead, or imported by a report sync — can post a line to one Slack channel.

1. **api.slack.com/apps** → *Create New App* → *From scratch* → pick your workspace.
2. **Incoming Webhooks** → turn on → *Add New Webhook to Workspace* → choose the channel.
3. Put the URL Slack gives you in `.env.local`, and in your host's environment settings:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/xxxxxxxx
```

A message reads:

```
LEDGER - AFFILIATE APPROVAL 🎉
Affiliate Name: Gimson Recilla
CARD: Best Cards | Client Jefferson Florez · Chase Freedom Unlimited(R)
Approved: 23 Sept 2026
```

**It never carries an amount, an affiliate's share or the commission rate** — a channel is
read by everyone invited to it, and the figures stay behind the sign-in. The card line
drops whichever of the campaign, client and card is not on record, and goes entirely when
none of them is.

A sync names the approvals it imported, up to ten, then says how many more there were,
then posts one summary. Nothing here can stop an approval being recorded: the approval is
written first, and a channel that is unreachable is reported on the sync screen and
otherwise ignored.

## What a click does

A visit is recorded server-side and the visitor is **forwarded straight to the
destination** — no interstitial, no form. `pass_usr_param` still appends the assignee's
key, so `/cashback?usr=arthur` lands on `…?src=714025&subid=arthur`.

Paused and unknown links are unchanged: a paused link shows the paused notice rather
than forwarding, and an unknown slug is a 404.

**The capture form is hidden, not deleted.** Set `CAPTURE_FORM=on` and the landing page,
its form, the Submissions tab and the leads panel all come back with their data intact.

Two parts of the admin surface follow that switch rather than sitting at zero while it is
off: the **Leads** and **Turned into leads** columns on `/links`, and the **What the
visitor sees** step on `/links/new` (headline, sub-headline, button label). With no
landing page there is nothing to write copy for and no lead to count. Turn the form back
on and both reappear; links created meanwhile just fall back to the campaign name for
their headline.

## Dashboard

One row per person: **Person · Visits · Approved · Total earnings**, with everyone's
cards folded together. **Click a person** to open their own page, which breaks the same
numbers down **per card** and lists the approvals behind them. The two views cannot
disagree — they are the same rollup grouped one level apart.

- **Visits** are counted when the click happens.
- **Approved** and **Total earnings** come from the Conversions tab. Nothing produces
  them automatically — record them with *Record an approval*, or type them into the
  tab. That is also the shape a network postback would write if one is wired up later.

A conversion row stores only `slug` + `usr` — the link those point at supplies the
person's name and the card, so neither is written twice and they can never disagree.
Renaming a campaign therefore renames its historic earnings too, and deleting a link
leaves its old sales showing the bare slug and tracking key. That is the trade for one
name in one place. The tab has **no id column**: a row is addressed by its position plus
a fingerprint of its contents, so a Remove clicked after someone inserted a row in the
sheet is refused rather than applied to whatever shifted into that slot.
- Filter by **Today / 7 days / 30 days / All time** and by **person**. Both live in the
  URL, so a filtered view can be bookmarked or shared. The periods are rolling windows,
  not calendar ones — "7 days" is the last seven days including today.
- **The chart is five rolling weeks**, and follows the person filter but not the period:
  the shape of the last five weeks is the context you read the selected window against,
  so narrowing to "Today" should not also shrink the chart to one bar. Every bar carries
  its own number, and a week with nothing draws a flat stub rather than nothing at all.

## How it looks

Light throughout — ink on paper at 14:1, Source Serif for figures and Public Sans for
interface. Four rules the whole surface obeys, and they are worth keeping if you edit it:

1. **Nothing under 17px.** Uppercase micro-labels bottom out at 16px.
2. **Every edge is 2px.** A 1px hairline disappears at this contrast.
3. **Every control is at least 52px tall**, most are 56–68px.
4. **Gold is a fill behind dark text, never text itself** — `#F0C24B` on paper is 1.4:1.
   `--color-gold-deep` is the gold you are allowed to set type in.

Keyboard focus is a 2px ink edge with a 4px gold ring outside it: the ink half does the
work on the gold and green fills, the gold half on paper and white, so one indicator
survives every surface. Every metric carries a plain-English line under its label — the
jargon stays and the sentence says it again in words.

Tokens live in `src/app/globals.css`. Prefer the component classes there (`.panel`,
`.btn-primary`, `.pill-filter`, `.field`, `.plain`) over re-deriving a control from
utilities, or the sizes and the focus ring drift apart.

Visits are bucketed by when the click happened, approvals by their approval date. An
approval that lands three weeks after the click counts in the week it was approved,
which is when it was actually earned — so a period can show approvals with no visits.

A click carrying an unknown `?usr=` gets its own row rather than being credited to
someone else. A row you don't recognise means a stale link is in circulation.

## Signing in

Set `ADMIN_PASSWORD` and the admin surface asks for a **username and password** at
`/login`. `ADMIN_USER` is the username and defaults to `admin`. That pair *is* the
account — there is no user table, no sign-up, no password reset, and no third-party
sign-in button, because there is nobody to sign up and no identity provider to defer to.

A successful sign-in sets a signed, `httpOnly` cookie that lasts `SESSION_HOURS` (default
12). It is signed with `ADMIN_PASSWORD`, so **changing the password signs everyone out** —
which is what you want when someone leaves. Set `SESSION_SECRET` only if you need
sessions to survive a password change instead.

Following a gated link while signed out remembers where you were going, so
`/affiliate/mark?period=week` lands there after you sign in rather than dumping you on the
dashboard. Only paths on this site are honoured: `//evil.example`, `https://evil.example`
and `/\evil.example` all collapse to `/`, or the sign-in form would be an open redirect
with a password prompt attached.

Sign-in is rate limited to **8 attempts per IP per 10 minutes**, and a wrong username and
a wrong password give the same message — saying which half was wrong tells an attacker
when they have found the username.

**HTTP Basic still works** for `curl -u user:pass` and any script written against the old
behaviour. What no longer happens is the browser's own credential box: no
`WWW-Authenticate` challenge is sent, so a browser gets the sign-in page instead.

## Lead status

*Only applies while `CAPTURE_FORM=on`.*

Every captured lead is **pending** the moment the form is submitted. Nothing sets it —
it's what a new lead is. **Registered** is only ever set by a person, either way round:

- **On the dashboard** — click the status pill on any row. It writes straight to the
  sheet. Filter the list by All / Pending / Registered to work through the backlog.
- **In the spreadsheet** — column **N** of the Submissions tab, a dropdown. Changing it
  there shows up on the dashboard on the next load.

The cell is read forgivingly, so `Registered`, `yes` and `done` typed by hand all count;
anything else (including an empty cell, which is what every row logged before this
column existed has) reads as pending. A lead is only registered when someone says so.

## How a link works

Creating a link stores a `slug` (the path) and a `usr` (the assignee's tracking key):

- `/cashback?usr=arthur` → the row created for **cashback + arthur**
- `/cashback?usr=bianca` → the row created for **cashback + bianca**
- `/cashback` → the campaign's house row (the one created with no assignee)
- `/cashback?usr=someone-unknown` → still lands, still logged, attributed to no one
  rather than dropped

**Pause is per assignee.** Pausing Arthur's link shows the "offer is paused" page to
Arthur's traffic; it does not quietly hand those visitors Bianca's link. The campaign
only reads as fully paused when every row for the slug is paused.

**Deleting a link does not stop its URL.** If another assignee still has a live row for
that slug, the URL keeps working and falls back to them. To take a URL down, pause it.

**Pass usr to destination as** (optional, per link): set it to e.g. `subid` and the
client is forwarded to `...?src=714025&subid=arthur`. Leave it blank — the default —
and the destination is forwarded exactly as you entered it.

## Before you deploy

- **Set `ADMIN_PASSWORD`.** The dashboard lists lead names, emails and phone numbers.
  With it set, `/`, `/links*`, `/affiliate/*`, `/api/links*`, `/api/leads*` and
  `/api/conversions*` send you to `/login`; affiliate links stay public. A production
  build with no password returns 503 on the admin pages rather than exposing them — set
  `ALLOW_OPEN_ADMIN=true` to override that deliberately. Development is always open so
  `npm run dev` needs no configuration.
- **Set `NEXT_PUBLIC_BASE_URL`** to your public origin (e.g. `https://go.yourdomain.com`)
  so the copyable links aren't `localhost`.
- Landing pages are marked `noindex` — they're interstitials, not content.

## Notes and limits

- **Rate limiting** on submissions is per-instance and in-memory (12 per IP / 10 min;
  a looser per-campaign cap when no proxy header reveals the IP). On multiple
  instances, move it to Redis. The IP is a throttling hint, never identity — behind no
  proxy, `x-forwarded-for` is client-controlled.
- **Link creation** checks for a duplicate slug+usr by reading before writing. Two
  people creating the identical link in the same second could both succeed. Edits and
  deletes re-check the target row's id immediately before writing, so a concurrent
  change aborts rather than overwriting a different link.
- **An unrecognised `?usr=`** is logged as-is so you can spot stale or mistyped links
  on the dashboard, but it is never appended to the merchant URL — only a key that
  exists in your Links tab is passed on.
- **A lead is never written twice by a retry**: the one retry on the submission write
  only fires for failures that provably never reached Google.
- **Visit tracking** is a `sendBeacon` from the landing page, so ad blockers and
  clients that bail before the beacon fires will undercount. Conversion rate is
  directional, not exact. Set `TRACK_VISITS=false` to turn it off.
- **Timestamps** are stored in UTC (ISO-8601); the dashboard buckets days in UTC.
- If a lead's row fails to write, the client sees a retry message rather than being
  forwarded — losing a lead silently is worse than a second attempt.

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm start           # serve the production build
npm run typecheck   # tsc --noEmit
```
