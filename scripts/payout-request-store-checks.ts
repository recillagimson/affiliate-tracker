// The payout request store, against a stand-in PostgREST.
//
// What these guard, roughly in order of how much money a mistake would cost:
//
//   - The RPC payload. create_payout_request re-derives ownership and age from
//     public.conversions, but it records the amounts it is handed. A
//     conversion_id sent as a string, or an extra key, is a request the
//     function either refuses or reads differently from what was meant.
//   - Scoping. A request id is a small sequential number. readPayoutRequest
//     with a forUserId must put that user into the query itself, so somebody
//     else's payslip is never fetched in the first place.
//   - The receipt bytes. A list or a document read that selected proof_data
//     would drag a few hundred kilobytes per row across the wire, and the one
//     query allowed to touch them is the one a route calls after it has
//     already decided the caller may see them.
//   - Status. recordPayment and clearPayment are single UPDATEs that cannot
//     touch a cancelled request, so the paid pair constraint always holds and
//     a route can answer 409 when a cancel landed underneath it.
//   - Errors. The codes the migration raises become the store's own error
//     classes; anything else the RPCs raise becomes one plain sentence and
//     never Postgres's own words.
//
// Plus the one check that ties the SQL to the TypeScript: the migration's 15
// day cutoff is a literal, and it has to be the same number as PAYOUT_DAYS.
//
//   npx tsx scripts/payout-request-store-checks.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { PAYOUT_DAYS } from '../src/lib/payout';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const DASHES = /[\u2013\u2014]/;

/* ------------------------------------------------------------ migration --- */

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION = join(MIGRATIONS, '20260914120000_payout_requests.sql');

/**
 * The newest migration that defines create_payout_request, which is the one the
 * database runs, since each one replaces the last. Migration names sort by the
 * timestamp they start with. The table, the error codes and the foreign key
 * stay in the first migration; the cutoff and LG003's wording move with the
 * function, so those are read from here.
 */
function newestFunctionMigration(): { name: string; sql: string } | null {
  try {
    for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort().reverse()) {
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
      if (/create or replace function public\.create_payout_request\(/.test(sql)) return { name, sql };
    }
  } catch {
    // Reported below as a function that is nowhere on disk.
  }
  return null;
}

/**
 * Every single-quoted literal in the SQL, comments removed first. Exception
 * messages reach a person through the store, and comment on table text shows
 * up in the Supabase dashboard, so both are held to the no-dash rule; the
 * explanatory comments around them are not strings and are left alone.
 */
function sqlLiterals(sql: string): string[] {
  const code = sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const out: string[] = [];
  const pattern = /'((?:[^']|'')*)'/g;
  for (let hit = pattern.exec(code); hit; hit = pattern.exec(code)) out.push(hit[1]!.replace(/''/g, "'"));
  return out;
}

function migrationChecks() {
  console.log('the migration:');
  check('the migration is named 20260914120000_payout_requests.sql', existsSync(MIGRATION));
  check(
    'and the draft name is not used',
    !existsSync(join(__dirname, '..', 'supabase', 'migrations', '20260915000000_payout_requests.sql')),
  );
  if (!existsSync(MIGRATION)) return;
  const sql = readFileSync(MIGRATION, 'utf8');

  const dashed = sqlLiterals(sql).filter((text) => DASHES.test(text));
  check('no string in the migration carries an em or en dash', dashed.length === 0, dashed);

  const current = newestFunctionMigration();
  check('create_payout_request is defined in some migration', current !== null);
  if (current) {
    const cutoff = /v_cutoff\s+date\s*:=\s*\(now\(\)\s+at\s+time\s+zone\s+'utc'\)::date\s*-\s*(\d+)\s*;/i.exec(current.sql);
    check(`the cutoff in ${current.name} is written as a literal day count`, Boolean(cutoff));
    check(
      `and that literal is PAYOUT_DAYS (${PAYOUT_DAYS})`,
      Number(cutoff?.[1]) === PAYOUT_DAYS,
      cutoff?.[1],
    );

    const literals = sqlLiterals(current.sql);
    const dashedToo = literals.filter((text) => DASHES.test(text));
    check(`no string in ${current.name} carries an em or en dash`, dashedToo.length === 0, dashedToo);
    const dayCounts = literals.flatMap((text) => [...text.matchAll(/(\d+) days?\b/g)].map((m) => Number(m[1])));
    check(
      'every day count a sentence names is PAYOUT_DAYS too',
      dayCounts.length > 0 && dayCounts.every((n) => n === PAYOUT_DAYS),
      dayCounts,
    );
  }

  for (const code of ['LG001', 'LG002', 'LG003', 'LG004', 'LG005', 'LG006', 'LG007']) {
    check(`the migration raises ${code}`, new RegExp(`errcode\\s*=\\s*'${code}'`).test(sql));
  }
  // No action, not restrict: both refuse, but only no action reports 23503.
  // Postgres 15 and later report a restrict key as 23001.
  check(
    'the users foreign key is named, since lib/users.ts matches on the name, and refuses deletes',
    /constraint\s+payout_requests_user_id_fkey\s+references\s+public\.users\s*\(id\)\s+on\s+delete\s+no\s+action/i.test(sql),
  );
  check(
    'the migration is CRLF throughout',
    !/(^|[^\r])\n/.test(sql),
  );
}

