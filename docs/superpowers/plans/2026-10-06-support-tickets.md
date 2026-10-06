# Support Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give affiliates an in-app Support section where they open tickets and hold a threaded conversation with admins, with image attachments, unread badges, email to the affiliate and Slack to admins.

**Architecture:** Follows the Payouts feature end to end. One Supabase migration (three tables, three functions), a Supabase-only store module, two pure modules holding every decision (domain rules and request parsing) pinned by `scripts/*-checks.ts`, one POST route with `{ action }` bodies plus one GET route for images, and two server-component pages with three client components.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5.7, `@supabase/supabase-js` with the service-role key, Tailwind v4 with the hand-written classes in `src/app/globals.css`, Resend over `fetch`, Slack incoming webhook. Checks are standalone `tsx` scripts; there is no test runner.

**Spec:** `docs/superpowers/specs/2026-10-06-support-tickets-design.md`

## Global Constraints

- All paths are relative to the app root: `/Users/gimson/Desktop/Development Projects/affiliate-tracker/affiliate-tracker`.
- Work on branch `feat/support-tickets`. Never push to a remote. Commit messages are conventional commits with scope `support`, and carry no Claude co-author or "Generated with" lines.
- Name modules, tables and routes `support`, never `ticket` (that word is taken by `src/lib/impersonation.ts` and `src/lib/optimistic.ts`). The interface still says "ticket".
- No sentence a person can read contains an em dash or en dash (`\u2013`, `\u2014`). Checks assert this.
- Limits, verbatim from the spec: subject 1 to 150 characters; body 1 to 5,000 characters; at most 3 attachments per message; at most 3,000,000 decoded bytes across a message; types `image/png`, `image/jpeg`, `image/webp`; affiliates throttled to 5 new tickets per hour and 30 replies per hour.
- Categories: `question`, `payout`, `bug`, `feedback`. Statuses: `open`, `closed`.
- Mutations are API route handlers only. No `'use server'`.
- Pages import `@/lib/viewer`; routes import `@/lib/api-auth`. Never cross them.
- Ownership always comes from the viewer, never from the request body. A ticket that is not the viewer's answers 404, never 403.
- Every new lib file, route and migration opens with a prose header comment saying what it is and why, in the style of its neighbours.
- No new dependencies and no new environment variables.
- Each check script is run with `npx tsx scripts/<name>.ts`; render checks with `npx tsx --tsconfig scripts/render.tsconfig.json scripts/<name>.tsx`. A script exits 1 when any check fails.
- The database is live: localhost uses the production Supabase project. Do not run the migration yourself. The owner applies it in the SQL Editor. Nothing before Task 8 needs it applied.

## Review Focus

1. **App clock behind the database clock.** A reader opens a ticket seconds after a reply; if `read_at` came from the app server's clock it could be earlier than `last_message_at` and the ticket would stay unread forever. Marking read must use the database's `now()`. Pinned in Task 2.
2. **Slack markup in a subject.** A subject of `<!channel>` or `<http://evil|click>` must post as literal text, not ping a channel or render a disguised link. Pinned in Task 4.
3. **Admin in Client View opens a thread.** The affiliate's unread state must be untouched, so they still see the badge when they sign in themselves. Pinned in Task 3.
4. **Three images at the size limit.** The JSON body must stay under the host's 4.5 MB request limit, and a body the host rejects anyway must reach the person as a sentence, not a failed `res.json()`. Pinned in Tasks 1 and 7.
5. **Affiliate with no email on file.** An admin reply must still save, and the admin must be told no email went and why. Pinned in Task 3.

---

### Task 1: Domain rules (`src/lib/support.ts`)

**Files:**
- Create: `src/lib/support.ts`
- Test: `scripts/support-checks.ts`

**Interfaces:**
- Consumes: `isBase64`, `decodedSize`, `headBytes`, `matchesType`, `cleanFileName` from `src/lib/receipt-file.ts`; type `Viewer` from `src/lib/viewer-core.ts`.
- Produces (exact names later tasks use):
  - Constants `SUPPORT_CATEGORIES`, `CATEGORY_LABELS`, `SUPPORT_STATUSES`, `SUPPORT_IMAGE_TYPES`, `MAX_SUBJECT`, `MAX_BODY`, `MAX_ATTACHMENTS`, `MAX_ATTACHMENT_BYTES`.
  - Types `SupportCategory`, `SupportStatus`, `SupportSide`, `SupportImageType`, `SupportTicket`, `SupportAttachmentMeta`, `SupportMessage`, `SupportUpload`, `SupportRow`, `StatusFilter`, `AttachmentCheck`.
  - Functions `isSupportCategory(v): v is SupportCategory`, `isSupportStatus(v)`, `isSupportImageType(v)`, `sideFor(viewer): SupportSide`, `mayReadTicket(viewer, ownerUserId): boolean`, `isUnreadFor(ticket, side): boolean`, `unreadCount(tickets, side): number`, `waitingLabel(ticket, side): string`, `badgeText(count): string`, `checkSupportAttachments(input: unknown): AttachmentCheck`, `buildSupportRows(tickets, side, names): SupportRow[]`, `statusFilterFrom(v): StatusFilter`, `categoryFilterFrom(v): SupportCategory | ''`, `supportHref(filter): string`.

- [ ] **Step 1: Write the failing checks**

Create `scripts/support-checks.ts`:

```ts
// Support tickets, as arithmetic: who may read one, when it counts as unread,
// what the list says about it, and what an attached image has to be.
//
// The unread rule is the one worth pinning hardest. It decides the badge both
// sides rely on to notice a reply, and it is a comparison of two timestamps
// and a role, which is exactly the kind of thing that is right in three cases
// and wrong in the fourth.
//
//   npx tsx scripts/support-checks.ts

import {
  badgeText,
  buildSupportRows,
  CATEGORY_LABELS,
  categoryFilterFrom,
  checkSupportAttachments,
  isSupportCategory,
  isUnreadFor,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  mayReadTicket,
  sideFor,
  statusFilterFrom,
  SUPPORT_CATEGORIES,
  supportHref,
  unreadCount,
  waitingLabel,
  type SupportTicket,
} from '../src/lib/support';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const said: string[] = [];
function heard<T extends string>(text: T): T {
  said.push(text);
  return text;
}

function ticket(patch: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: '7',
    userId: 'u1',
    subject: 'Where is my payout?',
    category: 'payout',
    status: 'open',
    openedBy: 'maria',
    openedByRole: 'affiliate',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastMessageAt: '2026-10-01T10:00:00.000Z',
    lastMessageRole: 'affiliate',
    affiliateReadAt: '2026-10-01T10:00:00.000Z',
    adminReadAt: null,
    closedAt: null,
    closedBy: '',
    ...patch,
  };
}

console.log('- sides and access -');
check('an admin is on the admin side', sideFor({ role: 'admin' }) === 'admin');
check('an affiliate is on the affiliate side', sideFor({ role: 'affiliate' }) === 'affiliate');
check('an admin may read any ticket', mayReadTicket({ role: 'admin', id: 'a1' }, 'u1'));
check('the env admin too', mayReadTicket({ role: 'admin', id: 'env:admin' }, 'u1'));
check('an affiliate may read their own', mayReadTicket({ role: 'affiliate', id: 'u1' }, 'u1'));
check('and nobody else\'s', !mayReadTicket({ role: 'affiliate', id: 'u2' }, 'u1'));
check('a blank id matches nobody, even a blank owner', !mayReadTicket({ role: 'affiliate', id: '' }, ''));

console.log('- unread -');
check('an affiliate\'s own new ticket is not unread for them', !isUnreadFor(ticket(), 'affiliate'));
check('but it is unread for admins who have never opened it', isUnreadFor(ticket(), 'admin'));
check(
  'once an admin has read it, it is not',
  !isUnreadFor(ticket({ adminReadAt: '2026-10-01T10:05:00.000Z' }), 'admin'),
);
check(
  'an admin read before the affiliate\'s latest message does not count',
  isUnreadFor(
    ticket({ adminReadAt: '2026-10-01T10:05:00.000Z', lastMessageAt: '2026-10-01T11:00:00.000Z' }),
    'admin',
  ),
);
const replied = ticket({
  lastMessageRole: 'admin',
  lastMessageAt: '2026-10-01T12:00:00.000Z',
  adminReadAt: '2026-10-01T12:00:00.000Z',
});
check('an admin reply is unread for the affiliate', isUnreadFor(replied, 'affiliate'));
check('and not for admins', !isUnreadFor(replied, 'admin'));
check(
  'reading it at the same instant it was written counts as read',
  !isUnreadFor({ ...replied, affiliateReadAt: '2026-10-01T12:00:00.000Z' }, 'affiliate'),
);
check(
  'an admin-opened ticket the affiliate has never seen is unread for them',
  isUnreadFor(ticket({ openedByRole: 'admin', lastMessageRole: 'admin', affiliateReadAt: null }), 'affiliate'),
);
check(
  'a timestamp that cannot be read is treated as never read',
  isUnreadFor({ ...replied, affiliateReadAt: 'nonsense' }, 'affiliate'),
);
check('counting', unreadCount([ticket(), replied, ticket({ id: '9' })], 'admin') === 2);
check('counting nothing', unreadCount([], 'affiliate') === 0);

console.log('- what the list says -');
check('waiting on support, for both sides', waitingLabel(ticket(), 'admin') === heard('Waiting on support'));
check('and the affiliate reads the same', waitingLabel(ticket(), 'affiliate') === 'Waiting on support');
check('an admin sees who they are waiting on', waitingLabel(replied, 'admin') === heard('Waiting on affiliate'));
check('the affiliate is told it is them', waitingLabel(replied, 'affiliate') === heard('Waiting on you'));
check('a closed ticket is just closed', waitingLabel(ticket({ status: 'closed' }), 'admin') === heard('Closed'));
check('no badge text for nothing', badgeText(0) === '');
check('a count as itself', badgeText(3) === '3');
check('capped', badgeText(140) === '99+');
check('a negative or broken count shows nothing', badgeText(-1) === '' && badgeText(Number.NaN) === '');

const rows = buildSupportRows(
  [ticket(), replied],
  'admin',
  new Map([['u1', 'Maria Santos']]),
);
check('one row per ticket, in the order given', rows.map((r) => r.id).join() === '7,7');
check('the category is labelled', rows[0]!.category === CATEGORY_LABELS.payout);
check('the person is named', rows[0]!.person === 'Maria Santos');
check('unread carries through', rows[0]!.unread && !rows[1]!.unread);
check(
  'an account that is gone still gets a row',
  buildSupportRows([ticket({ userId: 'gone' })], 'admin', new Map())[0]!.person === heard('Unknown account'),
);
for (const label of Object.values(CATEGORY_LABELS)) heard(label);
check('every category has a label', SUPPORT_CATEGORIES.every((c) => CATEGORY_LABELS[c].length > 0));
check('a category is recognised', isSupportCategory('bug') && !isSupportCategory('Bug') && !isSupportCategory(3));

console.log('- filters -');
check('open by default', statusFilterFrom(undefined) === 'open');
check('closed when asked', statusFilterFrom(' Closed ') === 'closed');
check('all when asked', statusFilterFrom('all') === 'all');
check('nonsense falls back to open', statusFilterFrom('x') === 'open');
check('a category from the URL', categoryFilterFrom('bug') === 'bug');
check('nonsense is no category', categoryFilterFrom('x') === '' && categoryFilterFrom(undefined) === '');
check('the default view is the bare path', supportHref({ status: 'open', category: '', unread: false }) === '/support');
check(
  'everything else is spelled out',
  supportHref({ status: 'closed', category: 'bug', unread: true }) === '/support?status=closed&category=bug&unread=1',
);

console.log('- attachments -');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function image(type: string, head: number[], size: number, name = 'shot.png') {
  const bytes = Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length))]);
  return { name, type, data: `data:${type};base64,${bytes.toString('base64')}` };
}
const none = checkSupportAttachments(undefined);
check('no attachments is fine', none.ok && none.files.length === 0);
check('null too', checkSupportAttachments(null).ok);
const good = checkSupportAttachments([image('image/png', PNG, 2000)]);
check('a real PNG is kept', good.ok && good.files.length === 1);
check('with its exact size', good.ok && good.files[0]!.size === 2000);
check('and stored as bare base64', good.ok && !good.files[0]!.data.startsWith('data:'));
check('its name is kept', good.ok && good.files[0]!.name === 'shot.png');
const pathy = checkSupportAttachments([image('image/png', PNG, 2000, 'C:\\Users\\me\\shot.png')]);
check('a path is cut down to the file name', pathy.ok && pathy.files[0]!.name === 'shot.png');
const nameless = checkSupportAttachments([{ ...image('image/png', PNG, 2000), name: undefined }]);
check('a missing name becomes a plain one', nameless.ok && nameless.files[0]!.name === 'image');
const jpeg = checkSupportAttachments([image('image/jpeg', [0xff, 0xd8, 0xff, 0xe0], 500)]);
check('a JPEG is kept', jpeg.ok);
function refused(input: unknown): string {
  const result = checkSupportAttachments(input);
  if (result.ok) return '';
  heard(result.error);
  heard(result.hint);
  return result.error;
}
check('something that is not a list is refused', refused('x') !== '');
check('four is one too many', refused(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => image('image/png', PNG, 100))) !== '');
check('a PDF is not an image', refused([image('application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d], 500)]) !== '');
check('an SVG is refused', refused([image('image/svg+xml', [0x3c, 0x73, 0x76, 0x67], 500)]) !== '');
check('a text file renamed to PNG is refused', refused([image('image/png', [0x68, 0x65, 0x6c, 0x6c, 0x6f], 500)]) !== '');
check('a PNG declared as JPEG is refused', refused([image('image/jpeg', PNG, 500)]) !== '');
check('a missing payload is refused', refused([{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,' }]) !== '');
check('junk in the base64 is refused', refused([{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo!!!!' }]) !== '');
check('an entry that is not an object is refused', refused([null]) !== '');
check('one image over the limit is refused', refused([image('image/png', PNG, MAX_ATTACHMENT_BYTES + 1)]) !== '');
check(
  'three that are over it together are refused',
  refused([
    image('image/png', PNG, 1_200_000),
    image('image/png', PNG, 1_200_000),
    image('image/png', PNG, 1_200_000),
  ]) !== '',
);
const full = checkSupportAttachments([
  image('image/png', PNG, 1_000_000),
  image('image/png', PNG, 1_000_000),
  image('image/png', PNG, 1_000_000),
]);
check('three that add up to exactly the limit are kept', full.ok && full.files.length === 3);
// Review focus 4: the largest body this accepts has to fit under the host's
// 4.5 MB request limit with room for the text and the JSON around it.
const largestBody = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 5_000 * 4 + 2_000;
check('the largest accepted message fits a 4.5 MB request', largestBody < 4_500_000, largestBody);

check('there was something to read', said.length > 12, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log(`\nsupport: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx scripts/support-checks.ts`
Expected: fails to start with `Cannot find module '../src/lib/support'`.

- [ ] **Step 3: Write the module**

Create `src/lib/support.ts`:

```ts
/**
 * Support tickets: the rules, as plain functions.
 *
 * An affiliate opens a ticket, admins answer it, and the two sides talk until
 * it is closed. Everything here is a decision that needs no database and no
 * request: who is on which side, who may read what, when a ticket counts as
 * unread, what the list says about it, and what an attached image has to be
 * before it is kept. scripts/support-checks.ts pins all of it.
 *
 * Named "support" rather than "ticket" throughout, because that word already
 * means the view-as ticket in lib/impersonation.ts and the request counter in
 * lib/optimistic.ts. The pages still call the thing a ticket.
 *
 * Pure. receipt-file.ts is the only import with code in it, and that is pure
 * too, so the checks load this file without a database, a session or Next.js.
 */

import { cleanFileName, decodedSize, headBytes, isBase64, matchesType } from './receipt-file';
import type { Viewer } from './viewer-core';

/* -------------------------------------------------------------- constants --- */

