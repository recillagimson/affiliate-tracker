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
  SUPPORT_BUCKET,
  SUPPORT_FILE_TYPES,
  MAX_FILE_BYTES,
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

check('the subject limit is the same number', sql.includes(`between 1 and ${MAX_SUBJECT}`));
check('the body limit is the same number', sql.includes(`between 1 and ${MAX_BODY}`));
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

console.log('- the storage migration -');
const STORAGE = join(__dirname, '..', 'supabase', 'migrations', '20261007120000_support_attachment_storage.sql');
check('it exists under its name', existsSync(STORAGE));
const storage = existsSync(STORAGE) ? readFileSync(STORAGE, 'utf8') : '';
function typesIn(text: string, after: string): string[] {
  const at = text.indexOf(after);
  if (at === -1) return [];
  const match = /\(([^)]*)\)|\[([^\]]*)\]/.exec(text.slice(at + after.length, at + after.length + 500));
  const inner = match ? (match[1] ?? match[2] ?? '') : '';
  return [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}
check(
  'the table accepts the same file types, in the same order',
  typesIn(storage, 'constraint support_attachments_type_check').join() === SUPPORT_FILE_TYPES.join(),
  typesIn(storage, 'constraint support_attachments_type_check'),
);
check(
  'and so does the bucket',
  typesIn(storage, 'array').join() === SUPPORT_FILE_TYPES.join(),
  typesIn(storage, 'array'),
);
check('the bucket is the one the app uses', storage.includes(`'${SUPPORT_BUCKET}'`));
check('the bucket is private', /values \(\s*'support-attachments',\s*'support-attachments',\s*false,/.test(storage));
check('the bucket\'s size limit is the same number', storage.includes(String(MAX_FILE_BYTES)));
check('the files are no longer kept in the table', /drop column if exists data/.test(storage));
check('each attachment has a path', /path text/.test(storage) && /alter column path set not null/.test(storage));
for (const fn of ['create_support_ticket', 'add_support_message']) {
  const body = storage.slice(storage.indexOf(`function public.${fn}(`));
  check(`${fn} is redefined`, storage.includes(`create or replace function public.${fn}(`));
  check(`${fn} counts to the same number`, body.includes(`jsonb_array_length(v_files) > ${MAX_ATTACHMENTS}`));
  check(`${fn} stores a path`, /x\.path/.test(body) && !/x\.data/.test(body));
}
check('it refuses to drop files it would lose', /raise exception/.test(storage) && /data is not null/.test(storage));
const storageLiterals = [...storage.replace(/--.*$/gm, '').matchAll(/'([^']*)'/g)].map((m) => m[1]!);
check('no sentence in it carries a dash', storageLiterals.every((text) => !/[\u2013\u2014]/.test(text)));

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