/* --------------------------------------------------------- fake PostgREST --- */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { payout_requests: [], payout_request_items: [] };
/** Set to make the next request fail with this PostgREST error. */
let nextError: { status: number; body: unknown } | null = null;
/** What each RPC answers with when it succeeds. */
const rpcResults: Record<string, unknown> = {};
type Captured = { method: string; path: string; params: URLSearchParams; body: string };
const requests: Captured[] = [];
/** Filters the fake could not read. A store that sends one is sending something untested. */
const misunderstood: string[] = [];

/** Query params that are not a column filter. */
const RESERVED = new Set(['select', 'order', 'offset', 'limit', 'columns', 'on_conflict']);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (RESERVED.has(key) || key.includes('.')) continue;
    const value = row[key];
    if (raw.startsWith('eq.')) {
      if (value === null || value === undefined || String(value) !== raw.slice(3)) return false;
    } else if (raw.startsWith('neq.')) {
      if (String(value) === raw.slice(4)) return false;
    } else if (raw === 'is.null') {
      if (value !== null && value !== undefined) return false;
    } else if (raw === 'not.is.null') {
      if (value === null || value === undefined) return false;
    } else {
      misunderstood.push(`${key}=${raw}`);
      return false;
    }
  }
  return true;
}

/** Split a select list on its top-level commas: `a,b,items(c,d)` is three entries. */
function selectEntries(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out.map((entry) => entry.trim()).filter(Boolean);
}

/** Only the columns that were asked for, embedded items included. What was not selected does not come back. */
function project(table: string, row: Row, params: URLSearchParams): Row {
  const select = params.get('select');
  if (!select || select === '*') return { ...row };
  const out: Row = {};
  for (const entry of selectEntries(select)) {
    const embed = /^([a-z_]+)\((.*)\)$/.exec(entry);
    if (embed && table === 'payout_requests' && embed[1] === 'payout_request_items') {
      const cols = embed[2]!.split(',').map((c) => c.trim());
      const children = db.payout_request_items!.filter((item) => item.request_id === row.id);
      if (params.get('payout_request_items.order')?.startsWith('id.')) {
        children.sort((a, b) => Number(a.id) - Number(b.id));
      }
      out.payout_request_items = children.map((child) =>
        Object.fromEntries(cols.map((col) => [col, child[col]])),
      );
    } else if (entry in row) {
      out[entry] = row[entry];
    }
  }
  return out;
}

/** The two pair constraints, so a write that would break one fails here as it would in Postgres. */
function violatesPairs(row: Row): boolean {
  const paid = row.paid_at !== null && row.paid_at !== undefined;
  const cancelled = row.cancelled_at !== null && row.cancelled_at !== undefined;
  return (row.status === 'paid') !== paid || (row.status === 'cancelled') !== cancelled;
}

function start(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace('/rest/v1/', '');
      const entry: Captured = { method: req.method ?? '', path, params: url.searchParams, body: '' };
      requests.push(entry);
      const wantsOne = String(req.headers.accept ?? '').includes('vnd.pgrst.object+json');

      const send = (status: number, body: unknown) => {
        let payload = body;
        if (wantsOne && Array.isArray(body)) {
          if (body.length !== 1) {
            res.writeHead(406, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 'PGRST116', message: `Results contain ${body.length} rows` }));
            return;
          }
          payload = body[0];
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        entry.body = body;
        if (nextError) {
          const err = nextError;
          nextError = null;
          return send(err.status, err.body);
        }

        if (path.startsWith('rpc/')) {
          return send(200, rpcResults[path.slice(4)] ?? null);
        }

        const rows = db[path] ?? [];
        if (req.method === 'GET') {
          const hits = rows.filter((row) => matches(row, url.searchParams));
          const offset = Number(url.searchParams.get('offset') ?? '0');
          const limit = Number(url.searchParams.get('limit') ?? String(hits.length));
          return send(200, hits.slice(offset, offset + limit).map((row) => project(path, row, url.searchParams)));
        }

        if (req.method === 'PATCH') {
          const patch = JSON.parse(body || '{}') as Row;
          const hits = rows.filter((row) => matches(row, url.searchParams));
          if (path === 'payout_requests' && hits.some((row) => violatesPairs({ ...row, ...patch }))) {
            return send(400, {
              code: '23514',
              message: 'new row for relation "payout_requests" violates check constraint "payout_requests_paid_pair_check"',
            });
          }
          for (const row of hits) Object.assign(row, patch);
          return send(200, hits.map((row) => project(path, row, url.searchParams)));
        }

        send(405, { message: 'not allowed' });
      });
    });
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

