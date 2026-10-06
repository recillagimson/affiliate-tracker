# Support tickets: design

Date: 2026-10-06
Status: awaiting review

## Purpose

Affiliates have no way to ask a question or give feedback inside the app.
This adds a Support section where an affiliate opens a ticket, admins answer
it, and the two sides carry on a conversation until it is closed. Admins can
also open a ticket with a specific affiliate.

Success means: an affiliate can ask something and get an answer without
leaving the app, neither side has to poll to find out there is something new,
and an admin can see at a glance which tickets are waiting on them.

## Decisions made with the owner

| Question | Decision |
|---|---|
| Reply model | Threaded conversation in the app |
| Notifications | Unread badge for both sides, email to the affiliate, Slack to admins |
| Category | Yes: Question, Payout issue, Bug, Feedback |
| Attachments | Images, video and PDF in a private Supabase Storage bucket (revised 2026-10-07; originally images in the database) |
| Who can open | Affiliates, and admins on behalf of a chosen affiliate |
| Reopening | A reply on a closed ticket reopens it |
| Unread state for admins | Shared: read by one admin is read for all |

## Out of scope

Assigning a ticket to a particular admin, priorities, canned replies,
editing or deleting a sent message, attachments that are not images, email
to admins, and per-admin unread counts.

## Naming

Modules, tables and routes are named `support`, not `ticket`. "Ticket"
already means the view-as ticket in `src/lib/impersonation.ts` and the
request counter in `src/lib/optimistic.ts`. The word "ticket" is still what
the interface calls the thing.

## Behaviour

### Tickets

- A ticket belongs to exactly one affiliate (`users.role = 'affiliate'`,
  which includes LGF employees).
- Fields set at opening: subject (1 to 150 characters), category, and a
  first message. None can be changed afterwards.
- Status is `open` or `closed`. Either side may close an open ticket. Either
  side may reopen a closed one explicitly, and any reply to a closed ticket
  reopens it as part of the same write.
- The list shows a derived label for open tickets: "Waiting on support" when
  the last message is from the affiliate. When it is from an admin, admins
  see "Waiting on affiliate" and the affiliate sees "Waiting on you".

### Messages

- Body is 1 to 5,000 characters of plain text, shown with line breaks kept
  and nothing interpreted as markup.
- A message records who wrote it as a role (`affiliate` or `admin`), a user
  id, and a display string built by `requestedByFor(viewer)`, so a message an
  admin sends from Client View reads "username (via Admin Name)" and has role
  `affiliate`.
- The env break-glass admin can reply; its id is `env:admin` and has no user
  row, so message author ids are plain text without a foreign key.
- Messages are never edited or deleted.

### Attachments

Revised 2026-10-07: attachments moved from base64 in the table to Supabase
Storage so a ticket can carry video and PDF. The plan document describes the
earlier design; `20261007120000_support_attachment_storage.sql` and the code
are current.

- PNG, JPEG or WebP images, MP4, MOV or WebM video, and PDF.
- At most 5 per message, 50 MB each (52,428,800 bytes).
- Files live in a private bucket, `support-attachments`, with no storage
  policies: only the service role reads or writes it. The bucket enforces
  the size limit and the type list itself.
- Upload is direct from the browser. The `upload` action checks each file's
  declared name, type and size and answers with a signed upload URL per file,
  under `<uploader id>/<uuid>/<safe name>`. The browser PUTs each file to
  storage, then sends the message with the paths.
- A message may only name paths inside the sender's own folder, in exactly
  that shape. Before anything is written the route reads each path back from
  storage and records the real size and type; a path with nothing at it is
  refused.
- `GET /api/support/attachments/<id>` checks the viewer may read the ticket
  and redirects to a signed link valid for 10 minutes. Files are served from
  storage's domain, never from this app's origin.
- Attachments are optional and always accompany a body.
- The attach control accepts drag and drop, a pasted screenshot, or Browse,
  lists each file with a preview, size and Remove, and shows upload progress.
- An affiliate's new-ticket form shows who it is filed as, read from the
  session.
- Files uploaded but never attached to a sent message are left in the bucket;
  nothing cleans them up yet.

### Read state and the badge

- A ticket carries `affiliate_read_at` and `admin_read_at`.
- A ticket is unread for the affiliate when the last message is from an admin
  and `affiliate_read_at` is null or earlier than `last_message_at`. It is
  unread for admins in the mirrored case.
- Opening the conversation page marks it read for the viewer's side through
  an explicit `read` action sent by the client after the page mounts. It is
  not done during server render, so a prefetched link never marks anything
  read.
- An admin in Client View sees the affiliate's tickets but the `read` action
  is not sent, so the affiliate's unread state is left alone.
- Sending a message marks the ticket read for the sender's side.
- The Support tab shows the count of unread tickets for the viewer, in both
  the desktop tabs and the mobile bar. Zero shows no badge.

