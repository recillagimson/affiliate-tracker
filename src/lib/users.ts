/**
 * Sign-in accounts, in Supabase.
 *
 * Deliberately NOT part of the `Store` interface, which the Google Sheets and
 * local-JSON adapters also implement. Two reasons, and the first is enough:
 *
 *   - A password hash does not belong in a spreadsheet. Sheets are shared by
 *     link, copied, exported and printed; the whole point of a hash is that it
 *     lives somewhere with an access model, and a Sheet's access model is
 *     "whoever has the URL and was ever added as a viewer".
 *   - The local JSON store writes to a directory that does not survive a
 *     serverless deploy, so accounts kept there would vanish on the next push.
 *
 * So accounts require Supabase. Without it the app falls back to the single
 * ADMIN_USER/ADMIN_PASSWORD account it has always had, which still works and
 * is still an admin.
 */

import { ENV_ADMIN_ID, type Role } from './auth';
import { generatePassword, hashPassword, needsRehash, verifyPassword } from './password';
import { StoreConfigError, StoreConflictError, StoreNotFoundError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import { accessRole, type PersonRole } from './roles';
import { normalizeServices, type Service } from './services';
import { newTrackingKey } from './tracking-key';

/** What the UI is allowed to see. The hash never leaves this module. */
export type UserAccount = {
  id: string;
  createdAt: string;
  username: string;
  role: Role;
  usr: string;
  fullName: string;
  email: string;
  /** Collected during onboarding; empty on an account that has not been through it. */
  position: string;
  mobile: string;
  active: boolean;
  passwordChangedAt: string;
  lastLoginAt: string | null;
  createdBy: string;
};

type UserRow = {
  id: string;
  created_at: string;
  username: string;
  password_hash: string;
  role: string;
  usr: string;
  full_name: string;
  email: string;
  position: string;
  mobile: string;
  active: boolean;
  password_changed_at: string;
  last_login_at: string | null;
  created_by: string;
};

/** Every column except the hash. Spelled out so a future column cannot leak by default. */
const PUBLIC_COLUMNS =
  'id, created_at, username, role, usr, full_name, email, position, mobile, active, password_changed_at, last_login_at, created_by';

export function usersEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireUsers(): void {
  if (!usersEnabled()) {
    throw new StoreConfigError(
      'User accounts need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

function toAccount(row: Omit<UserRow, 'password_hash'>): UserAccount {
  return {
    id: row.id,
    createdAt: row.created_at,
    username: row.username,
    // Anything the check constraint would have rejected is treated as the
    // lesser privilege rather than trusted, so a hand-edited row cannot mint
    // an admin by typo.
    role: row.role === 'admin' ? 'admin' : 'affiliate',
    usr: row.usr ?? '',
    fullName: row.full_name ?? '',
    email: row.email ?? '',
    position: row.position ?? '',
    mobile: row.mobile ?? '',
    active: row.active !== false,
    passwordChangedAt: row.password_changed_at,
    lastLoginAt: row.last_login_at,
    createdBy: row.created_by ?? '',
  };
}

type PostgrestErrorish = { code?: string; message?: string; details?: string } | null;

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? 'unknown error';
  const detail = `${message} ${error?.details ?? ''}`;

  if (code === '23505') {
    // Two unique indexes, and telling them apart is the difference between a
    // message that says what to change and one that says "it did not work".
    if (detail.includes('users_usr_key')) {
      throw new StoreConflictError(
        'Another account is already bound to that tracking key. Each key belongs to one person.',
      );
    }
    throw new StoreConflictError('That username is already taken.');
  }
  if (code === '23514') {
    if (detail.includes('username_shape')) {
      throw new StoreConflictError(
        'Usernames are 2 to 32 characters: lowercase letters, numbers, dot, dash or underscore, starting with a letter or number.',
      );
    }
    if (detail.includes('affiliate_needs_usr')) {
      throw new StoreConflictError('An affiliate account needs a tracking key.');
    }
    if (detail.includes('usr_shape')) {
      throw new StoreConflictError('Tracking keys use lowercase letters, numbers and dashes only.');
    }
    throw new StoreConflictError('That account is not a shape the database accepts.');
  }
  /*
   * 23503 on a delete is a row elsewhere still pointing at this account. The
   * one refused on purpose is a payout request: public.payout_requests
   * refuses rather than cascades (migration 20260914120000), so deleting
   * somebody cannot erase the record that they were paid. Requests are never
   * deleted, cancelled ones included, so such an account can be disabled but
   * not removed, and the sentence says so rather than pointing at a step that
   * would not help. 23001 is the same refusal from an "on delete restrict"
   * key, which is what the constraint would report if it were ever redeclared
   * that way.
   */
  if ((code === '23503' || code === '23001') && detail.includes('payout_requests_user_id_fkey')) {
    throw new StoreConflictError(
      'This account has payout requests on file, so it cannot be removed. Disable it instead.',
    );
  }
  if (code === '42P01') {
    throw new StoreConfigError(
      'The users table is missing from this Supabase project. Run: npx supabase db push',
    );
  }
  // A column the code knows about and the database does not: the migrations
  // are behind the deploy. Worth its own message, because the generic one
  // reads like a bug in the query rather than a step nobody has run.
  if (code === '42703') {
    throw new StoreConfigError(
      'The users table is missing columns this version needs. Run: npx supabase db push',
    );
  }
  /*
   * PostgREST answers a *write* against a column it does not know with
   * PGRST204, not with Postgres's own 42703, and PGRST205 for a table. Both
   * mean the same thing as the codes above: the migrations are behind the
   * deploy. Without this branch the reader gets "Could not find the
   * 'onboarding_bypass_note' column of 'users' in the schema cache", which
   * names a column nobody has heard of and no way to fix it.
   */
  if (code === 'PGRST204' || code === 'PGRST205') {
    throw new StoreConfigError(
      'This database is missing columns this version needs. Run: npx supabase db push',
    );
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }
  throw new Error(`${context}: ${message}${code ? ` (${code})` : ''}`);
}

/** Usernames are compared and stored lowercased, so case can never fork an account. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function listUsers(): Promise<UserAccount[]> {
  requireUsers();
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select(PUBLIC_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) fail('reading users', error);
  return (data ?? []).map((row) => toAccount(row as Omit<UserRow, 'password_hash'>));
}

export async function findUserById(id: string): Promise<UserAccount | null> {
  requireUsers();
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select(PUBLIC_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) fail('reading a user', error);
  return data ? toAccount(data as Omit<UserRow, 'password_hash'>) : null;
}

export async function countAdmins(): Promise<number> {
  requireUsers();
  const { count, error } = await getSupabaseClient()
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true);
  if (error) fail('counting admins', error);
  return count ?? 0;
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                              */
/* ------------------------------------------------------------------ */

/**
 * Verify a username and password against the users table.
 *
 * Returns null for every kind of failure — no such user, disabled, wrong
 * password — because the caller must not be able to tell them apart, and
 * neither must anybody watching the caller.
 *
 * A missing user still costs one PBKDF2 derivation. Skipping it would make
 * "no such account" measurably faster than "wrong password", which turns the
 * sign-in form into a way to enumerate who has an account here.
 */
export async function verifyLogin(
  rawUsername: string,
  password: string,
): Promise<UserAccount | null> {
  requireUsers();
  const username = normalizeUsername(rawUsername);

  const { data, error } = await getSupabaseClient()
    .from('users')
    .select(`${PUBLIC_COLUMNS}, password_hash`)
    .eq('username', username)
    .maybeSingle();
  if (error) fail('checking a sign-in', error);

  const row = data as UserRow | null;

  if (!row) {
    // Decoy work against a throwaway hash, so the timing of a wrong username
    // matches the timing of a wrong password.
    await verifyPassword(password, DECOY_HASH);
    return null;
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  // Checked after the password on purpose: answering "that account is
  // disabled" before verifying would confirm the username to anyone guessing.
  if (row.active === false) return null;

  const account = toAccount(row);
  await afterSuccessfulLogin(row, password);
  return account;
}

/**
 * A well-formed hash that nothing can ever match: the salt and the digest are
 * both all zero bytes. Verifying against it costs a full PBKDF2 derivation at
 * the current iteration count, which is exactly the point — it buys the
 * "no such user" path the same latency as the "wrong password" path.
 */
const DECOY_HASH =
  'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Fire-and-forget bookkeeping: never let it fail a sign-in that already succeeded. */
async function afterSuccessfulLogin(row: UserRow, password: string): Promise<void> {
  const patch: Record<string, unknown> = { last_login_at: new Date().toISOString() };

  // Silently upgrade a hash written at a lower iteration count. This is the
  // only moment the plaintext is available to do it with.
  if (needsRehash(row.password_hash)) {
    try {
      patch.password_hash = await hashPassword(password);
    } catch {
      // Keep the old hash. It still verifies.
    }
  }

  try {
    await getSupabaseClient().from('users').update(patch).eq('id', row.id);
  } catch {
    // A failed timestamp write is not a reason to refuse a valid sign-in.
  }
}

/* ------------------------------------------------------------------ */
/* Administration                                                       */
/* ------------------------------------------------------------------ */

export type NewUser = {
  username: string;
  role: Role;
  fullName: string;
  email: string;
  createdBy: string;
};

/**
 * How many times to redraw a tracking key that collides.
 *
 * A collision needs two of 887 million to land on the same value, so this is
 * far more headroom than the birthday maths asks for. It exists because the
 * only correct way to check uniqueness is to let the unique index decide —
 * a SELECT-then-INSERT would race two admins creating accounts at once.
 */
const KEY_ATTEMPTS = 5;

/**
 * Create an account and return the one and only copy of its password.
 *
 * The plaintext is returned here and never again: it is not stored, not logged,
 * and not recoverable. Losing it means resetting it.
 *
 * An affiliate's tracking key is generated here rather than supplied, so it is
 * neither guessable nor personal, and so two people with the same first name
 * cannot collide.
 */
export async function createUser(
  input: NewUser,
): Promise<{ user: UserAccount; password: string }> {
  requireUsers();

  const username = normalizeUsername(input.username);
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  for (let attempt = 1; ; attempt += 1) {
    const row = {
      id: crypto.randomUUID(),
      username,
      password_hash: passwordHash,
      role: input.role,
      // An admin is scoped to nothing, because it sees everything.
      usr: input.role === 'admin' ? '' : newTrackingKey(),
      full_name: input.fullName,
      email: input.email,
      active: true,
      /*
       * An affiliate starts pending and is let in by a person. An admin does
       * not: they never see the onboarding flow, nothing gates them on this
       * column, and leaving them at the default would put accounts in a review
       * queue that has no bearing on them.
       */
      approval_status: input.role === 'admin' ? 'approved' : 'pending',
      created_by: input.createdBy,
    };

    const { data, error } = await getSupabaseClient()
      .from('users')
      .insert(row)
      .select(PUBLIC_COLUMNS)
      .single();

    if (!error) {
      return { user: toAccount(data as Omit<UserRow, 'password_hash'>), password };
    }

    // Only a *key* collision is worth retrying, and only while attempts remain.
    // A duplicate username is the caller's problem and must surface as one, not
    // be redrawn five times and then reported as a key failure.
    const isKeyCollision =
      error.code === '23505' &&
      `${error.message} ${error.details ?? ''}`.includes('users_usr_key');
    if (!isKeyCollision || attempt >= KEY_ATTEMPTS) fail('creating a user', error);
  }
}

/**
 * Issue a new password and return it once.
 *
 * `password_changed_at` moves forward, which invalidates every session token
 * minted before now — so a reset actually signs the person out everywhere
 * rather than just changing what they type next time.
 */
export async function resetUserPassword(id: string): Promise<{ user: UserAccount; password: string }> {
  requireUsers();

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  const { data, error } = await getSupabaseClient()
    .from('users')
    .update({
      password_hash: passwordHash,
      password_changed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) fail('resetting a password', error);
  if (!data) throw new StoreNotFoundError('That account no longer exists.');

  return { user: toAccount(data as Omit<UserRow, 'password_hash'>), password };
}

/**
 * Enable or disable an account.
 *
 * Disabling also moves `password_changed_at`, because an account that cannot
 * sign in but whose existing cookie still works is not disabled in any sense
 * the word normally carries.
 */
export async function setUserActive(id: string, active: boolean): Promise<UserAccount> {
  requireUsers();

  const patch: Record<string, unknown> = { active };
  if (!active) patch.password_changed_at = new Date().toISOString();

  const { data, error } = await getSupabaseClient()
    .from('users')
    .update(patch)
    .eq('id', id)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) fail('updating a user', error);
  if (!data) throw new StoreNotFoundError('That account no longer exists.');
  return toAccount(data as Omit<UserRow, 'password_hash'>);
}

export async function deleteUser(id: string): Promise<void> {
  requireUsers();
  const { data, error } = await getSupabaseClient()
    .from('users')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) fail('deleting a user', error);
  if (!data) throw new StoreNotFoundError('That account no longer exists.');
}

/* ------------------------------------------------------------------ */
/* LGF employees                                                         */
/* ------------------------------------------------------------------ */

/*
 * lgf_employee is read on its own rather than added to PUBLIC_COLUMNS. Those
 * are read on every request, sign-in included, so a database whose migrations
 * are behind would lock everybody out over a label. Here it only costs the
 * label. See lib/roles.ts for what the column means.
 */

/**
 * The tracking keys that earn no affiliate share: LGF employees' and admins'.
 * Every approval on one of these is the company's in full. See lib/analytics
 * shareFor, which is where this list is applied.
 *
 * Admins are here because an affiliate made an admin keeps their tracking key
 * (setUserRole), and whatever still comes in on it is not paid out as a share.
 *
 * Unlike the label reads below, a failure here is thrown: this list changes
 * what people are paid, and quietly treating an employee as an affiliate would
 * price their approvals as payable. A database without the lgf_employee column
 * has no employees to list, so that case falls back to the admins alone.
 */
export async function listNoShareKeys(): Promise<Set<string>> {
  if (!usersEnabled()) return new Set();
  let { data, error } = await getSupabaseClient()
    .from('users')
    .select('usr')
    .or('role.eq.admin,lgf_employee.eq.true');
  if (error && ['42703', 'PGRST204'].includes(error.code ?? '')) {
    ({ data, error } = await getSupabaseClient().from('users').select('usr').eq('role', 'admin'));
  }
  if (error) fail('reading which accounts earn no share', error);
  return new Set(
    (data ?? []).map((row) => String((row as { usr: string | null }).usr ?? '')).filter(Boolean),
  );
}

/** Which accounts are LGF employees. Empty, not an error, if it cannot be read. */
export async function listLgfEmployeeIds(): Promise<Set<string>> {
  requireUsers();
  const { data, error } = await getSupabaseClient().from('users').select('id').eq('lgf_employee', true);
  if (error) return new Set();
  return new Set((data ?? []).map((row) => String((row as { id: string }).id)));
}

export async function isLgfEmployee(id: string): Promise<boolean> {
  requireUsers();
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('lgf_employee')
    .eq('id', id)
    .maybeSingle();
  if (error) return false;
  return Boolean((data as { lgf_employee?: boolean } | null)?.lgf_employee);
}

export async function setLgfEmployee(id: string, lgfEmployee: boolean): Promise<void> {
  requireUsers();
  const { error } = await getSupabaseClient().from('users').update({ lgf_employee: lgfEmployee }).eq('id', id);
  if (error) fail('saving the role', error);
}

/* ------------------------------------------------------------------ */
/* Services                                                             */
/* ------------------------------------------------------------------ */

/*
 * Read and written on their own, never as part of PUBLIC_COLUMNS, the way
 * lgf_employee is. Naming the column in the query every page runs would make
 * every page fail on a database that has not had migration 20261009120000
 * yet. This way the worst that happens before it is run is that everybody
 * reads as personal cards, which is what they are.
 */

const SERVICES_MISSING =
  'Services are not set up in this database yet. Run the 20261009120000_user_services migration, then save again.';

/** What everybody is onboarded for, by account id. Empty, not an error, if it cannot be read. */
export async function listUserServices(): Promise<Map<string, Service[]>> {
  requireUsers();
  const { data, error } = await getSupabaseClient().from('users').select('id, services');
  const out = new Map<string, Service[]>();
  if (error) return out;
  for (const row of (data ?? []) as { id: string; services?: unknown }[]) {
    out.set(String(row.id), normalizeServices(row.services));
  }
  return out;
}

/** What one person is onboarded for. Personal cards if it cannot be read, which is the default. */
export async function readUserServices(id: string): Promise<Service[]> {
  requireUsers();
  const { data, error } = await getSupabaseClient().from('users').select('services').eq('id', id).maybeSingle();
  if (error) return normalizeServices(undefined);
  return normalizeServices((data as { services?: unknown } | null)?.services);
}

/** Set what somebody is onboarded for. The list is stored once each, in the usual order. */
export async function setUserServices(id: string, services: readonly Service[]): Promise<Service[]> {
  requireUsers();
  const next = normalizeServices(services);
  const { data, error } = await getSupabaseClient()
    .from('users')
    .update({ services: next })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) {
    // The column is not there: the migration has not been run on this database.
    if (error.code === '42703' || error.code === 'PGRST204') throw new StoreConfigError(SERVICES_MISSING);
    fail('saving the services', error);
  }
  if (!data) throw new StoreNotFoundError('That account no longer exists.');
  return next;
}

/**
 * Change what somebody is: admin, affiliate or LGF employee.
 *
 * Made an admin, they keep their tracking key: their links, leads and earnings
 * are recorded against it, and an admin simply stops being scoped to it. Made
 * an affiliate from an admin with no key, they are given one, because an
 * affiliate without one would see nothing and the database refuses it anyway.
 *
 * The guards against locking the app out (yourself, the last admin) are the
 * route's, where the other account guards are.
 */
export async function setUserRole(id: string, role: PersonRole): Promise<UserAccount> {
  requireUsers();
  const current = await findUserById(id);
  if (!current) throw new StoreNotFoundError('That account no longer exists.');

  for (let attempt = 1; ; attempt += 1) {
    const patch: Record<string, unknown> = {
      role: accessRole(role),
      lgf_employee: role === 'lgf_employee',
    };
    if (role !== 'admin' && !current.usr) patch.usr = newTrackingKey();

    const { data, error } = await getSupabaseClient()
      .from('users')
      .update(patch)
      .eq('id', id)
      .select(PUBLIC_COLUMNS)
      .maybeSingle();

    if (!error) {
      if (!data) throw new StoreNotFoundError('That account no longer exists.');
      return toAccount(data as Omit<UserRow, 'password_hash'>);
    }
    const isKeyCollision =
      error.code === '23505' &&
      `${error.message} ${error.details ?? ''}`.includes('users_usr_key');
    if (!isKeyCollision || !patch.usr || attempt >= KEY_ATTEMPTS) fail('changing the role', error);
  }
}

/** The env account is not a row and can never be edited through the UI. */
export function isEnvAdminId(id: string): boolean {
  return id === ENV_ADMIN_ID;
}