/** The same four, in the same order, as the check constraint in the migration. */
export const SUPPORT_CATEGORIES = ['question', 'payout', 'bug', 'feedback'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<SupportCategory, string> = {
  question: 'Question',
  payout: 'Payout issue',
  bug: 'Bug',
  feedback: 'Feedback',
};

export const SUPPORT_STATUSES = ['open', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Which half of the conversation somebody is on. */
export type SupportSide = 'affiliate' | 'admin';

/**
 * Images only. A ticket attachment is a screenshot of what somebody is asking
 * about; a PDF is a document, and documents already have their own places in
 * this app. SVG is left out for the reason receipt-file.ts gives.
 */
export const SUPPORT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportImageType = (typeof SUPPORT_IMAGE_TYPES)[number];

export const MAX_SUBJECT = 150;
export const MAX_BODY = 5_000;
export const MAX_ATTACHMENTS = 3;

/*
 * Across one message, not per file. The files travel as base64 inside the JSON
 * body, a third larger than they are, and the host refuses a request over
 * about 4.5 MB. Three megabytes of image is four of base64, which leaves room
 * for the text around it.
 */
export const MAX_ATTACHMENT_BYTES = 3_000_000;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

export function isSupportImageType(value: unknown): value is SupportImageType {
  return typeof value === 'string' && (SUPPORT_IMAGE_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ shape --- */

export type SupportTicket = {
  id: string;
  /** The affiliate the ticket belongs to, whoever opened it. */
  userId: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  openedBy: string;
  openedByRole: SupportSide;
  createdAt: string;
  lastMessageAt: string;
  lastMessageRole: SupportSide;
  affiliateReadAt: string | null;
  /** Shared by every admin: read by one is read for all. */
  adminReadAt: string | null;
  closedAt: string | null;
  closedBy: string;
};

/** An attachment without its bytes, which is all a page ever needs to draw it. */
export type SupportAttachmentMeta = { id: string; name: string; type: string; size: number };

export type SupportMessage = {
  id: string;
  authorRole: SupportSide;
  authorId: string;
  /** "username", or "username (via Admin Name)" when sent from Client View. */
  authorName: string;
  body: string;
  createdAt: string;
  attachments: SupportAttachmentMeta[];
};

/** An image that has passed every check, as the store keeps it. `data` is bare base64. */
export type SupportUpload = { name: string; type: SupportImageType; data: string; size: number };

/* ----------------------------------------------------------------- access --- */

/**
 * An admin in Client View is the affiliate as far as the session goes, role
 * and all, so they land on the affiliate side with no special case here.
 */
export function sideFor(viewer: Pick<Viewer, 'role'>): SupportSide {
  return viewer.role === 'admin' ? 'admin' : 'affiliate';
}

/** An admin, or the affiliate the ticket belongs to. A blank id is nobody's. */
export function mayReadTicket(viewer: Pick<Viewer, 'role' | 'id'>, ownerUserId: string): boolean {
  if (viewer.role === 'admin') return true;
  return viewer.id !== '' && viewer.id === ownerUserId;
}

/* ----------------------------------------------------------------- unread --- */

/**
 * Whether this side has something it has not read.
 *
 * Only a message from the other side can be unread; your own never is. Then
 * it is unread until this side's read time is at or after it. A read time
 * that cannot be parsed counts as never read, so a damaged row shows a badge
 * rather than hiding a reply.
 */
export function isUnreadFor(
  ticket: Pick<SupportTicket, 'lastMessageRole' | 'lastMessageAt' | 'affiliateReadAt' | 'adminReadAt'>,
  side: SupportSide,
): boolean {
  if (ticket.lastMessageRole === side) return false;
  const readAt = side === 'affiliate' ? ticket.affiliateReadAt : ticket.adminReadAt;
  if (!readAt) return true;
  const read = Date.parse(readAt);
  const last = Date.parse(ticket.lastMessageAt);
  if (!Number.isFinite(read)) return true;
  return read < last;
}

export function unreadCount(
  tickets: Pick<SupportTicket, 'lastMessageRole' | 'lastMessageAt' | 'affiliateReadAt' | 'adminReadAt'>[],
  side: SupportSide,
): number {
  return tickets.filter((ticket) => isUnreadFor(ticket, side)).length;
}

/** What the tab's badge says. Nothing at all for zero. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/* --------------------------------------------------------------- the list --- */

/**
 * Whose move it is. The affiliate is told "you" rather than "affiliate":
 * a label describing the reader in the third person reads as somebody else.
 */
export function waitingLabel(
  ticket: Pick<SupportTicket, 'status' | 'lastMessageRole'>,
  side: SupportSide,
): string {
  if (ticket.status === 'closed') return 'Closed';
  if (ticket.lastMessageRole === 'affiliate') return 'Waiting on support';
  return side === 'affiliate' ? 'Waiting on you' : 'Waiting on affiliate';
}

export type SupportRow = {
  id: string;
  subject: string;
  /** The category's label, ready to show. */
  category: string;
  status: SupportStatus;
  waiting: string;
  unread: boolean;
  lastAt: string;
  /** The affiliate's name. Shown to admins only. */
  person: string;
};

export function buildSupportRows(
  tickets: SupportTicket[],
  side: SupportSide,
  names: Map<string, string>,
): SupportRow[] {
  return tickets.map((ticket) => ({
    id: ticket.id,
    subject: ticket.subject,
    category: CATEGORY_LABELS[ticket.category],
    status: ticket.status,
    waiting: waitingLabel(ticket, side),
    unread: isUnreadFor(ticket, side),
    lastAt: ticket.lastMessageAt,
    person: names.get(ticket.userId) ?? 'Unknown account',
  }));
}

/* ---------------------------------------------------------------- filters --- */

export type StatusFilter = SupportStatus | 'all';

/** Open unless the URL says otherwise: the open ones are the work. */
export function statusFilterFrom(value: unknown): StatusFilter {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'closed' || text === 'all' ? text : 'open';
}

export function categoryFilterFrom(value: unknown): SupportCategory | '' {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isSupportCategory(text) ? text : '';
}

export function supportHref(filter: {
  status: StatusFilter;
  category: SupportCategory | '';
  unread: boolean;
}): string {
  const params: string[] = [];
  if (filter.status !== 'open') params.push(`status=${filter.status}`);
  if (filter.category) params.push(`category=${filter.category}`);
  if (filter.unread) params.push('unread=1');
  return params.length === 0 ? '/support' : `/support?${params.join('&')}`;
}

/* ------------------------------------------------------------ attachments --- */

export type AttachmentCheck =
  | { ok: true; files: SupportUpload[] }
  | { ok: false; error: string; hint: string };

const BROKEN = 'Those images did not arrive in one piece.';
const AGAIN = 'Try attaching them again.';

function no(error: string, hint: string): AttachmentCheck {
  return { ok: false, error, hint };
}

/**
 * Everything a message's images have to be before they are stored, in the
 * order that costs least to ask: how many, what they claim to be, how big they
 * are together, and last the bytes themselves.
 *
 * The same two defences receipts get. The declared type is what the file was
 * called, not what it is, so the first bytes have to be that type's signature
 * or the file is refused rather than stored and trusted later.
 */
export function checkSupportAttachments(input: unknown): AttachmentCheck {
  if (input === undefined || input === null) return { ok: true, files: [] };
  if (!Array.isArray(input)) return no(BROKEN, AGAIN);
  if (input.length > MAX_ATTACHMENTS) {
    return no(`Up to ${MAX_ATTACHMENTS} images can be attached to a message.`, 'Remove one and send it again.');
  }

  const files: SupportUpload[] = [];
  let total = 0;
  for (const entry of input) {
    const item = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const type = item.type;
    if (!isSupportImageType(type)) {
      return no('Only images can be attached.', 'A PNG, JPEG or WebP screenshot.');
    }

    const prefix = `data:${type};base64,`;
    const data = item.data;
    if (typeof data !== 'string' || !data.startsWith(prefix)) return no(BROKEN, AGAIN);
    const payload = data.slice(prefix.length);
    if (!payload) return no(BROKEN, AGAIN);

    // Counted from the length before the payload is scanned, so an oversized
    // upload is turned away without reading all of it.
    const size = decodedSize(payload);
    total += size;
    if (total > MAX_ATTACHMENT_BYTES) {
      return no('Those images are too large together.', 'Up to about 3 MB in total. Try fewer, or crop them.');
    }

    if (!isBase64(payload)) return no(BROKEN, AGAIN);
    if (!matchesType(headBytes(payload), type)) {
      return no(
        'One of those files does not look like the image it claims to be.',
        'Attach the original PNG, JPEG or WebP, not a renamed copy.',
      );
    }

    const name = typeof item.name === 'string' && item.name.trim() !== '' ? cleanFileName(item.name) : 'image';
    files.push({ name, type, data: payload, size });
  }
  return { ok: true, files };
}
```

- [ ] **Step 4: Run the checks to make sure they pass**

Run: `npx tsx scripts/support-checks.ts`
Expected: last line `support: N passed, 0 failed`, exit code 0.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support.ts scripts/support-checks.ts
git commit -m "feat(support): ticket rules as pure functions"
```

---

### Task 2: Migration and store

**Files:**
- Create: `supabase/migrations/20261006120000_support_tickets.sql`
- Create: `src/lib/support-store.ts`
- Test: `scripts/support-store-checks.ts`

**Interfaces:**
- Consumes: from Task 1, `SUPPORT_CATEGORIES`, `SUPPORT_STATUSES`, `SUPPORT_IMAGE_TYPES`, `MAX_SUBJECT`, `MAX_BODY`, `MAX_ATTACHMENTS`, `isSupportCategory`, `isSupportStatus`, `isUnreadFor`, types `SupportTicket`, `SupportMessage`, `SupportSide`, `SupportStatus`, `SupportCategory`, `SupportUpload`. From the codebase: `getSupabaseClient`, `isSupabaseConfigured` (`src/lib/store/supabase.ts`); `StoreConfigError`, `StoreConflictError`, `StoreNotFoundError`, `StoreValidationError` (`src/lib/store/errors.ts`).
- Produces:
  - `supportEnabled(): boolean`
  - `listSupportTickets(filter: { status?: SupportStatus; category?: SupportCategory }): Promise<SupportTicket[]>`
  - `listSupportTicketsFor(userId: string): Promise<SupportTicket[]>`
  - `readSupportTicket(id: string, forUserId?: string): Promise<SupportTicket | null>`
  - `readSupportThread(id: string, forUserId?: string): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null>`
  - `countUnreadSupport(side: SupportSide, userId?: string): Promise<number>`
  - `openSupportTicket(input: { userId: string; subject: string; category: SupportCategory; openedBy: string; openedByRole: SupportSide; authorId: string; body: string; files: SupportUpload[] }): Promise<string>`
  - `addSupportMessage(input: { ticketId: string; authorRole: SupportSide; authorId: string; authorName: string; body: string; files: SupportUpload[] }): Promise<string>`
  - `closeSupportTicket(id: string, closedBy: string, forUserId?: string): Promise<boolean>`
  - `reopenSupportTicket(id: string, forUserId?: string): Promise<boolean>`
  - `markSupportRead(id: string, side: SupportSide, userId: string): Promise<void>`
  - `readSupportAttachmentTicket(attachmentId: string): Promise<string | null>` (the ticket id)
  - `readSupportAttachmentFile(attachmentId: string): Promise<{ name: string; type: string; data: string } | null>`
  - Exported for the checks only: `toTicket(row)`, `toMessage(row)`, `supportFailure(context, error): never`.
- SQL functions: `create_support_ticket`, `add_support_message`, `mark_support_read`.

- [ ] **Step 1: Write the failing checks**

Create `scripts/support-store-checks.ts`:

```ts
// The support store without a database: the migration agrees with the
// TypeScript, rows become the shapes the pages read, and the database's
// refusals become the store's own error classes.
//
// The first of those is the one that drifts. The category, status and image
// type lists each exist twice, once in a check constraint and once in
// lib/support.ts, and nothing but this file makes them the same list.
//
//   npx tsx scripts/support-store-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_ATTACHMENTS,
  MAX_BODY,
  MAX_SUBJECT,
  SUPPORT_CATEGORIES,
  SUPPORT_IMAGE_TYPES,
  SUPPORT_STATUSES,
} from '../src/lib/support';
import { supportFailure, toMessage, toTicket } from '../src/lib/support-store';
import {
  StoreConfigError,
  StoreNotFoundError,
  StoreValidationError,
} from '../src/lib/store/errors';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261006120000_support_tickets.sql');

console.log('- the migration -');
check('it exists under its name', existsSync(MIGRATION));
const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';

/** The quoted values inside `<column> in ( ... )` for a named constraint. */
function listIn(constraint: string): string[] {
  const at = sql.indexOf(`constraint ${constraint}`);
  if (at === -1) return [];
  const match = /\bin\s*\(([^)]*)\)/.exec(sql.slice(at, at + 400));
  return match ? [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!) : [];
}

check(
  'the categories are the same list, in the same order',
  listIn('support_tickets_category_check').join() === SUPPORT_CATEGORIES.join(),
  listIn('support_tickets_category_check'),
);
check(
  'the statuses too',
  listIn('support_tickets_status_check').join() === SUPPORT_STATUSES.join(),
  listIn('support_tickets_status_check'),
);
check(
  'and the image types',
  listIn('support_attachments_type_check').join() === SUPPORT_IMAGE_TYPES.join(),
  listIn('support_attachments_type_check'),
);
check('the subject limit is the same number', sql.includes(`between 1 and ${MAX_SUBJECT}`));
check('the body limit is the same number', sql.includes(`between 1 and ${MAX_BODY}`));
check('the attachment count is the same number', sql.includes(`jsonb_array_length(v_files) > ${MAX_ATTACHMENTS}`));
for (const table of ['support_tickets', 'support_messages', 'support_attachments']) {
  check(`${table} has row level security on`, sql.includes(`alter table public.${table} enable row level security`));
  check(`${table} is revoked from the public roles`, sql.includes(`revoke all on public.${table} from anon, authenticated`));
}
for (const fn of ['create_support_ticket', 'add_support_message', 'mark_support_read']) {
  check(`${fn} is defined`, sql.includes(`create or replace function public.${fn}(`));
  check(`${fn} runs with an empty search path`, new RegExp(`function public\\.${fn}\\([\\s\\S]*?set search_path = ''`).test(sql));
}
check('deleting a person deletes their tickets', /references public\.users \(id\) on delete cascade/.test(sql));
// Review focus 1: the read time is the database's clock, never the app's.
const markRead = sql.slice(sql.indexOf('function public.mark_support_read('));
check('marking read uses the database clock for the affiliate', /affiliate_read_at = now\(\)/.test(markRead));
check('and for admins', /admin_read_at = now\(\)/.test(markRead));
check('an affiliate can only mark their own', /affiliate_read_at = now\(\)\s+where id = p_ticket_id and user_id = p_user_id/.test(markRead));
const literals = [...sql.replace(/--.*$/gm, '').matchAll(/'([^']*)'/g)].map((m) => m[1]!);
check('no sentence in it carries a dash', literals.every((text) => !/[\u2013\u2014]/.test(text)));

console.log('- rows -');
const ticket = toTicket({
  id: 12,
  user_id: 'u1',
  subject: 'Hello',
  category: 'bug',
  status: 'closed',
  opened_by: 'maria',
  opened_by_role: 'affiliate',
  created_at: '2026-10-01T10:00:00+00:00',
  last_message_at: '2026-10-01T11:00:00+00:00',
  last_message_role: 'admin',
  affiliate_read_at: null,
  admin_read_at: '2026-10-01T11:00:00+00:00',
  closed_at: '2026-10-02T09:00:00+00:00',
  closed_by: 'gimson',
});
check('the id is carried as a string', ticket.id === '12');
check('a null read time stays null', ticket.affiliateReadAt === null);
check('a read time is carried', ticket.adminReadAt === '2026-10-01T11:00:00+00:00');
check('the fields land where they belong', ticket.userId === 'u1' && ticket.category === 'bug' && ticket.status === 'closed' && ticket.lastMessageRole === 'admin' && ticket.closedBy === 'gimson');
const odd = toTicket({ id: 1, category: 'nonsense', status: 'nonsense', last_message_role: 'x', opened_by_role: 'x' });
check('a category this version does not know reads as a question', odd.category === 'question');
check('a status it does not know reads as open', odd.status === 'open');
check('a role it does not know reads as the affiliate', odd.lastMessageRole === 'affiliate' && odd.openedByRole === 'affiliate');
const message = toMessage({
  id: 4,
  author_role: 'admin',
  author_id: 'a1',
  author_name: 'gimson',
  body: 'Hi',
  created_at: '2026-10-01T11:00:00+00:00',
  support_attachments: [
    { id: 9, name: 'b.png', type: 'image/png', size: 20 },
    { id: 8, name: 'a.png', type: 'image/png', size: 10 },
  ],
});
check('a message carries its author', message.authorRole === 'admin' && message.authorName === 'gimson');
check('its attachments come back in the order they were added', message.attachments.map((a) => a.id).join() === '8,9');
check('a message with none has an empty list', toMessage({ id: 5, body: 'x' }).attachments.length === 0);

console.log('- refusals -');
function thrown(code: string, message = 'Something.'): unknown {
  try {
    supportFailure('testing', { code, message });
  } catch (error) {
    return error;
  }
  return null;
}
check('LG001 is a validation error', thrown('LG001') instanceof StoreValidationError);
check('LG003 is a validation error', thrown('LG003') instanceof StoreValidationError);
check('LG005 is not found', thrown('LG005') instanceof StoreNotFoundError);
check('its sentence is the database\'s own', (thrown('LG005', 'That ticket no longer exists.') as Error).message === 'That ticket no longer exists.');
check('a dashed sentence is replaced', !/[\u2013\u2014]/.test((thrown('LG005', 'Gone \u2014 sorry') as Error).message));
check('a missing table is a configuration error', thrown('42P01') instanceof StoreConfigError);
check('PostgREST\'s word for it too', thrown('PGRST205') instanceof StoreConfigError);
check('a missing function is a configuration error', thrown('PGRST202') instanceof StoreConfigError);
check('the account vanishing mid-write is not found', thrown('23503') instanceof StoreNotFoundError);
const unknown = thrown('XX000', 'boom') as Error;
check('anything else names what it was doing', unknown.message.startsWith('testing:'));

console.log(`\nsupport-store: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx scripts/support-store-checks.ts`
Expected: fails to start with `Cannot find module '../src/lib/support-store'`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261006120000_support_tickets.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Support tickets: an affiliate asks a question or gives feedback, and the two
-- sides talk in the app until it is closed.
--
-- Three tables. The ticket (public.support_tickets) is the conversation's
-- header: whose it is, what it is about, whether it is open, and who spoke
-- last. The messages (public.support_messages) are the conversation. The
-- attachments (public.support_attachments) are the screenshots, kept as base64
-- the way public.payout_requests keeps a receipt, and for the same reason
-- never selected by a list query.
--
-- Unread is two timestamps on the ticket, one per side, compared against
-- last_message_at. Every admin shares admin_read_at: read by one is read for
-- all. Both are only ever written with now() inside this database, never with
-- the app server's clock, so a reader a second behind the database cannot
-- leave a ticket permanently unread.
--
-- The category, status and image type lists are the same lists as in
-- lib/support.ts, and so are 150, 5000 and 3. scripts/support-store-checks.ts
-- reads this file and fails if any of them disagree.
--
-- Same access model as every other table here: RLS on, no policies, revoked
-- from anon and authenticated. Only the server's service role reads or writes.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,

  -- The affiliate the ticket belongs to, whoever opened it. Cascade: a ticket
  -- is a conversation with a person, and means nothing once they are gone.
  user_id text not null
    constraint support_tickets_user_id_fkey references public.users (id) on delete cascade,

  subject text not null,
  category text not null,
  status text not null default 'open',

  -- Who pressed the button, as a sentence: "username", or
  -- "username (via Admin Name)" from Client View.
  opened_by text not null default '',
  opened_by_role text not null,
  created_at timestamptz not null default now(),

  -- Kept on the ticket so a list can sort and badge without reading messages.
  last_message_at timestamptz not null default now(),
  last_message_role text not null,

  affiliate_read_at timestamptz,
  admin_read_at timestamptz,

  closed_at timestamptz,
  closed_by text not null default '',

  constraint support_tickets_subject_check check (char_length(subject) between 1 and 150),
  constraint support_tickets_category_check
    check (category in ('question', 'payout', 'bug', 'feedback')),
  constraint support_tickets_status_check
    check (status in ('open', 'closed')),
  constraint support_tickets_opened_by_role_check
    check (opened_by_role in ('affiliate', 'admin')),
  constraint support_tickets_last_message_role_check
    check (last_message_role in ('affiliate', 'admin')),
  -- A status and the timestamp that proves it travel together.
  constraint support_tickets_closed_pair_check
    check ((status = 'closed') = (closed_at is not null))
);

comment on table public.support_tickets is
  'One row per support conversation between an affiliate and the admins: what it is about, whether it is open, who spoke last, and when each side last read it.';

-- An affiliate's own list, newest activity first.
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, last_message_at desc);

-- The admin list, which opens on the open ones.
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_message_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

create table if not exists public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets (id) on delete cascade,

  author_role text not null,
  -- No foreign key on purpose: the environment admin writes as 'env:admin',
  -- which has no row in public.users.
  author_id text not null default '',
  author_name text not null default '',

  body text not null,
  created_at timestamptz not null default now(),

  constraint support_messages_author_role_check
    check (author_role in ('affiliate', 'admin')),
  constraint support_messages_body_check check (char_length(body) between 1 and 5000)
);

comment on table public.support_messages is
  'The messages of a support ticket, oldest first. Never edited or deleted.';

create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, id);

alter table public.support_messages enable row level security;
revoke all on public.support_messages from anon, authenticated;

create table if not exists public.support_attachments (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.support_messages (id) on delete cascade,
  -- Repeated from the message so the file route can find the owner in one
  -- small read before it ever asks for the bytes.
  ticket_id bigint not null references public.support_tickets (id) on delete cascade,

  name text not null,
  type text not null,
  size integer not null,
  -- Bare base64. Never selected by a list or a thread read: see
  -- lib/support-store.ts, where the columns are spelled out.
  data text not null,

  constraint support_attachments_type_check
    check (type in ('image/png', 'image/jpeg', 'image/webp')),
  constraint support_attachments_size_check check (size > 0),
  constraint support_attachments_data_check check (char_length(data) > 0)
);

comment on table public.support_attachments is
  'Images attached to a support message, as base64. Served one at a time through a signed-in route.';

create index if not exists support_attachments_message_idx
  on public.support_attachments (message_id);

create index if not exists support_attachments_ticket_idx
  on public.support_attachments (ticket_id);

alter table public.support_attachments enable row level security;
revoke all on public.support_attachments from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Opening a ticket: the ticket, its first message and its images, in one
-- transaction or not at all.
--
-- p_attachments is a jsonb array of
--   {"name": <text>, "type": <text>, "size": <int>, "data": <base64 text>}.
-- The app has already checked each file's signature; this function only
-- counts them, and the table's constraints refuse a type that is not an image.
--
-- Errors, which lib/support-store.ts maps to its own classes:
--   LG001  a subject, message, category or image list it cannot accept (422)
--   LG003  the account is not an affiliate, or does not exist          (422)
-- ---------------------------------------------------------------------------
create or replace function public.create_support_ticket(
  p_user_id text,
  p_subject text,
  p_category text,
  p_opened_by text,
  p_opened_by_role text,
  p_author_id text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_ticket_id bigint;
  v_message_id bigint;
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_subject) not between 1 and 150 then
    raise exception 'A ticket needs a subject of up to 150 characters.' using errcode = 'LG001';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_category is null or p_category not in ('question', 'payout', 'bug', 'feedback') then
    raise exception 'Choose what the ticket is about.' using errcode = 'LG001';
  end if;
  if p_opened_by_role is null or p_opened_by_role not in ('affiliate', 'admin') then
    raise exception 'That ticket could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those images could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 3 then
    raise exception 'Up to 3 images can be attached to a message.' using errcode = 'LG001';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id and u.role = 'affiliate') then
    raise exception 'A ticket can only be opened for an affiliate account.' using errcode = 'LG003';
  end if;

  insert into public.support_tickets (
    user_id, subject, category, status, opened_by, opened_by_role,
    created_at, last_message_at, last_message_role, affiliate_read_at, admin_read_at
  )
  values (
    p_user_id, v_subject, p_category, 'open', coalesce(p_opened_by, ''), p_opened_by_role,
    v_now, v_now, p_opened_by_role,
    case when p_opened_by_role = 'affiliate' then v_now end,
    case when p_opened_by_role = 'admin' then v_now end
  )
  returning id into v_ticket_id;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (v_ticket_id, p_opened_by_role, coalesce(p_author_id, ''), coalesce(p_opened_by, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, data)
  select v_message_id, v_ticket_id, coalesce(x.name, 'image'), x.type, x.size, x.data
  from jsonb_to_recordset(v_files) as x(name text, type text, size integer, data text);

  return v_ticket_id;
end;
$$;

comment on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) is
  'Atomically open a support ticket with its first message and images. Called by the service role only.';

revoke all on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Adding a message: the message, its images, and everything on the ticket that
-- has to move with it. The last-message fields, the sender's own read time,
-- and the status: a reply to a closed ticket reopens it in the same write.
--
--   LG001  a message or image list it cannot accept       (validation, 422)
--   LG005  no such ticket                                 (not found, 404)
-- ---------------------------------------------------------------------------
create or replace function public.add_support_message(
  p_ticket_id bigint,
  p_author_role text,
  p_author_id text,
  p_author_name text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_found bigint;
  v_message_id bigint;
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_author_role is null or p_author_role not in ('affiliate', 'admin') then
    raise exception 'That message could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those images could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 3 then
    raise exception 'Up to 3 images can be attached to a message.' using errcode = 'LG001';
  end if;

  -- For update, so two replies landing together write last_message_at one
  -- after the other rather than racing for it.
  select t.id into v_found from public.support_tickets t where t.id = p_ticket_id for update;
  if v_found is null then
    raise exception 'That ticket no longer exists.' using errcode = 'LG005';
  end if;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (p_ticket_id, p_author_role, coalesce(p_author_id, ''), coalesce(p_author_name, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, data)
  select v_message_id, p_ticket_id, coalesce(x.name, 'image'), x.type, x.size, x.data
  from jsonb_to_recordset(v_files) as x(name text, type text, size integer, data text);

  update public.support_tickets
    set last_message_at = v_now,
        last_message_role = p_author_role,
        affiliate_read_at = case when p_author_role = 'affiliate' then v_now else affiliate_read_at end,
        admin_read_at = case when p_author_role = 'admin' then v_now else admin_read_at end,
        status = 'open',
        closed_at = null,
        closed_by = ''
    where id = p_ticket_id;

  return v_message_id;
end;
$$;

comment on function public.add_support_message(bigint, text, text, text, text, jsonb) is
  'Atomically add a message and its images to a support ticket, reopening it if it was closed. Called by the service role only.';

revoke all on function public.add_support_message(bigint, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.add_support_message(bigint, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Marking a ticket read, for one side.
--
-- A function rather than an UPDATE from the app, for one reason: the time has
-- to be this database's now(), the same clock last_message_at was written
-- with. A read time taken from an app server a second behind would sit before
-- the message it was reading, and the ticket would stay unread for good.
--
-- An affiliate can only mark their own: the user id is in the WHERE clause.
-- Returns whether a row matched.
-- ---------------------------------------------------------------------------
create or replace function public.mark_support_read(
  p_ticket_id bigint,
  p_side text,
  p_user_id text
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_side = 'affiliate' then
    update public.support_tickets
      set affiliate_read_at = now()
      where id = p_ticket_id and user_id = p_user_id;
  elsif p_side = 'admin' then
    update public.support_tickets
      set admin_read_at = now()
      where id = p_ticket_id;
  else
    raise exception 'That ticket could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  return found;
end;
$$;

comment on function public.mark_support_read(bigint, text, text) is
  'Record that one side of a support ticket has read it, using the database clock. Called by the service role only.';

revoke all on function public.mark_support_read(bigint, text, text) from public, anon, authenticated;
grant execute on function public.mark_support_read(bigint, text, text) to service_role;
```

- [ ] **Step 4: Write the store**

Create `src/lib/support-store.ts`:

```ts
/**
 * Support tickets, in Supabase.
 *
 * public.support_tickets is the conversation's header, public.support_messages
 * the conversation, and public.support_attachments the screenshots. See the
 * migration, 20261006120000.
 *
 * Sits beside lib/payout-request-store.ts rather than inside the Store
 * interface, for the same reason that one does: this is a conversation with a
 * person, and a Google Sheet is the wrong place for it. Supabase or nothing.
 *
 * Four things about this file are deliberate, and they are the same four as
 * the payout store's:
 *
 *   - Opening a ticket and adding a message go through Postgres functions,
 *     called with .rpc(). "Write the message, then move the ticket's
 *     last-message fields" as two calls could leave a reply nobody is badged
 *     for. One RPC is one transaction.
 *   - Marking read is a function too, so the time is the database's own.
 *   - The image bytes are never selected by a list or a thread read.
 *     readSupportAttachmentFile is the one query that touches them, and a
 *     route calls it only after it knows the caller may see them.
 *   - A ticket id is a small sequential number anybody can guess. So a read
 *     on an affiliate's behalf puts their user id into the query itself, and
 *     a ticket that is not theirs is never fetched rather than fetched and
 *     then checked.
 */

import {
  StoreConfigError,
  StoreNotFoundError,
  StoreValidationError,
} from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import {
  isSupportCategory,
  isSupportStatus,
  isUnreadFor,
  type SupportAttachmentMeta,
  type SupportCategory,
  type SupportMessage,
  type SupportSide,
  type SupportStatus,
  type SupportTicket,
  type SupportUpload,
} from './support';

export function supportEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!supportEnabled()) {
    throw new StoreConfigError(
      'Support tickets need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

/* ----------------------------------------------------------------- errors --- */

type PostgrestErrorish = { code?: string; message?: string; details?: string | null } | null;

const DASHES = /[\u2013\u2014]/;

/** The SQLSTATEs the migration's functions raise, and what each one is. */
const RAISED: Record<string, { as: 'invalid' | 'missing'; fallback: string }> = {
  LG001: { as: 'invalid', fallback: 'That could not be read. Reload the page and try again.' },
  LG003: { as: 'invalid', fallback: 'A ticket can only be opened for an affiliate account.' },
  LG005: { as: 'missing', fallback: 'That ticket no longer exists.' },
};

/** Exported for scripts/support-store-checks.ts; nothing else should call it. */
export function supportFailure(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? '';

  if (code === '42P01' || code === 'PGRST205') {
    throw new StoreConfigError(
      'The support ticket tables are missing from this Supabase project. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42883' || code === 'PGRST202') {
    throw new StoreConfigError(
      'The support ticket functions are missing from this Supabase project. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42703' || code === 'PGRST204') {
    throw new StoreConfigError(
      'The support ticket tables are missing columns this version needs. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }

  const raised = RAISED[code];
  if (raised) {
    const sentence = message && !DASHES.test(message) ? message : raised.fallback;
    if (raised.as === 'invalid') throw new StoreValidationError(sentence);
    throw new StoreNotFoundError(sentence);
  }

  // The account a ticket was being opened for was deleted between the check
  // and the insert.
  if (code === '23503') throw new StoreNotFoundError('That account no longer exists.');

  throw new Error(`${context}: ${message || 'unknown error'}${code ? ` (${code})` : ''}`);
}

/** A bigint row id, as the app carries it: a string of digits. */
function isRowId(id: string): boolean {
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

/* ------------------------------------------------------------------ shape --- */

const TICKET_COLUMNS =
  'id, user_id, subject, category, status, opened_by, opened_by_role, created_at, ' +
  'last_message_at, last_message_role, affiliate_read_at, admin_read_at, closed_at, closed_by';

/** Every message column, and each attachment without its bytes. */
const MESSAGE_COLUMNS =
  'id, author_role, author_id, author_name, body, created_at, support_attachments(id, name, type, size)';

function when(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function side(value: unknown): SupportSide {
  return value === 'admin' ? 'admin' : 'affiliate';
}

/** Exported for the checks. A row from support_tickets, as the pages read it. */
export function toTicket(row: Record<string, unknown>): SupportTicket {
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    subject: String(row.subject ?? ''),
    // A value this version does not know is a row written by a newer one.
    // The safest reading is the plainest: a question, still open.
    category: isSupportCategory(row.category) ? row.category : 'question',
    status: isSupportStatus(row.status) ? row.status : 'open',
    openedBy: String(row.opened_by ?? ''),
    openedByRole: side(row.opened_by_role),
    createdAt: String(row.created_at ?? ''),
    lastMessageAt: String(row.last_message_at ?? ''),
    lastMessageRole: side(row.last_message_role),
    affiliateReadAt: when(row.affiliate_read_at),
    adminReadAt: when(row.admin_read_at),
    closedAt: when(row.closed_at),
    closedBy: String(row.closed_by ?? ''),
  };
}

/** Exported for the checks. A row from support_messages with its attachments. */
export function toMessage(row: Record<string, unknown>): SupportMessage {
  const files = Array.isArray(row.support_attachments) ? row.support_attachments : [];
  const attachments: SupportAttachmentMeta[] = files
    .map((entry) => {
      const file = entry as Record<string, unknown>;
      return {
        id: String(file.id ?? ''),
        name: String(file.name ?? 'image'),
        type: String(file.type ?? ''),
        size: Number(file.size ?? 0),
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  return {
    id: String(row.id ?? ''),
    authorRole: side(row.author_role),
    authorId: String(row.author_id ?? ''),
    authorName: String(row.author_name ?? ''),
    body: String(row.body ?? ''),
    createdAt: String(row.created_at ?? ''),
    attachments,
  };
}

/* ------------------------------------------------------------------ reads --- */

/** PostgREST answers with at most 1000 rows; a list that stopped there would quietly lose tickets. */
const PAGE_SIZE = 1000;
const MAX_ROWS = 200_000;

type Page = PromiseLike<{ data: unknown; error: PostgrestErrorish }>;

async function readPages(
  context: string,
  page: (from: number, to: number) => Page,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) supportFailure(context, error);
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    for (const row of rows) out.push(row);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`${context}: more than ${MAX_ROWS} rows, which this page was never built to read`);
}

/** Every ticket that matches, newest activity first, for the admin list. */
export async function listSupportTickets(
  filter: { status?: SupportStatus; category?: SupportCategory } = {},
): Promise<SupportTicket[]> {
  requireStore();
  const rows = await readPages('reading support tickets', (from, to) => {
    let query = getSupabaseClient().from('support_tickets').select(TICKET_COLUMNS);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.category) query = query.eq('category', filter.category);
    return query
      .order('last_message_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
  });
  return rows.map(toTicket);
}

/** One person's tickets, newest activity first. */
export async function listSupportTicketsFor(userId: string): Promise<SupportTicket[]> {
  requireStore();
  const rows = await readPages('reading support tickets', (from, to) =>
    getSupabaseClient()
      .from('support_tickets')
      .select(TICKET_COLUMNS)
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  return rows.map(toTicket);
}

/**
 * One ticket, without its messages.
 *
 * `forUserId`, when given, goes into the query itself, so a ticket that is not
 * this person's resolves to null. An admin caller omits it. An empty string is
 * still a filter, and matches nobody: a caller with a blank id must never read
 * as a caller with no restriction.
 */
export async function readSupportTicket(id: string, forUserId?: string): Promise<SupportTicket | null> {
  requireStore();
  if (!isRowId(id)) return null;
  let query = getSupabaseClient().from('support_tickets').select(TICKET_COLUMNS).eq('id', id);
  if (forUserId !== undefined) query = query.eq('user_id', forUserId);
  const { data, error } = await query.maybeSingle();
  if (error) supportFailure('reading a support ticket', error);
  return data ? toTicket(data as unknown as Record<string, unknown>) : null;
}

/** One ticket and its whole conversation, oldest message first. */
export async function readSupportThread(
  id: string,
  forUserId?: string,
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  const ticket = await readSupportTicket(id, forUserId);
  if (!ticket) return null;
  const rows = await readPages('reading a support conversation', (from, to) =>
    getSupabaseClient()
      .from('support_messages')
      .select(MESSAGE_COLUMNS)
      .eq('ticket_id', id)
      .order('id', { ascending: true })
      .range(from, to),
  );
  return { ticket, messages: rows.map(toMessage) };
}

/**
 * How many tickets this side has not read, for the tab's badge.
 *
 * Postgres cannot be asked "read_at < last_message_at" through PostgREST's
 * filters, so this narrows to the tickets where the other side spoke last,
 * reads four small columns of each, and counts with the same isUnreadFor the
 * list uses. One rule, in one place.
 */
export async function countUnreadSupport(side: SupportSide, userId?: string): Promise<number> {
  requireStore();
  if (side === 'affiliate' && !userId) return 0;
  const other: SupportSide = side === 'affiliate' ? 'admin' : 'affiliate';
  const rows = await readPages('counting unread support tickets', (from, to) => {
    let query = getSupabaseClient()
      .from('support_tickets')
      .select('id, last_message_at, last_message_role, affiliate_read_at, admin_read_at')
      .eq('last_message_role', other);
    if (side === 'affiliate') query = query.eq('user_id', userId ?? '');
    return query.order('id', { ascending: true }).range(from, to);
  });
  return rows.map(toTicket).filter((ticket) => isUnreadFor(ticket, side)).length;
}

/** Which ticket an attachment belongs to, and nothing else. */
export async function readSupportAttachmentTicket(attachmentId: string): Promise<string | null> {
  requireStore();
  if (!isRowId(attachmentId)) return null;
  const { data, error } = await getSupabaseClient()
    .from('support_attachments')
    .select('id, ticket_id')
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) supportFailure('reading which ticket an image belongs to', error);
  const row = data as Record<string, unknown> | null;
  return row ? String(row.ticket_id ?? '') : null;
}

/**
 * The image itself.
 *
 * The only query in this file that touches the bytes. Call it only once the
 * caller is known to be allowed.
 */
export async function readSupportAttachmentFile(
  attachmentId: string,
): Promise<{ name: string; type: string; data: string } | null> {
  requireStore();
  if (!isRowId(attachmentId)) return null;
  const { data, error } = await getSupabaseClient()
    .from('support_attachments')
    .select('name, type, data')
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) supportFailure('reading a support image', error);
  const row = data as Record<string, unknown> | null;
  const content = String(row?.data ?? '');
  if (!row || !content) return null;
  return {
    name: String(row.name ?? 'image'),
    type: String(row.type ?? 'application/octet-stream'),
    data: content,
  };
}

/* ----------------------------------------------------------------- writes --- */

function filesForRpc(files: SupportUpload[]): Record<string, unknown>[] {
  return files.map((file) => ({ name: file.name, type: file.type, size: file.size, data: file.data }));
}

function idFrom(context: string, data: unknown): string {
  if (data === null || data === undefined || data === '') {
    throw new Error(`${context}: the function returned no id`);
  }
  return String(data);
}

/** Open a ticket with its first message, and return the ticket's id. */
export async function openSupportTicket(input: {
  userId: string;
  subject: string;
  category: SupportCategory;
  openedBy: string;
  openedByRole: SupportSide;
  authorId: string;
  body: string;
  files: SupportUpload[];
}): Promise<string> {
  requireStore();
  const { data, error } = await getSupabaseClient().rpc('create_support_ticket', {
    p_user_id: input.userId,
    p_subject: input.subject,
    p_category: input.category,
    p_opened_by: input.openedBy,
    p_opened_by_role: input.openedByRole,
    p_author_id: input.authorId,
    p_body: input.body,
    p_attachments: filesForRpc(input.files),
  });
  if (error) supportFailure('opening a support ticket', error);
  return idFrom('opening a support ticket', data);
}

/** Add a message to a ticket, reopening it if it was closed. Returns the message's id. */
export async function addSupportMessage(input: {
  ticketId: string;
  authorRole: SupportSide;
  authorId: string;
  authorName: string;
  body: string;
  files: SupportUpload[];
}): Promise<string> {
  requireStore();
  if (!isRowId(input.ticketId)) throw new StoreNotFoundError('That ticket no longer exists.');
  const { data, error } = await getSupabaseClient().rpc('add_support_message', {
    p_ticket_id: Number(input.ticketId),
    p_author_role: input.authorRole,
    p_author_id: input.authorId,
    p_author_name: input.authorName,
    p_body: input.body,
    p_attachments: filesForRpc(input.files),
  });
  if (error) supportFailure('adding a support message', error);
  return idFrom('adding a support message', data);
}

/**
 * One UPDATE that moves a ticket from one status to the other. True when it
 * matched. The status it must currently have is in the WHERE clause, so two
 * people closing the same ticket cannot both be told they did.
 */
async function moveStatus(
  context: string,
  id: string,
  from: SupportStatus,
  patch: Record<string, unknown>,
  forUserId?: string,
): Promise<boolean> {
  requireStore();
  if (!isRowId(id)) return false;
  let query = getSupabaseClient().from('support_tickets').update(patch).eq('id', id).eq('status', from);
  if (forUserId !== undefined) query = query.eq('user_id', forUserId);
  const { data, error } = await query.select('id');
  if (error) supportFailure(context, error);
  return Array.isArray(data) && data.length > 0;
}

/** Close an open ticket. False when it was not open, or not this person's. */
export async function closeSupportTicket(id: string, closedBy: string, forUserId?: string): Promise<boolean> {
  return moveStatus(
    'closing a support ticket',
    id,
    'open',
    { status: 'closed', closed_at: new Date().toISOString(), closed_by: closedBy },
    forUserId,
  );
}

/** Reopen a closed ticket. False when it was not closed, or not this person's. */
export async function reopenSupportTicket(id: string, forUserId?: string): Promise<boolean> {
  return moveStatus(
    'reopening a support ticket',
    id,
    'closed',
    { status: 'open', closed_at: null, closed_by: '' },
    forUserId,
  );
}

/**
 * Record that one side has read a ticket. The time is the database's own:
 * see mark_support_read. `userId` is only used on the affiliate side, where it
 * is part of the WHERE clause.
 */
export async function markSupportRead(id: string, side: SupportSide, userId: string): Promise<void> {
  requireStore();
  if (!isRowId(id)) return;
  const { error } = await getSupabaseClient().rpc('mark_support_read', {
    p_ticket_id: Number(id),
    p_side: side,
    p_user_id: userId,
  });
  if (error) supportFailure('marking a support ticket read', error);
}
```

- [ ] **Step 5: Run the checks to make sure they pass**

Run: `npx tsx scripts/support-store-checks.ts`
Expected: last line `support-store: N passed, 0 failed`.

Run: `npm run typecheck`
Expected: no errors. If the Supabase client's builder types reject the reassigned `query` variables, annotate them the way `readPayoutRequest` in `src/lib/payout-request-store.ts:358` does (plain `let query = ...` reassignment works there), and do not add `any`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261006120000_support_tickets.sql src/lib/support-store.ts scripts/support-store-checks.ts
git commit -m "feat(support): tables, functions and store"
```

---

### Task 3: Request rules (`src/lib/support-api.ts`)

**Files:**
- Create: `src/lib/support-api.ts`
- Test: `scripts/support-api-checks.ts`

**Interfaces:**
- Consumes: `asBody`, `textField`, `readRowId`, `requestedByFor`, type `Refusal` from `src/lib/payout-api.ts`; from Task 1 `checkSupportAttachments`, `isSupportCategory`, `sideFor`, `MAX_SUBJECT`, `MAX_BODY`, types `SupportCategory`, `SupportSide`, `SupportUpload`; type `Viewer`.
- Produces:
  - `type SupportAction = 'open' | 'reply' | 'close' | 'reopen' | 'read'`
  - `readSupportAction(value: unknown): SupportAction | null`
  - `noSuchTicket(): Refusal`
  - `readTicketId(value: unknown): { ok: true; id: string } | { ok: false; refusal: Refusal }`
  - `type OpenInput = { userId: string; subject: string; category: SupportCategory; body: string; files: SupportUpload[] }`
  - `readOpen(body: Record<string, unknown>, viewer: Pick<Viewer, 'role' | 'id'>): { ok: true; value: OpenInput } | { ok: false; refusal: Refusal }`
  - `type ReplyInput = { ticketId: string; body: string; files: SupportUpload[] }`
  - `readReply(body: Record<string, unknown>): { ok: true; value: ReplyInput } | { ok: false; refusal: Refusal }`
  - `authorFor(viewer: Pick<Viewer, 'role' | 'id' | 'username' | 'actingAs'>): { role: SupportSide; id: string; name: string }`
  - `ownerFilter(viewer: Pick<Viewer, 'role' | 'id'>): string | undefined`
  - `shouldMarkRead(viewer: Pick<Viewer, 'actingAs'>): boolean`
  - `SUPPORT_LIMITS: Record<'open' | 'reply', { limit: number; windowMs: number }>`
  - `throttleApplies(viewer: Pick<Viewer, 'role'>): boolean`
  - `tooMany(): Refusal`
  - `alreadyRefusal(action: 'close' | 'reopen'): Refusal`
  - `emailSkipReason(email: string): string`

- [ ] **Step 1: Write the failing checks**

Create `scripts/support-api-checks.ts`:

```ts
// What the support routes decide, as plain functions: is this body readable,
// whose ticket is it, and what does a refusal say.
//
// Nothing in this repo can run a route handler under test, so every decision
// the route makes is made here and pinned here. The two that matter most are
// who a ticket is opened for (never the body's word when the sender is an
// affiliate) and whether opening a thread marks it read (never, from Client
// View).
//
//   npx tsx scripts/support-api-checks.ts

import {
  alreadyRefusal,
  authorFor,
  emailSkipReason,
  noSuchTicket,
  ownerFilter,
  readOpen,
  readReply,
  readSupportAction,
  readTicketId,
  shouldMarkRead,
  SUPPORT_LIMITS,
  throttleApplies,
  tooMany,
} from '../src/lib/support-api';
import { MAX_BODY, MAX_SUBJECT } from '../src/lib/support';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const said: string[] = [];
function note(refusal: { error: string; hint?: string; fields?: Record<string, string> }) {
  said.push(refusal.error);
  if (refusal.hint) said.push(refusal.hint);
  for (const text of Object.values(refusal.fields ?? {})) said.push(text);
}

const affiliate = { role: 'affiliate' as const, id: 'u1' };
const admin = { role: 'admin' as const, id: 'a1' };

console.log('- actions -');
for (const action of ['open', 'reply', 'close', 'reopen', 'read']) {
  check(`${action} is an action`, readSupportAction(action) === action);
}
check('nothing else is', readSupportAction('delete') === null && readSupportAction(undefined) === null && readSupportAction(1) === null);

console.log('- which ticket -');
const id = readTicketId('12');
check('an id is read', id.ok && id.id === '12');
const numeric = readTicketId(12);
check('a number too', numeric.ok && numeric.id === '12');
const missing = readTicketId(undefined);
check('a missing id is a 400', !missing.ok && missing.refusal.status === 400);
const shaped = readTicketId('abc');
check('a thing that is not an id is simply not found', !shaped.ok && shaped.refusal.status === 404);
check('not found says the same thing every time', !shaped.ok && shaped.refusal.error === noSuchTicket().error);
note(noSuchTicket());
if (!missing.ok) note(missing.refusal);

console.log('- opening -');
const base = { subject: '  Where is   my payout?  ', category: 'payout', body: '  It is late.  ' };
const opened = readOpen(base, affiliate);
check('a good ticket is read', opened.ok);
check('the subject is trimmed and its spaces collapsed', opened.ok && opened.value.subject === 'Where is my payout?');
check('the body is trimmed', opened.ok && opened.value.body === 'It is late.');
check('it is for the affiliate who sent it', opened.ok && opened.value.userId === 'u1');
const spoofed = readOpen({ ...base, userId: 'u2' }, affiliate);
check('an affiliate naming somebody else is ignored', spoofed.ok && spoofed.value.userId === 'u1');
const lines = readOpen({ ...base, subject: 'Line one\nLine two' }, affiliate);
check('a line break in a subject becomes a space', lines.ok && lines.value.subject === 'Line one Line two');
const kept = readOpen({ ...base, body: 'One\n\nTwo' }, affiliate);
check('line breaks in a body are kept', kept.ok && kept.value.body === 'One\n\nTwo');
const forSomebody = readOpen({ ...base, userId: ' u2 ' }, admin);
check('an admin opens it for the person they chose', forSomebody.ok && forSomebody.value.userId === 'u2');
function refusedOpen(body: Record<string, unknown>, viewer = affiliate) {
  const result = readOpen(body, viewer);
  if (result.ok) return null;
  note(result.refusal);
  return result.refusal;
}
check('an admin who chose nobody is asked who', refusedOpen(base, admin)?.fields?.userId !== undefined);
check('an account with no id cannot open one', refusedOpen(base, { role: 'affiliate', id: '' })?.status === 403);
check('no subject is refused, on that field', refusedOpen({ ...base, subject: '   ' })?.fields?.subject !== undefined);
check('a subject one character too long is refused', refusedOpen({ ...base, subject: 'x'.repeat(MAX_SUBJECT + 1) })?.status === 400);
check('a subject at the limit is kept', readOpen({ ...base, subject: 'x'.repeat(MAX_SUBJECT) }, affiliate).ok);
check('no message is refused, on that field', refusedOpen({ ...base, body: '' })?.fields?.body !== undefined);
check('a message one character too long is refused', refusedOpen({ ...base, body: 'x'.repeat(MAX_BODY + 1) })?.status === 400);
check('a message at the limit is kept', readOpen({ ...base, body: 'x'.repeat(MAX_BODY) }, affiliate).ok);
check('no category is refused, on that field', refusedOpen({ ...base, category: 'other' })?.fields?.category !== undefined);
check('a subject that is not text is refused', refusedOpen({ ...base, subject: 5 })?.status === 400);
check('a bad attachment is refused', refusedOpen({ ...base, attachments: 'x' })?.fields?.attachments !== undefined);
check('no attachments is fine', opened.ok && opened.value.files.length === 0);

console.log('- replying -');
const reply = readReply({ ticketId: '12', body: ' Thanks ' });
check('a reply is read', reply.ok && reply.value.ticketId === '12' && reply.value.body === 'Thanks');
const noTicket = readReply({ body: 'x' });
check('a reply to nothing is a 400', !noTicket.ok && noTicket.refusal.status === 400);
const empty = readReply({ ticketId: '12', body: '  ' });
check('an empty reply is refused', !empty.ok && empty.refusal.fields?.body !== undefined);
if (!empty.ok) note(empty.refusal);

console.log('- who is writing -');
const plain = authorFor({ role: 'affiliate', id: 'u1', username: 'maria', actingAs: null });
check('an affiliate writes as themselves', plain.role === 'affiliate' && plain.id === 'u1' && plain.name === 'maria');
const viaAdmin = authorFor({ role: 'affiliate', id: 'u1', username: 'maria', actingAs: { adminId: 'a1', adminName: 'Gimson' } });
check('from Client View the line names both', viaAdmin.name === 'maria (via Gimson)' && viaAdmin.role === 'affiliate');
const asAdmin = authorFor({ role: 'admin', id: 'env:admin', username: 'admin', actingAs: null });
check('the env admin writes as an admin', asAdmin.role === 'admin' && asAdmin.id === 'env:admin');
check('an affiliate is confined to their own tickets', ownerFilter(affiliate) === 'u1');
check('an affiliate with no id is confined to nobody\'s', ownerFilter({ role: 'affiliate', id: '' }) === '');
check('an admin is not confined', ownerFilter(admin) === undefined);

console.log('- marking read -');
// Review focus 3.
check('opening your own thread marks it read', shouldMarkRead({ actingAs: null }));
check('opening it from Client View does not', !shouldMarkRead({ actingAs: { adminId: 'a1', adminName: 'Gimson' } }));

console.log('- limits -');
check('five tickets an hour', SUPPORT_LIMITS.open.limit === 5 && SUPPORT_LIMITS.open.windowMs === 3_600_000);
check('thirty replies an hour', SUPPORT_LIMITS.reply.limit === 30 && SUPPORT_LIMITS.reply.windowMs === 3_600_000);
check('affiliates are throttled', throttleApplies({ role: 'affiliate' }));
check('admins are not', !throttleApplies({ role: 'admin' }));
check('too many is a 429', tooMany().status === 429);
note(tooMany());
check('closing a closed ticket is a 409', alreadyRefusal('close').status === 409);
check('reopening an open one too', alreadyRefusal('reopen').status === 409);
check('and they say different things', alreadyRefusal('close').error !== alreadyRefusal('reopen').error);
note(alreadyRefusal('close'));
note(alreadyRefusal('reopen'));

console.log('- email -');
// Review focus 5.
check('an address is no reason to skip', emailSkipReason('maria@example.com') === '');
check('a blank one is', emailSkipReason('   ') !== '');
said.push(emailSkipReason(''));

check('there was something to read', said.length > 15, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log(`\nsupport-api: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx scripts/support-api-checks.ts`
Expected: fails to start with `Cannot find module '../src/lib/support-api'`.

- [ ] **Step 3: Write the module**

Create `src/lib/support-api.ts`:

```ts
/**
 * The rules the support routes apply, as plain functions.
 *
 * /api/support makes the same kinds of decision the payout routes do: is this
 * body readable, whose ticket is it, and what does a refusal say. None of that
 * needs a request or a database, and nothing in this repo can run a route
 * handler under test, so the decisions live here and
 * scripts/support-api-checks.ts pins them. The route is left holding the order
 * things happen in.
 *
 * Every sentence here can reach an affiliate, so none has a dash in it and
 * none names another account.
 *
 * Pure. payout-api.ts is imported for the body readers and the audit line it
 * already has, rather than writing them a second time.
 */

import { asBody, readRowId, requestedByFor, textField, type Refusal } from './payout-api';
import {
  checkSupportAttachments,
  isSupportCategory,
  MAX_BODY,
  MAX_SUBJECT,
  sideFor,
  type SupportCategory,
  type SupportSide,
  type SupportUpload,
} from './support';
import type { Viewer } from './viewer-core';

export { asBody };

/* ---------------------------------------------------------------- actions --- */

export type SupportAction = 'open' | 'reply' | 'close' | 'reopen' | 'read';

const ACTIONS: readonly SupportAction[] = ['open', 'reply', 'close', 'reopen', 'read'];

export function readSupportAction(value: unknown): SupportAction | null {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
    ? (value as SupportAction)
    : null;
}

/* ----------------------------------------------------------- which ticket --- */

/**
 * The one answer for a ticket this viewer cannot have: one that never was, an
 * id that could not be one, or somebody else's. The ids are sequential, so a
 * 403 of its own would let any affiliate walk them and learn which exist.
 */
export function noSuchTicket(): Refusal {
  return { status: 404, error: 'No such ticket.' };
}

export function readTicketId(value: unknown): { ok: true; id: string } | { ok: false; refusal: Refusal } {
  const id = readRowId(value);
  if (id) return { ok: true, id };
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { ok: false, refusal: { status: 400, error: 'Which ticket?' } };
  }
  return { ok: false, refusal: noSuchTicket() };
}

/* ------------------------------------------------------------------ fields --- */

function invalid(error: string, field: string): Refusal {
  return { status: 400, error, fields: { [field]: error } };
}

/**
 * A subject, tidied. Every run of whitespace becomes one space: a subject is
 * one line wherever it is shown, and it is also an email's Subject header,
 * where a line break is how a header gets a second header nobody wrote.
 */
function readSubject(body: Record<string, unknown>): { ok: true; text: string } | { ok: false; refusal: Refusal } {
  const text = textField(body, 'subject').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, refusal: invalid('Give the ticket a subject.', 'subject') };
  if (text.length > MAX_SUBJECT) {
    return { ok: false, refusal: invalid(`Keep the subject to ${MAX_SUBJECT} characters.`, 'subject') };
  }
  return { ok: true, text };
}

function readMessage(body: Record<string, unknown>): { ok: true; text: string } | { ok: false; refusal: Refusal } {
  const text = textField(body, 'body').trim();
  if (!text) return { ok: false, refusal: invalid('Write a message first.', 'body') };
  if (text.length > MAX_BODY) {
    return {
      ok: false,
      refusal: invalid(`Keep a message to ${MAX_BODY.toLocaleString('en-US')} characters.`, 'body'),
    };
  }
  return { ok: true, text };
}

function readFiles(body: Record<string, unknown>): { ok: true; files: SupportUpload[] } | { ok: false; refusal: Refusal } {
  const result = checkSupportAttachments(body.attachments);
  if (result.ok) return { ok: true, files: result.files };
  return {
    ok: false,
    refusal: { status: 400, error: result.error, hint: result.hint, fields: { attachments: result.error } },
  };
}

/* ---------------------------------------------------------------- opening --- */

export type OpenInput = {
  userId: string;
  subject: string;
  category: SupportCategory;
  body: string;
  files: SupportUpload[];
};

/**
 * A new ticket, and who it is for.
 *
 * An affiliate's ticket is their own: the body's `userId` is not read at all,
 * so a hand-made POST can only ever open a ticket for the person who sent it.
 * An admin has to say who it is for. Whether that account exists and is an
 * affiliate is the database's to decide, inside the transaction that writes it.
 */
export function readOpen(
  body: Record<string, unknown>,
  viewer: Pick<Viewer, 'role' | 'id'>,
): { ok: true; value: OpenInput } | { ok: false; refusal: Refusal } {
  let userId: string;
  if (sideFor(viewer) === 'affiliate') {
    if (!viewer.id) return { ok: false, refusal: { status: 403, error: 'This account cannot open a ticket.' } };
    userId = viewer.id;
  } else {
    userId = textField(body, 'userId').trim();
    if (!userId) return { ok: false, refusal: invalid('Choose who this ticket is for.', 'userId') };
  }

  const subject = readSubject(body);
  if (!subject.ok) return subject;
  const category = body.category;
  if (!isSupportCategory(category)) {
    return { ok: false, refusal: invalid('Choose what the ticket is about.', 'category') };
  }
  const message = readMessage(body);
  if (!message.ok) return message;
  const files = readFiles(body);
  if (!files.ok) return files;

  return {
    ok: true,
    value: { userId, subject: subject.text, category, body: message.text, files: files.files },
  };
}

/* --------------------------------------------------------------- replying --- */

export type ReplyInput = { ticketId: string; body: string; files: SupportUpload[] };

export function readReply(
  body: Record<string, unknown>,
): { ok: true; value: ReplyInput } | { ok: false; refusal: Refusal } {
  const id = readTicketId(body.ticketId);
  if (!id.ok) return id;
  const message = readMessage(body);
  if (!message.ok) return message;
  const files = readFiles(body);
  if (!files.ok) return files;
  return { ok: true, value: { ticketId: id.id, body: message.text, files: files.files } };
}

/* ------------------------------------------------------------- the viewer --- */

/**
 * Who a message is recorded as written by.
 *
 * From Client View the viewer is the affiliate, so the role is 'affiliate' and
 * the id is theirs; the name is the one place it says an admin was behind it.
 */
export function authorFor(
  viewer: Pick<Viewer, 'role' | 'id' | 'username' | 'actingAs'>,
): { role: SupportSide; id: string; name: string } {
  return { role: sideFor(viewer), id: viewer.id, name: requestedByFor(viewer) };
}

/**
 * The user id every read and write is confined to, or undefined for an admin.
 *
 * An affiliate with a blank id gets '' rather than undefined: a blank id must
 * match nobody, never read as "no restriction".
 */
export function ownerFilter(viewer: Pick<Viewer, 'role' | 'id'>): string | undefined {
  return sideFor(viewer) === 'affiliate' ? viewer.id : undefined;
}

/**
 * Whether opening a thread records it as read.
 *
 * Not from Client View. An admin looking at an affiliate's screen has not
 * read the reply on the affiliate's behalf, and clearing their badge would
 * mean they never learn it came.
 */
export function shouldMarkRead(viewer: Pick<Viewer, 'actingAs'>): boolean {
  return viewer.actingAs === null;
}

/* ----------------------------------------------------------------- limits --- */

const HOUR = 3_600_000;

/** How much one affiliate may send. Admins are not limited. */
export const SUPPORT_LIMITS: Record<'open' | 'reply', { limit: number; windowMs: number }> = {
  open: { limit: 5, windowMs: HOUR },
  reply: { limit: 30, windowMs: HOUR },
};

export function throttleApplies(viewer: Pick<Viewer, 'role'>): boolean {
  return sideFor(viewer) === 'affiliate';
}

export function tooMany(): Refusal {
  return {
    status: 429,
    error: 'That is a lot of messages in a short time.',
    hint: 'Give it a little while and try again.',
  };
}

/* ----------------------------------------------------------------- status --- */

/** A close or reopen that matched nothing, because the ticket was already there. */
export function alreadyRefusal(action: 'close' | 'reopen'): Refusal {
  return action === 'close'
    ? { status: 409, error: 'That ticket is already closed.', hint: 'Reload the page to see it.' }
    : { status: 409, error: 'That ticket is already open.', hint: 'Reload the page to see it.' };
}

/* ------------------------------------------------------------------ email --- */

/** Why no email will be sent, or '' when one can be. Shown to the admin who replied. */
export function emailSkipReason(email: string): string {
  return email.trim() === '' ? 'They have no email address on file, so no email was sent.' : '';
}
```

- [ ] **Step 4: Run the checks to make sure they pass**

Run: `npx tsx scripts/support-api-checks.ts`
Expected: last line `support-api: N passed, 0 failed`.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support-api.ts scripts/support-api-checks.ts
git commit -m "feat(support): request parsing and route rules"
```

---

### Task 4: Email and Slack wording

**Files:**
- Create: `src/lib/emails/support-reply.ts`
- Modify: `src/lib/slack-messages.ts` (append)
- Modify: `src/lib/slack.ts` (append; extend the import on line 1)
- Test: `scripts/support-notify-checks.ts`

**Interfaces:**
- Consumes: type `Message` from `src/lib/email.ts`; `CATEGORY_LABELS`, type `SupportCategory` from Task 1; `announce`, `slackConfigured` already in `src/lib/slack.ts`.
- Produces:
  - `supportReplyEmail(input: { to: string; name: string; origin: string; subject: string; body: string; ticketPath: string; opened: boolean }): Message`
  - `type SupportAnnouncement = { person: string; subject: string; category: SupportCategory; kind: 'opened' | 'replied'; url: string }`
  - `supportMessage(announcement: SupportAnnouncement): string` in `slack-messages.ts`
  - `announceSupport(announcement: SupportAnnouncement): Promise<string>` in `slack.ts`

- [ ] **Step 1: Write the failing checks**

Create `scripts/support-notify-checks.ts`:

```ts
// What a support ticket says outside the app: the email an affiliate gets
// when an admin writes to them, and the line the admins' Slack channel gets
// when an affiliate does.
//
// Both carry text a person typed, into a surface with its own markup. So the
// thing pinned hardest is that what they typed arrives as what they typed: no
// HTML from a message body, and no Slack mention or disguised link from a
// subject.
//
//   npx tsx scripts/support-notify-checks.ts

import { supportReplyEmail } from '../src/lib/emails/support-reply';
import { supportMessage } from '../src/lib/slack-messages';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

console.log('- the email -');
const email = supportReplyEmail({
  to: 'maria@example.com',
  name: 'Maria Santos',
  origin: 'https://ledger.example.com/',
  subject: 'Where is my payout?',
  body: 'It went out on Friday.\nIt should land by Tuesday.',
  ticketPath: '/support/12',
  opened: false,
});
check('it goes to them', email.to === 'maria@example.com');
check('the subject names the ticket', email.subject === 'Reply to your support ticket: Where is my payout?');
check('it greets them by first name', email.text.startsWith('Hi Maria,'));
check('the reply is in it', email.text.includes('It went out on Friday.\nIt should land by Tuesday.'));
check('the link has one slash, not two', email.text.includes('https://ledger.example.com/support/12'));
check('the HTML has the link too', (email.html ?? '').includes('href="https://ledger.example.com/support/12"'));
check('line breaks survive into the HTML', (email.html ?? '').includes('It went out on Friday.<br>It should land by Tuesday.'));
const started = supportReplyEmail({
  to: 'maria@example.com',
  name: '',
  origin: 'https://ledger.example.com',
  subject: 'Your W-9',
  body: 'Could you send a clearer copy?',
  ticketPath: '/support/13',
  opened: true,
});
check('a ticket an admin opened says so', started.subject === 'New message from LaunchStone support: Your W-9');
check('nobody is greeted as nothing', started.text.startsWith('Hi there,'));
const hostile = supportReplyEmail({
  to: 'maria@example.com',
  name: '<b>Maria</b>',
  origin: 'https://ledger.example.com',
  subject: '<script>alert(1)</script>',
  body: '<img src=x onerror=alert(1)> & "quotes"',
  ticketPath: '/support/14',
  opened: false,
});
check('a tag in the body is escaped', !(hostile.html ?? '').includes('<img') && (hostile.html ?? '').includes('&lt;img'));
check('a tag in the subject is escaped', !(hostile.html ?? '').includes('<script>'));
check('a tag in the name is escaped', !(hostile.html ?? '').includes('<b>Maria</b>'));
check('an ampersand is escaped once', (hostile.html ?? '').includes('&amp; &quot;quotes&quot;'));
for (const message of [email, started]) {
  check('no dash in the text', !/[\u2013\u2014]/.test(message.text + message.subject));
  check('no dash in the HTML', !/[\u2013\u2014]/.test(message.html ?? ''));
}

console.log('- the Slack line -');
const slack = supportMessage({
  person: 'maria',
  subject: 'Where is my payout?',
  category: 'payout',
  kind: 'opened',
  url: 'https://ledger.example.com/support/12',
});
check(
  'a new ticket, in the channel\'s shape',
  slack ===
    '*LEDGER - SUPPORT TICKET*\n' +
      '*New ticket from:* maria\n' +
      '*Subject:* Where is my payout? (Payout issue)\n' +
      'https://ledger.example.com/support/12',
  slack,
);
const again = supportMessage({ person: 'maria (via Gimson)', subject: 'Thanks', category: 'question', kind: 'replied', url: 'https://x/support/1' });
check('a reply says it is one', again.includes('*New reply from:* maria (via Gimson)'));
// Review focus 2.
const loud = supportMessage({ person: 'maria', subject: '<!channel> <http://evil.example|click here> & *bold*', category: 'bug', kind: 'opened', url: 'https://x/support/2' });
check('a mention in a subject is not a mention', !loud.includes('<!channel>') && loud.includes('&lt;!channel&gt;'));
check('a link in a subject is not a link', !loud.includes('<http://evil.example|click here>'));
check('an ampersand is escaped', loud.includes('&amp;'));
check('a blank person is not a blank line', supportMessage({ person: '  ', subject: 'x', category: 'bug', kind: 'opened', url: 'https://x' }).includes('*New ticket from:* Unknown'));
check('no dash', !/[\u2013\u2014]/.test(slack + again));

console.log(`\nsupport-notify: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx scripts/support-notify-checks.ts`
Expected: fails to start with `Cannot find module '../src/lib/emails/support-reply'`.

- [ ] **Step 3: Write the email template**

Create `src/lib/emails/support-reply.ts`:

```ts
import type { Message } from '../email';

/**
 * "Support has written to you."
 *
 * Sent when an admin replies on a support ticket, or opens one with an
 * affiliate. Carries the message itself, so it can be read without signing in,
 * and a link back to the conversation to answer it. Images are not included:
 * they are in the app, behind a sign-in. Text and HTML built together, as in
 * payout-sent.ts, and with no em dashes for the same reason.
 *
 * Everything typed by a person is escaped on its way into the HTML. The
 * subject has already had its line breaks removed by lib/support-api.ts, which
 * is what keeps it safe to use as the Subject header.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function supportReplyEmail(input: {
  to: string;
  /** Their full name, or their username if that is all we have. */
  name: string;
  /** Where the app lives, worked out by the caller. */
  origin: string;
  /** The ticket's subject. */
  subject: string;
  /** What the admin wrote. */
  body: string;
  /** The conversation's path, e.g. /support/12. */
  ticketPath: string;
  /** True when this message opened the ticket, false when it is a reply. */
  opened: boolean;
}): Message {
  const base = input.origin.replace(/\/+$/, '');
  const link = `${base}${input.ticketPath}`;
  const first = (input.name || '').trim().split(/\s+/)[0] || 'there';
  const lead = input.opened
    ? 'LaunchStone support has sent you a message:'
    : 'LaunchStone support has replied to your ticket:';

  const text = [
    `Hi ${first},`,
    '',
    lead,
    '',
    `Subject: ${input.subject}`,
    '',
    input.body,
    '',
    'To answer, open the conversation in Ledger:',
    link,
    '',
    'The LaunchStone team',
  ].join('\n');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7c8f;">
        Support
      </p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        ${escapeHtml(input.subject)}
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#33475b;">
        Hi ${escapeHtml(first)},<br>${escapeHtml(lead)}
      </p>
      <p style="margin:16px 0 0;padding:14px 16px;background:#f4f6f8;border-left:3px solid #f0b429;font-size:14px;line-height:1.6;color:#0b2239;">
        ${escapeHtml(input.body).replace(/\r?\n/g, '<br>')}
      </p>
      <p style="margin:22px 0 0;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;background:#f0b429;color:#3a2a00;text-decoration:none;
                  font-size:14px;font-weight:600;padding:11px 20px;border-radius:3px;">
          Open the conversation
        </a>
      </p>
    </div>
    <div style="padding:16px 26px;border-top:1px solid #edf1f4;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7c8f;">
        Answer in Ledger so the whole conversation stays in one place.
      </p>
    </div>
  </div>
</div>`.trim();

  return {
    to: input.to,
    subject: input.opened
      ? `New message from LaunchStone support: ${input.subject}`
      : `Reply to your support ticket: ${input.subject}`,
    text,
    html,
  };
}
```

- [ ] **Step 4: Add the Slack wording**

Append to `src/lib/slack-messages.ts`, and add this import beside the existing one at the top of the file:

```ts
import { CATEGORY_LABELS, type SupportCategory } from './support';
```

```ts
/* ---------------------------------------------------------------- support --- */

/** A support ticket an affiliate opened or replied on, as the channel needs to read it. */
export type SupportAnnouncement = {
  /** Who wrote. "username", or "username (via Admin Name)" from Client View. */
  person: string;
  subject: string;
  category: SupportCategory;
  kind: 'opened' | 'replied';
  /** The conversation, as a full URL. */
  url: string;
};

/**
 * Slack reads &, < and > as markup: `<!channel>` pings everybody and
 * `<http://x|text>` is a link wearing other words. A subject is typed by an
 * affiliate, so those three are escaped the way Slack's own docs say to, and
 * what they typed arrives as what they typed.
 */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One line of who, one of what, and where to answer.
 *
 * The subject and the category, never the message. The same rule the approval
 * wording follows for money: a channel is read by everybody ever invited to
 * it, and what an affiliate wrote to support is between them and support.
 */
export function supportMessage(announcement: SupportAnnouncement): string {
  const who = announcement.person.trim() || 'Unknown';
  const label = announcement.kind === 'opened' ? 'New ticket from' : 'New reply from';
  return [
    '*LEDGER - SUPPORT TICKET*',
    `*${label}:* ${escapeSlack(who)}`,
    `*Subject:* ${escapeSlack(announcement.subject.trim())} (${CATEGORY_LABELS[announcement.category]})`,
    announcement.url,
  ].join('\n');
}
```

In `src/lib/slack.ts`, change line 1 to:

```ts
import {
  approvalMessage,
  supportMessage,
  syncMessages,
  type ApprovalAnnouncement,
  type SupportAnnouncement,
} from './slack-messages';
```

and append:

```ts
/** A support ticket opened or replied on by an affiliate. Never throws. */
export async function announceSupport(announcement: SupportAnnouncement): Promise<string> {
  if (!slackConfigured()) return '';
  return announce([supportMessage(announcement)]);
}
```

- [ ] **Step 5: Run the checks to make sure they pass**

Run: `npx tsx scripts/support-notify-checks.ts`
Expected: last line `support-notify: N passed, 0 failed`.

Run: `npx tsx scripts/slack-checks.ts`
Expected: no `FAIL` lines (the existing Slack wording is unchanged).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/emails/support-reply.ts src/lib/slack-messages.ts src/lib/slack.ts scripts/support-notify-checks.ts
git commit -m "feat(support): email and Slack wording"
```

---

### Task 5: Routes and middleware

**Files:**
- Create: `src/app/api/support/route.ts`
- Create: `src/app/api/support/attachments/[id]/route.ts`
- Modify: `src/middleware.ts` (the `matcher` array, before the closing `],`)

**Interfaces:**
- Consumes: everything Tasks 1 to 4 produce; `viewerFromRequest`, `unauthorized`, type `Viewer` (`@/lib/api-auth`); `storeFailure`, `readRowId`, type `Refusal` (`@/lib/payout-api`); `rateLimit` (`@/lib/ratelimit`); `findUserById` (`@/lib/users`); `sendEmail`, `EmailError` (`@/lib/email`); `originFromHeaders` (`@/lib/request`); `configuredBaseUrl` (`@/lib/config`); `receiptHeaders` (`@/lib/receipt-file`).
- Produces: `POST /api/support` answering `{ ok: true, ticketId?, emailed?, emailProblem? }` on success and `{ error, hint?, fields? }` on refusal; `GET /api/support/attachments/<id>` answering the image bytes.

There is no way to run a route handler under test in this repo, so this task has no check script of its own: every decision it makes was pinned in Tasks 1 to 4, and the route is exercised by hand in Task 8.

- [ ] **Step 1: Write the POST route**

Create `src/app/api/support/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest, type Viewer } from '@/lib/api-auth';
import { configuredBaseUrl } from '@/lib/config';
import { EmailError, sendEmail } from '@/lib/email';
import { supportReplyEmail } from '@/lib/emails/support-reply';
import { storeFailure, type Refusal } from '@/lib/payout-api';
import { rateLimit } from '@/lib/ratelimit';
import { originFromHeaders } from '@/lib/request';
import { announceSupport } from '@/lib/slack';
import { sideFor, type SupportCategory } from '@/lib/support';
import {
  alreadyRefusal,
  asBody,
  authorFor,
  emailSkipReason,
  noSuchTicket,
  ownerFilter,
  readOpen,
  readReply,
  readSupportAction,
  readTicketId,
  shouldMarkRead,
  SUPPORT_LIMITS,
  throttleApplies,
  tooMany,
} from '@/lib/support-api';
import {
  addSupportMessage,
  closeSupportTicket,
  markSupportRead,
  openSupportTicket,
  readSupportTicket,
  reopenSupportTicket,
} from '@/lib/support-store';
import { findUserById } from '@/lib/users';

/**
 * Everything somebody does to a support ticket.
 *
 * Five actions on one POST: `open` a ticket, `reply` on one, `close` it,
 * `reopen` it, and mark it `read`. Both sides use the same route. Which side
 * the caller is on, and which tickets they may touch, comes from the session
 * and nothing else: an affiliate's user id goes into every query, so somebody
 * else's ticket is never found rather than found and refused, and it answers
 * the same 404 as a ticket that never existed.
 *
 * An admin in Client View is the affiliate as far as this route is concerned.
 * They may write for them, and the message records that an admin did. The one
 * thing they do not do is mark the ticket read, because looking at somebody's
 * screen is not that person reading their reply.
 *
 * A message is written first and announced afterwards. An email or a Slack
 * post that fails never undoes it: the admin is told no email went and why,
 * and Slack swallows its own failures.
 *
 * The rules themselves are in lib/support-api.ts, with their checks. This file
 * holds the order things happen in.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal, headers?: Record<string, string>): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status, headers });
}

export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return refuse({ status: 400, error: 'Expected a JSON body.' });
  }

  const action = readSupportAction(body.action);
  if (!action) {
    return refuse({ status: 400, error: 'No such action.', hint: 'Expected open, reply, close, reopen or read.' });
  }

  const origin = originFromHeaders(request.headers, configuredBaseUrl());
  try {
    if (action === 'open') return await open(viewer, body, origin);
    if (action === 'reply') return await reply(viewer, body, origin);
    if (action === 'read') return await read(viewer, body);
    return await move(viewer, body, action);
  } catch (error) {
    // An admin is shown the raw reason, as on every other admin route here; an
    // affiliate is shown the fallback, since a Postgres message is no use to them.
    const refusal = storeFailure(error, 'That did not save.', { showUnknown: viewer.role === 'admin' });
    if (refusal.status >= 500) console.error(`support: ${action}`, error);
    return refuse(refusal);
  }
}

/** Refuses when an affiliate has sent too much. Counted only for a request that was otherwise good. */
function throttled(viewer: Viewer, action: 'open' | 'reply'): NextResponse | null {
  if (!throttleApplies(viewer)) return null;
  const result = rateLimit(`support:${action}:${viewer.id}`, SUPPORT_LIMITS[action]);
  if (result.ok) return null;
  return refuse(tooMany(), { 'retry-after': String(result.retryAfterSeconds) });
}

async function open(viewer: Viewer, body: Record<string, unknown>, origin: string): Promise<NextResponse> {
  const parsed = readOpen(body, viewer);
  if (!parsed.ok) return refuse(parsed.refusal);
  const limited = throttled(viewer, 'open');
  if (limited) return limited;

  const author = authorFor(viewer);
  const ticketId = await openSupportTicket({
    userId: parsed.value.userId,
    subject: parsed.value.subject,
    category: parsed.value.category,
    openedBy: author.name,
    openedByRole: author.role,
    authorId: author.id,
    body: parsed.value.body,
    files: parsed.value.files,
  });

  const told = await tell({
    author,
    userId: parsed.value.userId,
    ticketId,
    subject: parsed.value.subject,
    category: parsed.value.category,
    body: parsed.value.body,
    opened: true,
    origin,
  });
  return NextResponse.json({ ok: true, ticketId, ...told }, { status: 201 });
}

async function reply(viewer: Viewer, body: Record<string, unknown>, origin: string): Promise<NextResponse> {
  const parsed = readReply(body);
  if (!parsed.ok) return refuse(parsed.refusal);

  // Read with the owner in the query, before anything is written: a reply to
  // somebody else's ticket finds nothing, and writes nothing.
  const ticket = await readSupportTicket(parsed.value.ticketId, ownerFilter(viewer));
  if (!ticket) return refuse(noSuchTicket());

  const limited = throttled(viewer, 'reply');
  if (limited) return limited;

  const author = authorFor(viewer);
  await addSupportMessage({
    ticketId: ticket.id,
    authorRole: author.role,
    authorId: author.id,
    authorName: author.name,
    body: parsed.value.body,
    files: parsed.value.files,
  });

  const told = await tell({
    author,
    userId: ticket.userId,
    ticketId: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    body: parsed.value.body,
    opened: false,
    origin,
  });
  return NextResponse.json({ ok: true, ticketId: ticket.id, ...told });
}

async function move(
  viewer: Viewer,
  body: Record<string, unknown>,
  action: 'close' | 'reopen',
): Promise<NextResponse> {
  const id = readTicketId(body.ticketId);
  if (!id.ok) return refuse(id.refusal);

  const owner = ownerFilter(viewer);
  const ticket = await readSupportTicket(id.id, owner);
  if (!ticket) return refuse(noSuchTicket());

  const done =
    action === 'close'
      ? await closeSupportTicket(ticket.id, authorFor(viewer).name, owner)
      : await reopenSupportTicket(ticket.id, owner);
  if (!done) return refuse(alreadyRefusal(action));
  return NextResponse.json({ ok: true, ticketId: ticket.id });
}

async function read(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const id = readTicketId(body.ticketId);
  if (!id.ok) return refuse(id.refusal);
  // Answered as done rather than refused: the page sends this on every open,
  // and from Client View there is simply nothing to record.
  if (!shouldMarkRead(viewer)) return NextResponse.json({ ok: true, marked: false });
  await markSupportRead(id.id, sideFor(viewer), viewer.id);
  return NextResponse.json({ ok: true, marked: true });
}

/**
 * Tell the other side, after the write. Never throws.
 *
 * An admin's message is emailed to the affiliate. An affiliate's message goes
 * to the admins' Slack channel, subject and category only.
 */
async function tell(input: {
  author: { role: 'affiliate' | 'admin'; name: string };
  userId: string;
  ticketId: string;
  subject: string;
  category: SupportCategory;
  body: string;
  opened: boolean;
  origin: string;
}): Promise<{ emailed?: boolean; emailProblem?: string }> {
  const path = `/support/${input.ticketId}`;

  if (input.author.role === 'affiliate') {
    await announceSupport({
      person: input.author.name,
      subject: input.subject,
      category: input.category,
      kind: input.opened ? 'opened' : 'replied',
      url: `${input.origin.replace(/\/+$/, '')}${path}`,
    });
    return {};
  }

  try {
    const account = await findUserById(input.userId);
    const skip = emailSkipReason(account?.email ?? '');
    if (!account || skip) return { emailed: false, emailProblem: skip || 'That account could not be read, so no email was sent.' };
    await sendEmail(
      supportReplyEmail({
        to: account.email,
        name: account.fullName || account.username,
        origin: input.origin,
        subject: input.subject,
        body: input.body,
        ticketPath: path,
        opened: input.opened,
      }),
    );
    return { emailed: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : 'The email could not be sent.';
    if (!(error instanceof EmailError && error.unconfigured)) console.error('support: email', error);
    return { emailed: false, emailProblem: why };
  }
}
```

- [ ] **Step 2: Write the image route**

Create `src/app/api/support/attachments/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest } from '@/lib/api-auth';
import { readRowId, storeFailure, type Refusal } from '@/lib/payout-api';
import { receiptHeaders } from '@/lib/receipt-file';
import { mayReadTicket } from '@/lib/support';
import { noSuchTicket } from '@/lib/support-api';
import {
  readSupportAttachmentFile,
  readSupportAttachmentTicket,
  readSupportTicket,
} from '@/lib/support-store';

/**
 * One image from a support conversation, handed back as the file it is.
 *
 *   GET /api/support/attachments/<id>
 *
 * A route of its own because it is the one thing in the support API that reads
 * the bytes. Every other query names its columns and leaves the files behind.
 *
 * Checked before it reads, in three steps, the way the receipt route does. The
 * id in the URL is a small sequential number that says nothing about whose
 * image it is, so the route first asks which ticket it belongs to, then
 * whether this viewer may read that ticket, and only then reads the file. An
 * affiliate typing somebody else's id is refused without the image ever
 * leaving the database, and is told the same thing as for an id that was never
 * issued.
 *
 * Served with nosniff, and with the stored type only when the bytes still open
 * the way it says (lib/receipt-file.ts). Anything else is downloaded as plain
 * bytes, never rendered inside this app.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();

  const { id: raw } = await context.params;
  const id = readRowId(raw);
  if (!id) return refuse(noSuchTicket());

  let file: Awaited<ReturnType<typeof readSupportAttachmentFile>>;
  try {
    const ticketId = await readSupportAttachmentTicket(id);
    if (!ticketId) return refuse(noSuchTicket());
    const ticket = await readSupportTicket(ticketId);
    if (!ticket || !mayReadTicket(viewer, ticket.userId)) return refuse(noSuchTicket());
    file = await readSupportAttachmentFile(id);
  } catch (error) {
    const refusal = storeFailure(error, 'Could not read that image.');
    if (refusal.status >= 500) console.error('reading a support image', error);
    return refuse(refusal);
  }

  if (!file) return refuse(noSuchTicket());

  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length === 0) return refuse({ status: 500, error: 'That image could not be read back.' });

  return new NextResponse(new Uint8Array(bytes), {
    headers: receiptHeaders({ name: file.name, type: file.type, bytes }),
  });
}
```

- [ ] **Step 3: Gate the new paths in the middleware**

In `src/middleware.ts`, add these entries to the `matcher` array, immediately before the line `'/settings',`:

```ts
    // Support tickets. A conversation between one affiliate and the admins,
    // with screenshots, so a signed-out request must not reach the pages, the
    // route behind them or the image route, even to be told no.
    '/support',
    '/support/:path*',
    '/api/support',
    '/api/support/:path*',
```

- [ ] **Step 4: Verify it builds**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: the build completes and its route table lists `/api/support` and `/api/support/attachments/[id]` as dynamic (`ƒ`).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/support src/middleware.ts
git commit -m "feat(support): ticket and image routes"
```

---

### Task 6: Support tab and unread badge

**Files:**
- Modify: `src/components/Nav.tsx`
- Modify: `src/app/(admin)/layout.tsx`
- Test: `scripts/support-nav-render-checks.tsx`

**Interfaces:**
- Consumes: `badgeText`, `sideFor` (Task 1); `countUnreadSupport`, `supportEnabled` (Task 2).
- Produces: `Nav` and `MobileTabs` accept an optional `supportUnread?: number` prop (default 0). `visibleItems` now includes `{ href: '/support', label: 'Support' }` for both roles.

- [ ] **Step 1: Write the failing check**

Create `scripts/support-nav-render-checks.tsx`:

```tsx
// The Support tab and its badge, rendered.
//
// The badge is the only way either side learns there is something to read
// without opening the page, so what is pinned is that it appears on the right
// tab, for both roles, on both the desktop tabs and the phone bar, and that
// zero draws nothing at all rather than an empty circle.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-nav-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { MobileTabs, Nav, visibleItems } from '../src/components/Nav';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

function at(pathname: string, node: ReactNode): string {
  return renderToStaticMarkup(<PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>);
}

console.log('- the tab -');
check('an affiliate has a Support tab', visibleItems(false).some((item) => item.href === '/support'));
check('an admin too', visibleItems(true).some((item) => item.href === '/support'));
check('it is labelled Support', visibleItems(true).find((item) => item.href === '/support')?.label === 'Support');

console.log('- the badge -');
for (const [name, isAdmin] of [['affiliate', false], ['admin', true]] as const) {
  const quiet = at('/', <Nav isAdmin={isAdmin} supportUnread={0} />);
  check(`${name}: nothing unread draws no badge`, !quiet.includes('data-support-unread'));
  const loud = at('/', <Nav isAdmin={isAdmin} supportUnread={3} />);
  check(`${name}: three unread draws a 3`, /data-support-unread="3"[^>]*>3</.test(loud), loud);
  check(`${name}: and says so to a screen reader`, loud.includes('3 unread'));
  const phone = at('/', <MobileTabs isAdmin={isAdmin} supportUnread={3} />);
  check(`${name}: the phone bar has it too`, /data-support-unread="3"[^>]*>3</.test(phone));
  check(`${name}: exactly one badge per bar`, loud.split('data-support-unread').length === 2 && phone.split('data-support-unread').length === 2);
}
check('a large count is capped', at('/', <Nav isAdmin supportUnread={250} />).includes('>99+<'));
check('the prop is optional', !at('/', <Nav isAdmin />).includes('data-support-unread'));

console.log('- where you are -');
const onList = at('/support', <Nav isAdmin={false} />);
check('the tab is current on the list', /href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(onList));
const onThread = at('/support/12', <Nav isAdmin={false} />);
check('and on a conversation', /href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(onThread));
const elsewhere = at('/links', <Nav isAdmin={false} />);
check('and not anywhere else', !/href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(elsewhere));
check('the Create tab still owns /links/new', /href="\/links\/new"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/links\/new"/.test(at('/links/new', <Nav isAdmin={false} />)));

console.log(`\nsupport-nav: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-nav-render-checks.tsx`
Expected: `FAIL: an affiliate has a Support tab` among others, exit code 1.

- [ ] **Step 3: Add the tab and the badge to the nav**

In `src/components/Nav.tsx`:

Add the import under the existing imports:

```ts
import { badgeText } from '@/lib/support';
```

Add this entry to `ITEMS`, immediately after the `{ href: '/cpa', label: 'Cards' },` line:

```ts
  // Everyone, and the same page for both: an affiliate sees their own tickets
  // and an admin sees all of them. The page and the route decide which, from
  // the session.
  { href: '/support', label: 'Support' },
```

Add this line to `isActive`, immediately after the `/cpa` line:

```ts
  if (href === '/support') return pathname.startsWith('/support');
```

Add this component above `export function Nav`:

```tsx
/**
 * How many support tickets have something this viewer has not read.
 *
 * Nothing at all for zero: a badge that is always there stops being a signal.
 * The number is repeated in words for a screen reader, which would otherwise
 * announce a bare "3" after the tab's name.
 */
function SupportBadge({ count }: { count: number }) {
  const text = badgeText(count);
  if (!text) return null;
  return (
    <span
      data-support-unread={count}
      className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-gold px-1.5 text-[10px] font-semibold leading-[18px] text-ink"
    >
      {text}
      <span className="sr-only"> {count} unread</span>
    </span>
  );
}
```

Change the `Nav` signature and its label:

```tsx
export function Nav({ isAdmin, supportUnread = 0 }: { isAdmin: boolean; supportUnread?: number }) {
```

```tsx
          {item.label}
          {item.href === '/support' ? <SupportBadge count={supportUnread} /> : null}
```

Change the `MobileTabs` signature and its label span:

```tsx
export function MobileTabs({ isAdmin, supportUnread = 0 }: { isAdmin: boolean; supportUnread?: number }) {
```

```tsx
              <span
                className={`text-[12px] ${active ? 'font-semibold text-ink' : 'text-ink-dim'}`}
              >
                {item.label}
                {item.href === '/support' ? <SupportBadge count={supportUnread} /> : null}
              </span>
```

If the check for the `sr-only` text fails because the count reads as `3 3 unread`, that is expected markup: the visible `3` followed by the screen-reader phrase. The check only requires that `3 unread` appears.

- [ ] **Step 4: Run the check to make sure it passes**

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-nav-render-checks.tsx`
Expected: last line `support-nav: N passed, 0 failed`.

- [ ] **Step 5: Feed the count from the layout**

In `src/app/(admin)/layout.tsx`:

Add the imports beside the others:

```ts
import { sideFor } from '@/lib/support';
import { countUnreadSupport, supportEnabled } from '@/lib/support-store';
```

Add this function above `export default async function AdminLayout`:

```ts
/**
 * How many support tickets have something this viewer has not read, for the
 * tab's badge.
 *
 * Zero on any failure. This runs in the layout, in front of every page in the
 * app, and a badge is not worth a page: a database without the support tables
 * yet, or one that is briefly unreachable, must leave every other screen
 * exactly as it was.
 */
async function supportUnreadFor(viewer: { role: 'admin' | 'affiliate'; id: string }): Promise<number> {
  if (!supportEnabled()) return 0;
  try {
    return await countUnreadSupport(sideFor(viewer), viewer.id);
  } catch (error) {
    console.error('counting unread support tickets', error);
    return 0;
  }
}
```

Add this line after `const isAdmin = viewer.role === 'admin';`:

```ts
  const supportUnread = await supportUnreadFor(viewer);
```

Replace `<Nav isAdmin={isAdmin} />` with:

```tsx
          <Nav isAdmin={isAdmin} supportUnread={supportUnread} />
```

Replace `<MobileTabs isAdmin={isAdmin} />` with:

```tsx
        <MobileTabs isAdmin={isAdmin} supportUnread={supportUnread} />
```

If `viewer.role`'s type is not assignable to `'admin' | 'affiliate'`, import `type Viewer` from `@/lib/viewer-core` and type the parameter as `Pick<Viewer, 'role' | 'id'>` instead.

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/list-render-checks.tsx`
Expected: passes as before (the nav change did not disturb another render check).

- [ ] **Step 7: Commit**

```bash
git add src/components/Nav.tsx "src/app/(admin)/layout.tsx" scripts/support-nav-render-checks.tsx
git commit -m "feat(support): Support tab with unread badge"
```

---

### Task 7: Pages and components

**Files:**
- Create: `src/lib/support-client.ts`
- Create: `src/components/SupportList.tsx`
- Create: `src/components/NewTicket.tsx`
- Create: `src/components/SupportThread.tsx`
- Create: `src/app/(admin)/support/page.tsx`
- Create: `src/app/(admin)/support/[id]/page.tsx`
- Test: `scripts/support-render-checks.tsx`

**Interfaces:**
- Consumes: Task 1 (`SupportRow`, `SupportMessage`, `SupportSide`, `SupportStatus`, `SUPPORT_CATEGORIES`, `CATEGORY_LABELS`, `SUPPORT_IMAGE_TYPES`, `MAX_*`, `buildSupportRows`, `statusFilterFrom`, `categoryFilterFrom`, `supportHref`, `sideFor`); Task 2 store reads; Task 3 `ownerFilter`, `shouldMarkRead`; `Modal`, `EmptyState`, `ErrorPanel`, `Pager` components; `pageSlice` (`@/lib/paging`); `formatDateTime` (`@/lib/analytics`); `listUsers`, `findUserById` (`@/lib/users`); `requireViewer` (`@/lib/viewer`).
- Produces:
  - `src/lib/support-client.ts`: `readImages(files: File[]): Promise<{ ok: true; attachments: { name: string; type: string; data: string }[] } | { ok: false; error: string }>`, `checkPicked(files: { size: number; type: string }[]): string` (pure; '' when fine), `postSupport(body: Record<string, unknown>): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string; fields: Record<string, string> }>`, `failureText(status: number, payload: Record<string, unknown>): string` (pure).
  - `SupportList({ rows, admin }: { rows: SupportRow[]; admin: boolean })`
  - `NewTicket({ people }: { people: { id: string; name: string }[] | null })` (`null` for an affiliate)
  - `SupportThread({ ticket, messages, side, markRead })` and the stateless `SupportMessages({ messages, side })` it draws with.

- [ ] **Step 1: Write the failing checks**

Create `scripts/support-render-checks.tsx`:

```tsx
// The support pages, rendered rather than reasoned about.
//
// support-checks pins what the pages are handed; this pins what they draw from
// it, which is where a wiring mistake hides: an unread ticket with no mark on
// it, an affiliate shown somebody's name column, a closed ticket still
// offering Close, a message body that reaches the page as markup.
//
// The components call useRouter, which throws outside a Next request, so the
// router's own context is provided with a stand-in and the real components
// mount.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NewTicket } from '../src/components/NewTicket';
import { SupportList } from '../src/components/SupportList';
import { SupportMessages, SupportThread } from '../src/components/SupportThread';
import { checkPicked, failureText } from '../src/lib/support-client';
import { MAX_ATTACHMENT_BYTES, type SupportMessage, type SupportRow } from '../src/lib/support';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const rendered: string[] = [];
const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
  rendered.push(html);
  return html;
}

const rows: SupportRow[] = [
  { id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'open', waiting: 'Waiting on support', unread: true, lastAt: '2026-10-01T10:00:00.000Z', person: 'Maria Santos' },
  { id: '9', subject: 'Thanks', category: 'Feedback', status: 'closed', waiting: 'Closed', unread: false, lastAt: '2026-09-20T10:00:00.000Z', person: 'Jon Reyes' },
];

console.log('- the list -');
const adminList = render(<SupportList rows={rows} admin />);
check('each ticket links to its conversation', adminList.includes('href="/support/12"') && adminList.includes('href="/support/9"'));
check('the subject is shown', adminList.includes('Where is my payout?'));
check('the category is shown', adminList.includes('Payout issue'));
check('whose move it is is shown', adminList.includes('Waiting on support'));
check('an admin sees whose ticket it is', adminList.includes('Maria Santos'));
check('exactly one ticket is marked unread', adminList.split('data-unread="true"').length === 2);
const mineList = render(<SupportList rows={rows} admin={false} />);
check('an affiliate is not shown a name column', !mineList.includes('Maria Santos') && !mineList.includes('Jon Reyes'));
const emptyAdmin = render(<SupportList rows={[]} admin />);
check('an empty admin list says so', emptyAdmin.includes('No tickets'));
const emptyMine = render(<SupportList rows={[]} admin={false} />);
check('an empty affiliate list invites a first one', emptyMine.includes('New ticket') || emptyMine.includes('new ticket'));

console.log('- a new ticket -');
const mineForm = render(<NewTicket people={null} />);
check('there is a button to open one', mineForm.includes('New ticket'));
check('an affiliate is not asked who it is for', !mineForm.includes('name="userId"'));
check('all four categories are offered', ['Question', 'Payout issue', 'Bug', 'Feedback'].every((label) => mineForm.includes(label)));
check('images only', mineForm.includes('image/png,image/jpeg,image/webp'));
const adminForm = render(<NewTicket people={[{ id: 'u1', name: 'Maria Santos' }]} />);
check('an admin chooses who it is for', adminForm.includes('name="userId"') && adminForm.includes('Maria Santos'));

console.log('- a conversation -');
const messages: SupportMessage[] = [
  { id: '1', authorRole: 'affiliate', authorId: 'u1', authorName: 'maria', body: 'It is late.\nPlease check.', createdAt: '2026-10-01T10:00:00.000Z', attachments: [{ id: '5', name: 'shot.png', type: 'image/png', size: 2000 }] },
  { id: '2', authorRole: 'admin', authorId: 'a1', authorName: 'gimson', body: '<script>alert(1)</script>', createdAt: '2026-10-01T11:00:00.000Z', attachments: [] },
];
const talk = render(<SupportMessages messages={messages} side="affiliate" />);
check('both messages are there', talk.includes('It is late.') && talk.includes('alert(1)'));
check('who wrote each is shown', talk.includes('maria') && talk.includes('gimson'));
check('a message body never reaches the page as markup', !talk.includes('<script>'));
check('line breaks are kept', talk.includes('whitespace-pre-wrap'));
check('an image opens through the signed-in route', talk.includes('/api/support/attachments/5'));
check('the affiliate\'s own message is marked as theirs', /data-mine="true"[\s\S]*It is late/.test(talk));
check('support is named as support to an affiliate', talk.includes('Support'));

const open = render(
  <SupportThread ticket={{ id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'open' }} messages={messages} side="affiliate" markRead />,
);
check('an open ticket can be replied to', open.includes('Send reply'));
check('and closed', open.includes('Close ticket'));
check('and not reopened', !open.includes('Reopen ticket'));
const closed = render(
  <SupportThread ticket={{ id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'closed' }} messages={messages} side="admin" markRead={false} />,
);
check('a closed ticket can be reopened', closed.includes('Reopen ticket'));
check('and not closed again', !closed.includes('Close ticket'));
check('and still replied to, which reopens it', closed.includes('Send reply') && closed.includes('reopen'));

console.log('- before it is sent -');
check('no files is fine', checkPicked([]) === '');
check('three small images are fine', checkPicked([{ size: 10, type: 'image/png' }, { size: 10, type: 'image/jpeg' }, { size: 10, type: 'image/webp' }]) === '');
check('four is refused', checkPicked(Array.from({ length: 4 }, () => ({ size: 10, type: 'image/png' }))) !== '');
check('a PDF is refused', checkPicked([{ size: 10, type: 'application/pdf' }]) !== '');
check('too much together is refused', checkPicked([{ size: MAX_ATTACHMENT_BYTES, type: 'image/png' }, { size: 1, type: 'image/png' }]) !== '');
// Review focus 4: a body the host refuses arrives as a sentence.
check('a 413 from the host is explained', failureText(413, {}).includes('too large'));
check('a refusal says what the route said', failureText(400, { error: 'Write a message first.' }) === 'Write a message first.');
check('with its hint', failureText(409, { error: 'That ticket is already closed.', hint: 'Reload the page to see it.' }) === 'That ticket is already closed. Reload the page to see it.');
check('anything else names the status', failureText(500, {}).includes('500'));

console.log('- house rules -');
check('there was something to read', rendered.length > 8, rendered.length);
check('no em or en dash anywhere', rendered.every((html) => !/[\u2013\u2014]/.test(html)));

console.log(`\nsupport-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx`
Expected: fails to start with `Cannot find module '../src/components/NewTicket'`.

- [ ] **Step 3: Write the client helpers**

Create `src/lib/support-client.ts`:

```ts
/**
 * What the support forms do in the browser before and after a request.
 *
 * Shared by the new-ticket form and the reply box, which both read images off
 * a file input, send a JSON body to /api/support, and have to turn whatever
 * comes back into a sentence.
 *
 * The checks here repeat the route's, on purpose. The route is the one that
 * decides; these exist so somebody who picked four files is told so at once,
 * rather than after uploading three megabytes to be refused.
 */

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, isSupportImageType } from './support';

/** What is wrong with the files somebody picked, or '' when nothing is. Pure. */
export function checkPicked(files: { size: number; type: string }[]): string {
  if (files.length > MAX_ATTACHMENTS) return `Up to ${MAX_ATTACHMENTS} images can be attached to a message.`;
  if (files.some((file) => !isSupportImageType(file.type))) return 'Only PNG, JPEG or WebP images can be attached.';
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) return 'Those images are too large together. Up to about 3 MB in total.';
  return '';
}

/** Each picked file as a data URL, the shape the route reads. */
export async function readImages(
  files: File[],
): Promise<{ ok: true; attachments: { name: string; type: string; data: string }[] } | { ok: false; error: string }> {
  const problem = checkPicked(files);
  if (problem) return { ok: false, error: problem };
  const attachments: { name: string; type: string; data: string }[] = [];
  for (const file of files) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('unreadable'));
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!data) return { ok: false, error: `${file.name} could not be read. Attach it again.` };
    attachments.push({ name: file.name, type: file.type, data });
  }
  return { ok: true, attachments };
}

/**
 * What to tell somebody when a request was refused. Pure.
 *
 * 413 is the host turning the body away before the route ever saw it, so it
 * arrives with no JSON and no sentence of ours; it gets one here.
 */
export function failureText(status: number, payload: Record<string, unknown>): string {
  if (status === 413) return 'Those images are too large to send. Try fewer, or crop them.';
  const error = typeof payload.error === 'string' ? payload.error : '';
  const hint = typeof payload.hint === 'string' ? payload.hint : '';
  if (error) return hint ? `${error} ${hint}` : error;
  return `That did not save (${status}).`;
}

export async function postSupport(
  body: Record<string, unknown>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string; fields: Record<string, string> }> {
  let res: Response;
  try {
    res = await fetch('/api/support', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'That did not send. Check your connection and try again.', fields: {} };
  }
  const payload = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    const fields = payload.fields && typeof payload.fields === 'object' ? (payload.fields as Record<string, string>) : {};
    return { ok: false, error: failureText(res.status, payload), fields };
  }
  return { ok: true, payload };
}

/** What to add to a success message about the email, if the route said anything. */
export function emailNote(payload: Record<string, unknown>): string {
  if (payload.emailed === true) return ' They have been emailed.';
  if (typeof payload.emailProblem === 'string' && payload.emailProblem) return ` No email went: ${payload.emailProblem}`;
  return '';
}
```

- [ ] **Step 4: Write the list**

Create `src/components/SupportList.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Pager } from '@/components/Pager';
import { formatDateTime } from '@/lib/analytics';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';
import type { SupportRow } from '@/lib/support';

/**
 * Support tickets, as a list: what each is about, whose move it is, and
 * whether there is something in it this viewer has not read.
 *
 * One component for both sides. An admin's rows carry whose ticket it is; an
 * affiliate's do not, because every one of them is their own.
 *
 * The whole row is the link. A list of conversations has one thing to do with
 * each of them, which is open it.
 */
export function SupportList({ rows, admin }: { rows: SupportRow[]; admin: boolean }) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[1]);

  if (rows.length === 0) {
    return admin ? (
      <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
        No tickets match. Try another filter.
      </p>
    ) : (
      <div className="mt-5">
        <EmptyState
          title="No tickets yet"
          body="Have a question, found something broken, or have an idea? Press New ticket and we will get back to you here."
        />
      </div>
    );
  }

  const shown = pageSlice(rows, page, perPage);

  return (
    <>
      <ul className="panel mt-5 divide-y divide-edge">
        {shown.map((row) => (
          <li key={row.id} data-unread={row.unread ? 'true' : 'false'}>
            <Link
              href={`/support/${row.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-paper-sunk"
            >
              <span
                aria-hidden
                className={`h-2 w-2 flex-none rounded-full ${row.unread ? 'bg-gold' : 'bg-transparent'}`}
              />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[14px] text-ink ${row.unread ? 'font-semibold' : 'font-medium'}`}>
                  {row.subject}
                  {row.unread ? <span className="sr-only"> (unread)</span> : null}
                </span>
                <span className="mt-1 block truncate text-[12px] text-ink-soft">
                  {admin ? `${row.person} · ` : ''}
                  {row.category} · {formatDateTime(row.lastAt)}
                </span>
              </span>
              <span className={`chip ${row.status === 'closed' ? 'chip-quiet' : row.unread ? 'chip-gold' : 'chip-live'}`}>
                {row.waiting}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Pager
        total={rows.length}
        page={page}
        perPage={perPage}
        onPage={setPage}
        onPerPage={(next) => {
          setPerPage(next);
          setPage(1);
        }}
        label="Tickets"
      />
    </>
  );
}
```

- [ ] **Step 5: Write the new-ticket form**

Create `src/components/NewTicket.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  CATEGORY_LABELS,
  MAX_BODY,
  MAX_SUBJECT,
  SUPPORT_CATEGORIES,
  SUPPORT_IMAGE_TYPES,
  type SupportCategory,
} from '@/lib/support';
import { postSupport, readImages } from '@/lib/support-client';

/**
 * Opening a ticket.
 *
 * A button and the dialog behind it. An affiliate fills in what it is about
 * and what they want to say. An admin also chooses who it is for, which is
 * what `people` being a list rather than null means; the route decides
 * ownership again from the session whatever this form posts.
 *
 * On success it goes straight to the new conversation, which is where the
 * person's next message will be read.
 */
export function NewTicket({ people }: { people: { id: string; name: string }[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>('question');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    setProblems({});
    try {
      const images = await readImages(files);
      if (!images.ok) {
        setError(images.error);
        return;
      }
      const result = await postSupport({
        action: 'open',
        userId: people ? userId : undefined,
        subject,
        category,
        body,
        attachments: images.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        setProblems(result.fields);
        return;
      }
      setOpen(false);
      router.push(`/support/${String(result.payload.ticketId ?? '')}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New ticket
      </button>

      <Modal open={open} title="New ticket" onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {people ? (
            <label className="block">
              <span className="label-cap">Who is it for</span>
              <select
                name="userId"
                className="field mt-1.5 w-full"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                aria-invalid={problems.userId ? true : undefined}
              >
                <option value="">Choose an affiliate</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="block">
            <span className="label-cap">Subject</span>
            <input
              name="subject"
              className="field mt-1.5 w-full"
              value={subject}
              maxLength={MAX_SUBJECT}
              onChange={(event) => setSubject(event.target.value)}
              aria-invalid={problems.subject ? true : undefined}
            />
          </label>

          <label className="block">
            <span className="label-cap">What is it about</span>
            <select
              name="category"
              className="field mt-1.5 w-full"
              value={category}
              onChange={(event) => setCategory(event.target.value as SupportCategory)}
            >
              {SUPPORT_CATEGORIES.map((key) => (
                <option key={key} value={key}>
                  {CATEGORY_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label-cap">Message</span>
            <textarea
              name="body"
              className="field mt-1.5 min-h-[140px] w-full"
              value={body}
              maxLength={MAX_BODY}
              onChange={(event) => setBody(event.target.value)}
              aria-invalid={problems.body ? true : undefined}
            />
          </label>

          <label className="block">
            <span className="label-cap">Screenshots (optional, up to 3)</span>
            <input
              type="file"
              name="attachments"
              multiple
              accept={SUPPORT_IMAGE_TYPES.join(',')}
              className="mt-1.5 block w-full text-[13px] text-ink-soft"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
          </label>

          {error ? (
            <p role="alert" className="text-[13px] text-alarm">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Sending' : 'Send'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
```

- [ ] **Step 6: Write the conversation**

Create `src/components/SupportThread.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { formatDateTime } from '@/lib/analytics';
import { MAX_BODY, SUPPORT_IMAGE_TYPES, type SupportMessage, type SupportSide, type SupportStatus } from '@/lib/support';
import { emailNote, postSupport, readImages } from '@/lib/support-client';

/**
 * The messages of a ticket, oldest first. No state, so every shape it can
 * take is rendered directly by scripts/support-render-checks.tsx.
 *
 * A body is drawn as text and nothing else. React escapes it, and
 * whitespace-pre-wrap keeps the line breaks somebody typed, so there is no
 * markup to interpret and none is.
 *
 * An affiliate sees an admin's messages as coming from "Support" with the
 * admin's name beside it; an admin sees everybody by name.
 */
export function SupportMessages({ messages, side }: { messages: SupportMessage[]; side: SupportSide }) {
  return (
    <ol className="mt-5 space-y-3">
      {messages.map((message) => {
        const mine = message.authorRole === side;
        const who =
          message.authorRole === 'admin' && side === 'affiliate'
            ? `Support (${message.authorName})`
            : message.authorName || (message.authorRole === 'admin' ? 'Support' : 'Affiliate');
        return (
          <li
            key={message.id}
            data-mine={mine ? 'true' : 'false'}
            className={`panel p-4 sm:p-5 ${mine ? 'bg-paper-sunk' : ''}`}
          >
            <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12px] text-ink-soft">
              <strong className="font-semibold text-ink">{who}</strong>
              <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{message.body}</p>
            {message.attachments.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {message.attachments.map((file) => (
                  <li key={file.id}>
                    <a
                      href={`/api/support/attachments/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block border border-edge"
                    >
                      {/* A plain img: these are served from this app's own
                          signed-in route, which next/image cannot fetch. */}
                      <img
                        src={`/api/support/attachments/${file.id}`}
                        alt={file.name}
                        loading="lazy"
                        className="h-24 w-24 object-cover"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One conversation: its messages, a box to answer in, and Close or Reopen.
 *
 * Opening it tells the route it has been read, once, after it mounts. Not
 * during the server render: a link Next prefetched would then mark a ticket
 * read that nobody had looked at. `markRead` is false from Client View, where
 * an admin looking is not the affiliate reading.
 */
export function SupportThread({
  ticket,
  messages,
  side,
  markRead,
}: {
  ticket: { id: string; subject: string; category: string; status: SupportStatus };
  messages: SupportMessage[];
  side: SupportSide;
  markRead: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const picker = useRef<HTMLInputElement | null>(null);
  const marked = useRef(false);

  useEffect(() => {
    if (!markRead || marked.current) return;
    marked.current = true;
    // Refreshed afterwards so the tab's badge drops without a reload.
    void postSupport({ action: 'read', ticketId: ticket.id }).then((result) => {
      if (result.ok) startTransition(() => router.refresh());
    });
  }, [markRead, ticket.id, router]);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const images = await readImages(files);
      if (!images.ok) {
        setError(images.error);
        return;
      }
      const result = await postSupport({
        action: 'reply',
        ticketId: ticket.id,
        body,
        attachments: images.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody('');
      setFiles([]);
      if (picker.current) picker.current.value = '';
      setSaved(`Sent.${emailNote(result.payload)}`);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  async function move(action: 'close' | 'reopen') {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const result = await postSupport({ action, ticketId: ticket.id });
      if (!result.ok) setError(result.error);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const closed = ticket.status === 'closed';

  return (
    <>
      <SupportMessages messages={messages} side={side} />

      <form
        className="panel mt-5 space-y-3 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="block">
          <span className="label-cap">Reply</span>
          <textarea
            name="body"
            className="field mt-1.5 min-h-[110px] w-full"
            value={body}
            maxLength={MAX_BODY}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {closed ? (
          <p className="text-[12px] text-ink-soft">This ticket is closed. Sending a reply will reopen it.</p>
        ) : null}
        <input
          ref={picker}
          type="file"
          name="attachments"
          multiple
          accept={SUPPORT_IMAGE_TYPES.join(',')}
          aria-label="Attach screenshots, up to 3"
          className="block w-full text-[13px] text-ink-soft"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />

        {error ? (
          <p role="alert" className="text-[13px] text-alarm">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-[13px] text-ink-soft">
            {saved}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2">
          {closed ? (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('reopen')}>
              Reopen ticket
            </button>
          ) : (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('close')}>
              Close ticket
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={busy || body.trim() === ''}>
            {busy ? 'Sending' : 'Send reply'}
          </button>
        </div>
      </form>
    </>
  );
}
```

- [ ] **Step 7: Run the render checks to make sure they pass**

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx`
Expected: last line `support-render: N passed, 0 failed`.

If `Modal` renders its children only when open and the two `NewTicket` form checks fail for that reason, read `src/components/Modal.tsx` in full: if it does not render children while closed, export a stateless `NewTicketForm` from `NewTicket.tsx` holding the `<form>` and render that in the check instead, keeping `NewTicket` as the button plus `<Modal><NewTicketForm /></Modal>`.

- [ ] **Step 8: Write the list page**

Create `src/app/(admin)/support/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { NewTicket } from '@/components/NewTicket';
import { SupportList } from '@/components/SupportList';
import {
  buildSupportRows,
  CATEGORY_LABELS,
  categoryFilterFrom,
  sideFor,
  statusFilterFrom,
  SUPPORT_CATEGORIES,
  supportHref,
  type StatusFilter,
  type SupportTicket,
} from '@/lib/support';
import { listSupportTickets, listSupportTicketsFor, supportEnabled } from '@/lib/support-store';
import { listUsers } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Support' };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

/**
 * Support: questions and feedback, as conversations.
 *
 * The same page for both sides, deciding which from the session. An affiliate
 * sees their own tickets, newest activity first, and a button to open one. An
 * admin sees everybody's, opening on the open ones because those are the work,
 * with filters in the URL so a filtered view can be linked to and survives a
 * reload.
 *
 * An admin in Client View is the affiliate here, as everywhere else, and sees
 * that affiliate's tickets.
 */
export default async function SupportPage({ searchParams }: PageProps) {
  const viewer = await requireViewer();
  const side = sideFor(viewer);
  const admin = side === 'admin';

  if (!supportEnabled()) {
    return (
      <ErrorPanel
        title="Support needs a database"
        message="Tickets are kept in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  const query = await searchParams;
  const status = statusFilterFrom(first(query.status));
  const category = categoryFilterFrom(first(query.category));
  const unread = first(query.unread) === '1';

  let tickets: SupportTicket[] = [];
  let people: { id: string; name: string }[] = [];
  let error = '';
  try {
    if (admin) {
      const [all, users] = await Promise.all([
        listSupportTickets({
          status: status === 'all' ? undefined : status,
          category: category || undefined,
        }),
        listUsers(),
      ]);
      tickets = all;
      people = users
        .filter((user) => user.role === 'affiliate' && user.active)
        .map((user) => ({ id: user.id, name: user.fullName || user.username }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Names for every account, active or not: an old ticket still belongs
      // to somebody.
      const names = new Map(users.map((user) => [user.id, user.fullName || user.username]));
      const rows = buildSupportRows(tickets, side, names).filter((row) => !unread || row.unread);
      return (
        <div className="mx-auto w-full max-w-[900px]">
          <Heading admin>
            <NewTicket people={people} />
          </Heading>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((option) => (
              <Link
                key={option.key}
                href={supportHref({ status: option.key, category, unread })}
                className="pill-filter"
                data-active={status === option.key ? 'true' : 'false'}
              >
                {option.label}
              </Link>
            ))}
            <Link
              href={supportHref({ status, category, unread: !unread })}
              className="pill-filter"
              data-active={unread ? 'true' : 'false'}
            >
              Unread only
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              href={supportHref({ status, category: '', unread })}
              className="pill-filter"
              data-active={category === '' ? 'true' : 'false'}
            >
              Every category
            </Link>
            {SUPPORT_CATEGORIES.map((key) => (
              <Link
                key={key}
                href={supportHref({ status, category: key, unread })}
                className="pill-filter"
                data-active={category === key ? 'true' : 'false'}
              >
                {CATEGORY_LABELS[key]}
              </Link>
            ))}
          </div>
          <SupportList rows={rows} admin />
        </div>
      );
    }
    tickets = await listSupportTicketsFor(viewer.id);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not read the tickets.';
  }

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <Heading admin={admin}>{admin ? null : <NewTicket people={null} />}</Heading>
      {error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read the tickets" message={error} hint="" />
        </div>
      ) : (
        <SupportList rows={buildSupportRows(tickets, side, new Map())} admin={false} />
      )}
    </div>
  );
}

function Heading({ admin, children }: { admin: boolean; children: React.ReactNode }) {
  return (
    <div className="rise flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-[26px] leading-[1.05]">Support</h1>
        <p className="plain mt-2.5">
          {admin
            ? 'Questions and feedback from affiliates. Open a ticket to read and answer it.'
            : 'Ask a question, report something broken, or tell us what would make this better. We answer here, and email you when we do.'}
        </p>
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 9: Write the conversation page**

Create `src/app/(admin)/support/[id]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { SupportThread } from '@/components/SupportThread';
import { CATEGORY_LABELS, sideFor, waitingLabel } from '@/lib/support';
import { ownerFilter, shouldMarkRead } from '@/lib/support-api';
import { readSupportThread, supportEnabled } from '@/lib/support-store';
import { findUserById } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Support ticket' };

/**
 * One support conversation.
 *
 * An affiliate's own user id goes into the read itself, so somebody else's
 * ticket is never fetched, and resolves to the same not-found page as a
 * number that was never issued. The ids are sequential; a page that said
 * "that is not yours" would be telling anybody who asked which ones exist.
 *
 * Nothing is marked read here. The conversation component does that from the
 * browser once it has actually mounted, so a link Next prefetched does not
 * count as somebody reading it.
 */
export default async function SupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const side = sideFor(viewer);

  if (!supportEnabled()) {
    return (
      <ErrorPanel
        title="Support needs a database"
        message="Tickets are kept in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  let thread: Awaited<ReturnType<typeof readSupportThread>>;
  try {
    thread = await readSupportThread(id, ownerFilter(viewer));
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read that ticket"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  if (!thread) notFound();

  const { ticket, messages } = thread;
  // Whose ticket it is, for an admin. A name that cannot be read is left off
  // rather than failing the page: the conversation is still the point.
  let person = '';
  if (side === 'admin') {
    const account = await findUserById(ticket.userId).catch(() => null);
    person = account ? account.fullName || account.username : 'Unknown account';
  }

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <p className="text-[13px]">
        <Link href="/support" className="link-text font-medium">
          All tickets
        </Link>
      </p>
      <div className="rise mt-3">
        <h1 className="font-display text-[24px] leading-[1.1]">{ticket.subject}</h1>
        <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-soft">
          <span className={`chip ${ticket.status === 'closed' ? 'chip-quiet' : 'chip-live'}`}>
            {waitingLabel(ticket, side)}
          </span>
          <span>{CATEGORY_LABELS[ticket.category]}</span>
          {person ? <span>{person}</span> : null}
          <span>Ticket {ticket.id}</span>
        </p>
      </div>

      <SupportThread
        ticket={{
          id: ticket.id,
          subject: ticket.subject,
          category: CATEGORY_LABELS[ticket.category],
          status: ticket.status,
        }}
        messages={messages}
        side={side}
        markRead={shouldMarkRead(viewer)}
      />
    </div>
  );
}
```

- [ ] **Step 10: Verify**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx`
Expected: `support-render: N passed, 0 failed`.

Run: `npm run build`
Expected: completes; the route table lists `/support` and `/support/[id]` as dynamic.

- [ ] **Step 11: Commit**

```bash
git add src/lib/support-client.ts src/components/SupportList.tsx src/components/NewTicket.tsx src/components/SupportThread.tsx "src/app/(admin)/support" scripts/support-render-checks.tsx
git commit -m "feat(support): ticket list and conversation pages"
```

---

### Task 8: Whole-feature verification

**Files:**
- No new files. Fixes found here are committed against the file they belong to.

**Interfaces:**
- Consumes: everything above, and the migration applied to the live database by the owner.

- [ ] **Step 1: Run every support check and the neighbours it could have disturbed**

```bash
npx tsx scripts/support-checks.ts
npx tsx scripts/support-store-checks.ts
npx tsx scripts/support-api-checks.ts
npx tsx scripts/support-notify-checks.ts
npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-nav-render-checks.tsx
npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx
npx tsx scripts/slack-checks.ts
npx tsx scripts/receipt-file-checks.ts
npx tsx scripts/payout-api-checks.ts
npm run typecheck
npm run build
```

Expected: every script ends with `0 failed` or no `FAIL` line, and typecheck and build succeed.

- [ ] **Step 2: Hand the migration to the owner**

Stop and tell the owner: the code is complete and checked, and nothing can be exercised until `supabase/migrations/20261006120000_support_tickets.sql` has been run in the Supabase SQL Editor. Do not run it yourself: localhost uses the live database. Wait for them to confirm it is applied.

- [ ] **Step 3: Walk the feature in a browser**

With the migration applied, run `npm run dev` and, signed in as an admin using Client View for the affiliate half, confirm each of these. Every write here lands in the live database, so use one clearly named test ticket ("TEST please ignore") opened for an account the owner names, and tell the owner its number at the end so they can delete it.

1. `/support` as an affiliate with no tickets shows the empty state and a New ticket button.
2. Opening a ticket with a subject, a category, a message and one PNG lands on `/support/<id>` with the message and a thumbnail; the thumbnail opens the full image.
3. A renamed text file as `.png` is refused with a sentence, and nothing is saved.
4. As an admin, `/support` shows the ticket under Open with an unread mark and the Support tab shows a badge of 1.
5. Opening it as an admin clears the badge. Replying shows "Sent." with either "They have been emailed." or the reason no email went.
6. Back in Client View as the affiliate, the Support tab shows a badge of 1, and opening the ticket from Client View does not clear it.
7. Close ticket moves it under Closed; Reopen ticket brings it back; a reply on a closed ticket reopens it.
8. As a different affiliate, `/support/<id>` for that ticket is the not-found page, and `/api/support/attachments/<attachment id>` answers 404.
9. Signed out, `/support` redirects to `/login` and `POST /api/support` answers 401.

- [ ] **Step 4: Commit any fixes**

Add only the files the walk changed, by name. Never `git add -A`: the untracked `md-file/` folder is not part of this work.

```bash
git add <each changed file>
git commit -m "fix(support): corrections from the end-to-end walk"
```

Skip the commit if the walk found nothing.