function lastRequest(method: string, path: string): Captured | undefined {
  return [...requests].reverse().find((r) => r.method === method && r.path === path);
}

function selected(request: Captured | undefined): string {
  return request?.params.get('select') ?? '';
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function seed() {
  db.payout_requests = [
    {
      id: 7, user_id: 'u1', status: 'paid', requested_at: '2026-10-03T10:00:00+00:00', requested_by: 'mark',
      total_amount: '140.00', amount: '140.00', paid_at: '2026-10-05T12:00:00+00:00', paid_by: 'admin',
      reference: 'TX-1', note: 'first', proof_name: 'receipt.pdf', proof_type: 'application/pdf',
      proof_data: 'data:application/pdf;base64,JVBERi0xLjQ=', proof_at: '2026-10-05T13:00:00+00:00', proof_by: 'admin',
      confirmed_at: null, confirmed_by: '', cancelled_at: null, cancelled_by: '', updated_at: '2026-10-05T13:00:00+00:00',
    },
    {
      id: 8, user_id: 'u1', status: 'cancelled', requested_at: '2026-10-01T10:00:00+00:00', requested_by: 'mark',
      total_amount: '70.00', amount: null, paid_at: null, paid_by: '', reference: '', note: '',
      proof_name: '', proof_type: '', proof_data: '', proof_at: null, proof_by: '',
      confirmed_at: null, confirmed_by: '', cancelled_at: '2026-10-02T09:00:00+00:00', cancelled_by: 'admin',
      updated_at: '2026-10-02T09:00:00+00:00',
    },
    {
      id: 9, user_id: 'u2', status: 'requested', requested_at: '2026-10-04T10:00:00+00:00', requested_by: 'dana',
      total_amount: '35.50', amount: null, paid_at: null, paid_by: '', reference: '', note: '',
      proof_name: '', proof_type: '', proof_data: '', proof_at: null, proof_by: '',
      confirmed_at: null, confirmed_by: '', cancelled_at: null, cancelled_by: '', updated_at: '2026-10-04T10:00:00+00:00',
    },
  ];
  db.payout_request_items = [
    { id: 2, request_id: 7, conversion_id: 13, amount: '70.00', released_at: null },
    { id: 1, request_id: 7, conversion_id: 12, amount: '70.00', released_at: null },
    // A released item whose approval was deleted afterwards: the line survives, the reference does not.
    { id: 3, request_id: 8, conversion_id: null, amount: '70.00', released_at: '2026-10-02T09:00:00+00:00' },
    { id: 4, request_id: 9, conversion_id: 14, amount: '35.50', released_at: null },
  ];
}

/* ------------------------------------------------------------------ main --- */

async function main() {
  migrationChecks();

  const { server, url } = await start();
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const supabase = await import('../src/lib/store/supabase');
  supabase.resetSupabaseClient();
  const errors = await import('../src/lib/store/errors');

  console.log('\nStoreValidationError:');
  const Validation = (errors as Record<string, unknown>).StoreValidationError as
    | (new (message: string) => Error & { status: number })
    | undefined;
  check('errors.ts exports StoreValidationError', typeof Validation === 'function');
  if (Validation) {
    const sample = new Validation('Choose at least one approved card.');
    check('it is a 422', sample.status === 422);
    check('it is named for the logs', sample.name === 'StoreValidationError');
    check('statusForError reads it as a 422', errors.statusForError(sample) === 422);
  }
  const isValidation = (error: unknown) => Boolean(Validation) && error instanceof Validation!;

  console.log('\na blocked approval delete (store/supabase.ts):');
  const store = supabase.createSupabaseStore();
  nextError = {
    status: 400,
    body: {
      code: 'LG007',
      message: 'This approval is part of a payout request and cannot be removed. Cancel the request first if it has not been paid.',
    },
  };
  let error = await thrown(() => store.deleteConversion('12'));
  check('LG007 is a conflict', error instanceof errors.StoreConflictError, error);
  check(
    'which says why and what to do',
    /part of a payout request/.test((error as Error)?.message ?? '') && /Cancel the request first/.test((error as Error)?.message ?? ''),
    (error as Error)?.message,
  );
  check('with no error code in it', !/LG007/.test((error as Error)?.message ?? ''));

  console.log('\na blocked account delete (users.ts):');
  const users = await import('../src/lib/users');
  nextError = {
    status: 409,
    body: {
      code: '23503',
      message:
        'update or delete on table "users" violates foreign key constraint "payout_requests_user_id_fkey" on table "payout_requests"',
      details: 'Key (id)=(u1) is still referenced from table "payout_requests".',
    },
  };
  error = await thrown(() => users.deleteUser('u1'));
  const refusal = (error as Error)?.message ?? '';
  check('an account with payout requests is a conflict', error instanceof errors.StoreConflictError, error);
  check('which says so in words', /payout requests/.test(refusal) && !/fkey|23503|violates/.test(refusal), refusal);
  check('and has no dash in it', !DASHES.test(refusal));
  nextError = {
    status: 409,
    body: {
      code: '23001',
      message:
        'update or delete on table "users" violates RESTRICT setting of foreign key constraint "payout_requests_user_id_fkey" on table "payout_requests"',
    },
  };
  error = await thrown(() => users.deleteUser('u1'));
  check(
    'the same refusal from a restrict key (23001) reads the same',
    error instanceof errors.StoreConflictError && (error as Error).message === refusal,
    (error as Error)?.message,
  );
  nextError = {
    status: 409,
    body: {
      code: '23503',
      message: 'update or delete on table "users" violates foreign key constraint "some_other_fkey" on table "elsewhere"',
    },
  };
  error = await thrown(() => users.deleteUser('u1'));
  check(
    'a different foreign key is not reported as payout requests',
    !/payout requests on file/.test((error as Error)?.message ?? ''),
    (error as Error)?.message,
  );

  let mod: typeof import('../src/lib/payout-request-store') | null = null;
  try {
    mod = await import('../src/lib/payout-request-store');
  } catch (loadError) {
    check('src/lib/payout-request-store.ts loads', false, (loadError as Error).message.split('\n')[0]);
  }
  if (mod) await storeChecks(mod, errors, isValidation);

  check('the fake understood every filter the store sent', misunderstood.length === 0, misunderstood);

  server.closeAllConnections?.();
  server.close();
  console.log(`\npayout-request-store: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function storeChecks(
  mod: typeof import('../src/lib/payout-request-store'),
  errors: typeof import('../src/lib/store/errors'),
  isValidation: (error: unknown) => boolean,
) {
  let error: unknown = null;
  check('payoutsEnabled with Supabase configured', mod.payoutsEnabled() === true);

  console.log('\nlisting:');
  seed();
  requests.length = 0;
  const all = await mod.listPayoutRequests();
  const listed = lastRequest('GET', 'payout_requests');
  check('the admin list reads payout_requests', Boolean(listed));
  check('and never selects proof_data', !selected(listed).includes('proof_data'), selected(listed));
  check('it embeds each request\'s items', selected(listed).includes('payout_request_items(conversion_id,amount)'), selected(listed));
  check('it is not scoped to a user', !listed?.params.has('user_id'));
  check('every request comes back', all.length === 3);

  const paid = all.find((r) => r.id === '7');
  check('the id is a string', paid?.id === '7');
  check('user_id maps to userId', paid?.userId === 'u1');
  check('status reads through', paid?.status === 'paid');
  check('numeric total arrives as a number', paid?.totalAmount === 140 && typeof paid?.totalAmount === 'number');
  check('and so does the amount sent', paid?.amount === 140);
  check('paid fields map across', paid?.paidAt === '2026-10-05T12:00:00+00:00' && paid?.paidBy === 'admin' && paid?.reference === 'TX-1');
  check('a named receipt is a receipt', paid?.proof?.name === 'receipt.pdf' && paid?.proof?.type === 'application/pdf');
  check('without its bytes', !JSON.stringify(all).includes('base64'));
  check('its items come back in the order they were requested', paid?.items.map((i) => i.conversionId).join() === '12,13');
  check('item ids are strings and amounts numbers', paid?.items[0]?.conversionId === '12' && paid?.items[0]?.amount === 70);
  const cancelled = all.find((r) => r.id === '8');
  check('a cancelled request keeps its cancel fields', cancelled?.status === 'cancelled' && cancelled?.cancelledBy === 'admin' && Boolean(cancelled?.cancelledAt));
  check('a released line whose approval was deleted reads as a null card', cancelled?.items[0]?.conversionId === null);
  check('and keeps its amount', cancelled?.items[0]?.amount === 70);
  const open = all.find((r) => r.id === '9');
  check('an unpaid request has no amount, rather than zero', open?.amount === null);
  check('and no receipt', open?.proof === null);
  check('and no paid day', open?.paidAt === null);

  requests.length = 0;
  const mine = await mod.listPayoutRequestsFor('u1');
  const mineRequest = lastRequest('GET', 'payout_requests');
  check('an affiliate list filters on user_id', mineRequest?.params.get('user_id') === 'eq.u1');
  check('and never selects proof_data', !selected(mineRequest).includes('proof_data'));
  check('and holds only their requests', mine.length === 2 && mine.every((r) => r.userId === 'u1'));

  console.log('\npaging past the 1000 row cap:');
  db.payout_requests = Array.from({ length: 1200 }, (_, i) => ({
    id: i + 1, user_id: 'u1', status: 'requested', requested_at: '2026-10-03T10:00:00+00:00', requested_by: 'mark',
    total_amount: '1.00', amount: null, paid_at: null, paid_by: '', reference: '', note: '', proof_name: '',
    proof_type: '', proof_data: '', proof_at: null, proof_by: '', confirmed_at: null, confirmed_by: '',
    cancelled_at: null, cancelled_by: '', updated_at: '2026-10-03T10:00:00+00:00',
  }));
  db.payout_request_items = Array.from({ length: 2350 }, (_, i) => ({
    id: i + 1, request_id: (i % 1200) + 1, conversion_id: 10_000 + i, amount: '1.00', released_at: null,
  }));
  db.payout_request_items.push({ id: 9999, request_id: 1, conversion_id: 555, amount: '1.00', released_at: '2026-10-01T00:00:00+00:00' });
  requests.length = 0;
  const many = await mod.listPayoutRequests();
  check('every request is returned, not the first 1000', many.length === 1200);
  check('in two pages', requests.filter((r) => r.method === 'GET').length === 2);
  check('with a stable order to page over', (requests[0]?.params.get('order') ?? '').includes('id.'), requests[0]?.params.get('order'));

  console.log('\ncommitted cards:');
  requests.length = 0;
  const committed = await mod.listCommittedConversionIds();
  const committedRequest = requests.find((r) => r.method === 'GET');
  check('reads payout_request_items', committedRequest?.path === 'payout_request_items');
  check('and only its conversion_id', selected(committedRequest) === 'conversion_id', selected(committedRequest));
  check('only the live ones', committedRequest?.params.get('released_at') === 'is.null');
  check('never the requests table, where the receipts are', !requests.some((r) => r.path === 'payout_requests'));
  check('every live card, past the 1000 row cap', committed.size === 2350);
  check('as strings, the way Conversion.id is', committed.has('10000') && committed.has('12349'));
  check('a released card is free again', !committed.has('555'));
  check('in three pages', requests.filter((r) => r.method === 'GET').length === 3);

  console.log('\none request:');
  seed();
  requests.length = 0;
  const doc = await mod.readPayoutRequest('7');
  let read = lastRequest('GET', 'payout_requests');
  check('an admin read finds the request', doc?.id === '7' && doc.items.length === 2);
  check('by id', read?.params.get('id') === 'eq.7');
  check('without a user filter', !read?.params.has('user_id'));
  check('and without proof_data', !selected(read).includes('proof_data'));

  requests.length = 0;
  const own = await mod.readPayoutRequest('7', 'u1');
  read = lastRequest('GET', 'payout_requests');
  check('the owner reads their own request', own?.id === '7');
  check('with user_id in the query itself', read?.params.get('user_id') === 'eq.u1');

  requests.length = 0;
  const theirs = await mod.readPayoutRequest('7', 'u2');
  read = lastRequest('GET', 'payout_requests');
  check("somebody else's request is not found", theirs === null);
  check('because the query asked for u2, not because it was checked afterwards', read?.params.get('user_id') === 'eq.u2');

  const blankUser = await mod.readPayoutRequest('7', '');
  check('an empty forUserId narrows to nobody rather than widening to everyone', blankUser === null);
  check('and still filters', lastRequest('GET', 'payout_requests')?.params.get('user_id') === 'eq.');

  check('a request that does not exist is null', (await mod.readPayoutRequest('4040')) === null);
  requests.length = 0;
  check('an id that is not a number is null', (await mod.readPayoutRequest('abc')) === null);
  check('without asking the database', requests.length === 0);

  console.log('\nwho a receipt belongs to:');
  requests.length = 0;
  const owner = await mod.readPayoutRequestOwner('9');
  read = lastRequest('GET', 'payout_requests');
  check('the owner check names the user', owner?.userId === 'u2');
  check('and selects only id and user_id', selected(read) === 'id,user_id', selected(read));
  check('by id', read?.params.get('id') === 'eq.9');
  check('a missing request has no owner', (await mod.readPayoutRequestOwner('4040')) === null);
  requests.length = 0;
  check('a malformed id has no owner', (await mod.readPayoutRequestOwner('7;drop')) === null);
  check('and never reaches the database', requests.length === 0);

  console.log('\nthe receipt bytes:');
  requests.length = 0;
  const proof = await mod.readPayoutRequestProof('7');
  read = lastRequest('GET', 'payout_requests');
  check('the bytes come back', proof?.data === 'data:application/pdf;base64,JVBERi0xLjQ=');
  check('with their name and type', proof?.name === 'receipt.pdf' && proof?.type === 'application/pdf');
  check(
    'from a query that asks for the receipt and nothing else',
    selectEntries(selected(read)).sort().join() === 'proof_data,proof_name,proof_type',
    selected(read),
  );
  check('a request with no receipt has none', (await mod.readPayoutRequestProof('9')) === null);

  console.log('\ncreating a request:');
  rpcResults.create_payout_request = 42;
  requests.length = 0;
  const createdId = await mod.createPayoutRequest({
    userId: 'u1',
    usr: 'mark',
    requestedBy: 'mark (via Admin)',
    items: [
      { conversionId: '12', amount: 70 },
      { conversionId: '13', amount: 35.5 },
    ],
  });
  const rpc = lastRequest('POST', 'rpc/create_payout_request');
  const payload = rpc ? (JSON.parse(rpc.body) as Record<string, unknown>) : {};
  check('it calls rpc/create_payout_request', Boolean(rpc));
  check('once, and nothing else', requests.length === 1);
  check(
    'with exactly p_user_id, p_usr, p_requested_by and p_items',
    Object.keys(payload).sort().join() === 'p_items,p_requested_by,p_user_id,p_usr',
    Object.keys(payload),
  );
  check('the user, key and audit line as given', payload.p_user_id === 'u1' && payload.p_usr === 'mark' && payload.p_requested_by === 'mark (via Admin)');
  const items = payload.p_items as Record<string, unknown>[] | undefined;
  check('p_items is an array of both cards', Array.isArray(items) && items.length === 2);
  check(
    'each item is exactly conversion_id and amount',
    Array.isArray(items) && items.every((item) => Object.keys(item).sort().join() === 'amount,conversion_id'),
    items,
  );
  check('conversion_id is a number, not a string', Array.isArray(items) && items.every((item) => typeof item.conversion_id === 'number'));
  check('amount is a number', Array.isArray(items) && items.every((item) => typeof item.amount === 'number'));
  check('the values carry through unchanged', items?.[0]?.conversion_id === 12 && items?.[0]?.amount === 70 && items?.[1]?.conversion_id === 13 && items?.[1]?.amount === 35.5);
  check('the new id comes back as a string', createdId === '42');

  requests.length = 0;
  error = await thrown(() =>
    mod.createPayoutRequest({ userId: 'u1', usr: 'mark', requestedBy: 'mark', items: [{ conversionId: 'abc', amount: 5 }] }),
  );
  check('a card id that is not a number is refused as invalid', isValidation(error), error);
  check('before the database is asked', requests.length === 0);
  error = await thrown(() =>
    mod.createPayoutRequest({ userId: 'u1', usr: 'mark', requestedBy: 'mark', items: [{ conversionId: '12', amount: Number.NaN }] }),
  );
  check('an amount that is not a number is refused as invalid', isValidation(error), error);
  error = await thrown(() =>
    mod.createPayoutRequest({ userId: 'u1', usr: 'mark', requestedBy: 'mark', items: [{ conversionId: '12', amount: -1 }] }),
  );
  check('a negative amount is refused as invalid', isValidation(error), error);

  console.log('\nwhat the functions raise:');
  const create = () => mod.createPayoutRequest({ userId: 'u1', usr: 'mark', requestedBy: 'mark', items: [{ conversionId: '12', amount: 70 }] });
  const raised: [string, string, (e: unknown) => boolean, string, () => Promise<unknown>][] = [
    ['LG001', 'Choose at least one approved card.', isValidation, 'invalid', create],
    ['LG002', 'The same card was selected twice.', isValidation, 'invalid', create],
    ['LG003', `One of those approvals is not yours, or is not ${PAYOUT_DAYS} days old yet.`, isValidation, 'invalid', create],
    ['LG004', 'One of those approvals is already on a request.', (e) => e instanceof errors.StoreConflictError, 'a conflict', create],
    ['LG005', 'That request no longer exists.', (e) => e instanceof errors.StoreNotFoundError, 'not found', () => mod.cancelPayoutRequest('9', 'admin')],
    ['LG006', 'Only an unpaid request can be cancelled.', (e) => e instanceof errors.StoreConflictError, 'a conflict', () => mod.cancelPayoutRequest('7', 'admin')],
  ];
  for (const [code, message, is, kind, run] of raised) {
    nextError = { status: 400, body: { code, message, details: null, hint: null } };
    error = await thrown(run);
    check(`${code} is ${kind}`, is(error), error);
    check(`${code} reads as the sentence`, (error as Error)?.message === message, (error as Error)?.message);
  }
  check('those are 422, 409 and 404 to a route', errors.statusForError(new errors.StoreConflictError('x')) === 409);

  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    nextError = { status: 400, body: { code: 'XX000', message: 'internal error near relation public.secret_ledger_rows', details: 'row 9 of 12' } };
    error = await thrown(create);
    nextError = { status: 400, body: { code: '22P02', message: 'invalid input syntax for type bigint: "12abc"' } };
    const cancelError = await thrown(() => mod.cancelPayoutRequest('9', 'admin'));
    console.error = originalError;
    check('an unrecognised create error is one plain sentence', (error as Error)?.message === 'That could not be processed.', (error as Error)?.message);
    check('that never carries Postgres text', !/secret_ledger_rows|XX000|row 9/.test((error as Error)?.message ?? ''));
    check('and is not dressed up as a validation or conflict', !isValidation(error) && !(error instanceof errors.StoreConflictError));
    check('an unrecognised cancel error is the same sentence', (cancelError as Error)?.message === 'That could not be processed.', (cancelError as Error)?.message);
    check('the raw text still reaches the server log', logged.some((args) => args.some((a) => String(a).includes('secret_ledger_rows'))));
  } finally {
    console.error = originalError;
  }

  nextError = { status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.create_payout_request(p_items, p_requested_by, p_user_id, p_usr) in the schema cache' } };
  error = await thrown(create);
  check('a function the database does not have yet is a configuration error', error instanceof errors.StoreConfigError, error);
  check('that names the fix', /npx supabase db push/.test((error as Error)?.message ?? ''));
  check('in words rather than PostgREST\'s', !/schema cache|PGRST202/.test((error as Error)?.message ?? ''));

  console.log('\ncancelling:');
  rpcResults.cancel_payout_request = null;
  requests.length = 0;
  await mod.cancelPayoutRequest('9', 'admin');
  const cancelRpc = lastRequest('POST', 'rpc/cancel_payout_request');
  const cancelBody = cancelRpc ? (JSON.parse(cancelRpc.body) as Record<string, unknown>) : {};
  check('it calls rpc/cancel_payout_request', Boolean(cancelRpc));
  check('with exactly p_request_id and p_cancelled_by', Object.keys(cancelBody).sort().join() === 'p_cancelled_by,p_request_id', cancelBody);
  check('the id as a number', cancelBody.p_request_id === 9);
  check('and who did it', cancelBody.p_cancelled_by === 'admin');
  requests.length = 0;
  error = await thrown(() => mod.cancelPayoutRequest('nine', 'admin'));
  check('a malformed id is not found', error instanceof errors.StoreNotFoundError, error);
  check('without calling the function', requests.length === 0);

  console.log('\nrecording and clearing a payment:');
  seed();
  requests.length = 0;
  const recorded = await mod.recordPayment('9', { amount: 35.5, paidOn: '2026-10-06', reference: ' TX-9 ', note: ' sent ', by: 'admin' });
  let patch = lastRequest('PATCH', 'payout_requests');
  let sent = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : {};
  const row9 = () => db.payout_requests!.find((r) => r.id === 9)!;
  check('recording a payment matches the request', recorded === true);
  check('in one request', requests.length === 1);
  check('by id', patch?.params.get('id') === 'eq.9');
  check('never on a cancelled request', patch?.params.get('status') === 'neq.cancelled');
  check('it moves the request to paid', sent.status === 'paid');
  check('with the day, at midday', sent.paid_at === '2026-10-06T12:00:00.000Z');
  check('and the amount, who, reference and note', sent.amount === 35.5 && sent.paid_by === 'admin' && sent.reference === 'TX-9' && sent.note === 'sent');
  check('without touching the receipt', !Object.keys(sent).some((key) => key.startsWith('proof_')));
  check('and the row holds the pair together', row9().status === 'paid' && Boolean(row9().paid_at));

  requests.length = 0;
  const onCancelled = await mod.recordPayment('8', { amount: 70, paidOn: '2026-10-06', reference: '', note: '', by: 'admin' });
  check('a cancelled request cannot be paid: nothing matched', onCancelled === false);
  check('and it stayed cancelled', db.payout_requests!.find((r) => r.id === 8)!.status === 'cancelled');
  check('a missing request matches nothing either', (await mod.recordPayment('4040', { amount: 1, paidOn: '2026-10-06', reference: '', note: '', by: 'admin' })) === false);

  row9().confirmed_at = '2026-10-07T08:00:00+00:00';
  row9().confirmed_by = 'dana';
  requests.length = 0;
  const cleared = await mod.clearPayment('9');
  patch = lastRequest('PATCH', 'payout_requests');
  sent = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : {};
  check('clearing a payment matches the request', cleared === true);
  check('never on a cancelled request', patch?.params.get('status') === 'neq.cancelled' && patch?.params.get('id') === 'eq.9');
  check('it moves the request back to requested', sent.status === 'requested');
  check(
    'and clears amount, paid_at, paid_by, reference and confirmed_at',
    sent.amount === null && sent.paid_at === null && sent.paid_by === '' && sent.reference === '' && sent.confirmed_at === null,
    sent,
  );
  check('the confirmation goes with the payment it confirmed', row9().confirmed_at === null && row9().confirmed_by === '');
  check('the receipt and note stay', !Object.keys(sent).some((key) => key.startsWith('proof_')) && !('note' in sent));
  check('and the row holds the pair together', row9().status === 'requested' && row9().paid_at === null);
  check('clearing a cancelled request matches nothing', (await mod.clearPayment('8')) === false);
  check('and leaves it cancelled', db.payout_requests!.find((r) => r.id === 8)!.status === 'cancelled');

  console.log('\nreceipts:');
  requests.length = 0;
  const attached = await mod.saveProof('9', { name: 'r.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0=', by: 'admin' });
  patch = lastRequest('PATCH', 'payout_requests');
  sent = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : {};
  check('a receipt attaches to a live request', attached === true);
  check('not to a cancelled one', patch?.params.get('status') === 'neq.cancelled');
  check('with its name, type, bytes and who', sent.proof_name === 'r.png' && sent.proof_type === 'image/png' && sent.proof_data === 'data:image/png;base64,iVBORw0=' && sent.proof_by === 'admin');
  check('without touching the payment', !('status' in sent) && !('paid_at' in sent));
  check('a cancelled request takes no receipt', (await mod.saveProof('8', { name: 'r.png', type: 'image/png', data: 'x', by: 'admin' })) === false);
  const removed = await mod.removeProof('9');
  check('and a receipt comes off again', removed === true && row9().proof_data === '' && row9().proof_name === '');

  console.log('\nthe affiliate confirms:');
  seed();
  requests.length = 0;
  const confirmed = await mod.confirmReceipt('u1', '7', 'mark');
  patch = lastRequest('PATCH', 'payout_requests');
  sent = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : {};
  check('confirming a paid request matches it', confirmed === true);
  check('filtered by user_id', patch?.params.get('user_id') === 'eq.u1');
  check('and id', patch?.params.get('id') === 'eq.7');
  check('and only where a payment is recorded', patch?.params.get('paid_at') === 'not.is.null');
  check('it records when and who', typeof sent.confirmed_at === 'string' && sent.confirmed_by === 'mark');
  check("somebody else's request cannot be confirmed", (await mod.confirmReceipt('u2', '7', 'dana')) === false);
  check('an unpaid request cannot be confirmed', (await mod.confirmReceipt('u2', '9', 'dana')) === false);
  check('a malformed id confirms nothing', (await mod.confirmReceipt('u1', 'x', 'mark')) === false);

  console.log('\nconfiguration:');
  nextError = { status: 404, body: { code: 'PGRST205', message: "Could not find the table 'public.payout_requests' in the schema cache" } };
  error = await thrown(() => mod.listPayoutRequests());
  check('a missing table is a configuration error', error instanceof errors.StoreConfigError, error);
  check('that names the fix', /npx supabase db push/.test((error as Error)?.message ?? ''));
  nextError = { status: 401, body: { code: '42501', message: 'permission denied for table payout_requests' } };
  error = await thrown(() => mod.readPayoutRequest('7'));
  check('permission denied points at the key', error instanceof errors.StoreConfigError && /service role key/.test((error as Error).message));

  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  check('payoutsEnabled is false without Supabase', mod.payoutsEnabled() === false);
  error = await thrown(() => mod.listPayoutRequests());
  check('and a read says what to set', error instanceof errors.StoreConfigError && /SUPABASE_URL/.test((error as Error).message));
  process.env.SUPABASE_URL = saved.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;

  const sentences = [
    'That could not be processed.',
    ...raised.map(([, message]) => message),
  ];
  check('no sentence the store raises has a dash in it', sentences.every((s) => !DASHES.test(s)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