### Notifications

- When an admin replies or opens a ticket: email the affiliate, if their
  `users.email` is not blank and email is configured. The email names the
  ticket subject, includes the reply text, and links to the conversation.
  Attachments are not included.
- When an affiliate opens a ticket or replies: post one line to the existing
  Slack webhook with the affiliate's username, subject, category and a link.
- Neither can fail the write. The message is saved first. An email failure
  returns `{ ok: true, emailed: false, emailProblem }` and the admin sees
  "Saved, but the email was not sent" with the reason. Slack failures are
  swallowed as they already are in `src/lib/slack.ts`.
- Closing or reopening without a message notifies nobody.

### Limits

Affiliate requests are throttled with `rateLimit` from `src/lib/ratelimit.ts`,
keyed by user id: 5 new tickets per hour and 30 replies per hour. Admins are
not throttled. A refused request returns 429 with a `Retry-After` header.

## Data

One migration, `supabase/migrations/20261006120000_support_tickets.sql`, in
the house style: explanatory header, `create table if not exists`, safe to
run twice, named constraints, `comment on table`, RLS enabled with no
policies, and `revoke all ... from anon, authenticated`.

### `support_tickets`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | primary key |
| `user_id` | text not null | FK `users (id)` on delete cascade |
| `subject` | text not null | check length 1 to 150 |
| `category` | text not null | check in `question`, `payout`, `bug`, `feedback` |
| `status` | text not null default `open` | check in `open`, `closed` |
| `opened_by` | text not null default `''` | display string |
| `opened_by_role` | text not null | check in `affiliate`, `admin` |
| `created_at` | timestamptz not null default now() | |
| `last_message_at` | timestamptz not null default now() | |
| `last_message_role` | text not null | check in `affiliate`, `admin` |
| `affiliate_read_at` | timestamptz | |
| `admin_read_at` | timestamptz | |
| `closed_at` | timestamptz | |
| `closed_by` | text not null default `''` | display string |

Indexes: `(user_id, last_message_at desc)` and `(status, last_message_at desc)`.

Deleting a person deletes their tickets, as it does their onboarding records.

### `support_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | primary key |
| `ticket_id` | bigint not null | FK `support_tickets (id)` on delete cascade |
| `author_role` | text not null | check in `affiliate`, `admin` |
| `author_id` | text not null default `''` | no FK, see env admin above |
| `author_name` | text not null default `''` | display string |
| `body` | text not null | check length 1 to 5000 |
| `created_at` | timestamptz not null default now() | |

Index: `(ticket_id, id)`.

### `support_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | primary key |
| `message_id` | bigint not null | FK `support_messages (id)` on delete cascade |
| `ticket_id` | bigint not null | FK `support_tickets (id)` on delete cascade; lets the file route check ownership in one read |
| `name` | text not null | |
| `type` | text not null | check in the seven file types |
| `size` | bigint not null | bytes, read back from storage |
| `path` | text not null | object path in the bucket |

Index: `(message_id)`.

### Functions

Called with `.rpc()` so each is one transaction. Refusals raise the existing
custom SQLSTATE codes that `src/lib/store/errors.ts` already maps; no new
codes are introduced.

- `create_support_ticket(user, subject, category, opener name, opener role,
  author id, body, attachments jsonb)` inserts the ticket, its first message
  and attachments, sets the last-message fields and the opener's read
  timestamp, and returns the ticket id. Refuses if the user is not an
  affiliate.
- `add_support_message(ticket, author role, author id, author name, body,
  attachments jsonb)` inserts the message and attachments, updates the
  last-message fields, sets the sender side's read timestamp, and sets status
  to `open` with the closed fields cleared if it was closed. Returns the
  message id. Refuses if the ticket does not exist.

- `mark_support_read(ticket, side, user)` sets that side's read timestamp
  with the database's `now()`. It is a function, not an update from the app,
  so the read time and `last_message_at` come from the same clock; an app
  server a second behind the database could otherwise leave a ticket unread
  for good. On the affiliate side the user id is part of the match.

Close and reopen are single-row updates done from the store, with the status
the ticket must currently have in the match.

The category and status lists exist in both SQL and TypeScript. A check
script reads the migration and asserts they match, as
`payout-request-store-checks.ts` does.

## Code

### `src/lib/support.ts` (pure)

Types (`SupportTicket`, `SupportMessage`, `SupportAttachmentMeta`), the
category and status constants with their labels, the limits, and functions:
`isUnreadFor(ticket, side)`, `waitingLabel(ticket)`, `unreadCount(tickets,
side)`, `sideFor(viewer)` (an admin acting as an affiliate is on the
affiliate side), `mayReadTicket(viewer, ticket)`, and
`checkSupportAttachments(input)` which applies the per-file and combined
limits on top of the receipt-file helpers.

### `src/lib/support-api.ts` (pure)

Request parsing in the style of `payout-api.ts`, reusing `asBody`,
`textField` and `Refusal`: `readSupportAction`, `readOpen`, `readReply`,
`readTicketId`, and the refusals for a closed-state mismatch (closing a
closed ticket, reopening an open one).

### `src/lib/support-store.ts`

Supabase only, beside the other feature stores. `supportEnabled()`, and
throws `StoreConfigError` without a database.

- `listSupportTickets(filter)` for admins: status, category, unread-only.
- `listSupportTicketsFor(userId)` for an affiliate; the owner id is in the
  query itself.
- `readSupportThread(id)` returns the ticket, its messages and attachment
  metadata.
- `countUnreadSupport(side, userId?)` for the badge.
- `openSupportTicket`, `addSupportMessage`, `closeSupportTicket`,
  `reopenSupportTicket`, `markSupportRead`.
- `readSupportAttachment(id)` returns the file and its ticket's owner id.

### Routes

- `POST /api/support`, one handler, `{ action, ... }`:

  | Action | Who | Notes |
  |---|---|---|
  | `open` | affiliate, or admin with `userId` | an affiliate's `userId` always comes from the session |
  | `reply` | owner or admin | reopens if closed |
  | `close` | owner or admin | |
  | `reopen` | owner or admin | |
  | `read` | owner or admin | no-op under Client View |

  Uses `viewerFromRequest`; ownership is decided from the viewer, never from
  the body. A ticket that is not the viewer's answers 404, not 403, so ids
  cannot be probed. Returns `{ error, hint? }` with a status on refusal.
- `GET /api/support/attachments/[id]` serves one image inline.

Both are `force-dynamic`.

### Pages

- `src/app/(admin)/support/page.tsx`: the list. Admins get filters in
  `searchParams` (status defaulting to open, category, unread) and `Pager`.
  Affiliates get their own tickets, newest activity first. `EmptyState` when
  there are none.
- `src/app/(admin)/support/[id]/page.tsx`: the conversation. `notFound()`
  when the viewer may not read it.

Both call `requireViewer()`.

### Components

- `SupportList.tsx`: rows with subject, category chip, status pill, waiting
  label, last activity, unread dot, and for admins the affiliate's name.
- `NewTicket.tsx`: a `Modal` form with subject, category, message, image
  picker, and for admins an affiliate picker.
- `SupportThread.tsx`: messages in order with author and time, image
  thumbnails that open full size, the reply form, and Close / Reopen. Sends
  the `read` action on mount.

They use the existing `.panel`, `.field`, `.pill-status`, `.chip` and button
classes; no new design tokens.

### Wiring

- `src/components/Nav.tsx`: a `Support` item for everyone, its `isActive`
  line, and an optional `supportUnread` prop on `Nav` and `MobileTabs` that
  renders the badge.
- `src/app/(admin)/layout.tsx`: computes the count with `countUnreadSupport`
  and passes it down. If the store is not enabled or the query fails the
  count is zero and the page still renders.
- `src/middleware.ts`: `/support`, `/support/:path*`, `/api/support`,
  `/api/support/:path*` added to the matcher.
- `src/lib/emails/support-reply.ts`: `supportReplyEmail`, a pure function
  returning a `Message`, text and HTML together, no em dashes.
- `src/lib/slack-messages.ts` and `src/lib/slack.ts`: `supportMessage` and
  `announceSupport`.

## Errors

| Case | Result |
|---|---|
| No database configured | Page shows `ErrorPanel` with the store's message; routes return the status from `statusForError` |
| Ticket missing or not the viewer's | 404 |
| Invalid subject, body, category or attachment | 400 with a message naming the field (422 if only the database catches it) |
| Attachments over the count or size limit | 400 naming the limit |
| Throttled | 429 with `Retry-After` |
| Email fails after a saved reply | 200, `emailed: false`, reason shown to the admin |
| Slack fails | swallowed |

## Checks

In the existing `scripts/*-checks.ts` style, each run with `npx tsx`:

- `support-checks.ts`: unread and waiting-label logic for every combination
  of last author and read timestamps, `sideFor` under impersonation,
  `mayReadTicket`, attachment limits including a mislabelled file.
- `support-api-checks.ts`: every action's parser, bad and missing fields,
  state refusals.
- `support-store-checks.ts`: category, status and image-type lists in the
  migration match the TypeScript.
- `support-reply-email-checks.ts` and additions to the Slack message checks:
  content, escaping, link.
- `support-render-checks.tsx`: list and thread render for affiliate and
  admin, empty state, badge present and absent.

`npm run typecheck` and `npm run build` must pass.

## Rollout

The owner runs the migration in the Supabase SQL Editor first; localhost
uses the live database, so the code cannot be exercised before that. No new
environment variables. Without the migration the Support tab shows the
store's error panel and the badge stays at zero; nothing else is affected.
