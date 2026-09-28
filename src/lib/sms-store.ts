/**
 * What texting keeps in the database: who opted in, which GHL contact each
 * affiliate is, and a log of every text sent, skipped or failed.
 *
 * Kept out of lib/users.ts on purpose. The columns here arrive with their own
 * migration (20260928120000_sms_notifications.sql), and the account reads in
 * lib/users.ts are on every page: naming these columns there would take the
 * whole app down on a database whose migrations are behind, where keeping them
 * here only takes texting down.
 */

import type { TextRecipient } from './sms-messages';
import { StoreConfigError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';

type PostgrestErrorish = { code?: string; message?: string } | null;

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(code)) {
    throw new StoreConfigError(
      'The database is missing the texting columns. Run: npx supabase db push',
    );
  }
  throw new Error(`${context}: ${error?.message ?? 'unknown error'}${code ? ` (${code})` : ''}`);
}

export function smsStoreEnabled(): boolean {
  return isSupabaseConfigured();
}

/** The affiliate accounts behind these tracking keys, keyed by key. */
export async function readRecipients(usrs: string[]): Promise<Map<string, TextRecipient>> {
  const keys = [...new Set(usrs.map((usr) => usr.trim()).filter(Boolean))];
  const found = new Map<string, TextRecipient>();
  if (keys.length === 0) return found;

  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('id, usr, username, full_name, email, mobile, active, sms_opt_in_at, ghl_contact_id')
    .eq('role', 'affiliate')
    .in('usr', keys);
  if (error) fail('reading who to text', error);

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const usr = String(row.usr ?? '');
    found.set(usr, {
      userId: String(row.id ?? ''),
      usr,
      username: String(row.username ?? ''),
      fullName: String(row.full_name ?? ''),
      email: String(row.email ?? ''),
      mobile: String(row.mobile ?? ''),
      active: row.active !== false,
      smsOptIn: Boolean(row.sms_opt_in_at),
      ghlContactId: String(row.ghl_contact_id ?? ''),
    });
  }
  return found;
}

/** Remember which GHL contact an affiliate is, or forget it with ''. */
export async function saveContactId(userId: string, contactId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('users')
    .update({ ghl_contact_id: contactId })
    .eq('id', userId);
  if (error) fail('saving the GoHighLevel contact', error);
}

export type SmsStatus = 'sent' | 'skipped' | 'failed';

export type SmsLogWrite = {
  userId: string;
  usr: string;
  phone: string;
  status: SmsStatus;
  approvals: number;
  message: string;
  detail: string;
  ghlMessageId: string;
};

export type SmsLogEntry = SmsLogWrite & { id: number; createdAt: string };

export async function writeSmsLog(rows: SmsLogWrite[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await getSupabaseClient()
    .from('sms_log')
    .insert(
      rows.map((row) => ({
        // A key nobody holds has no account to point at.
        user_id: row.userId || null,
        usr: row.usr,
        phone: row.phone,
        status: row.status,
        approvals: row.approvals,
        message: row.message,
        detail: row.detail,
        ghl_message_id: row.ghlMessageId,
      })),
    );
  if (error) fail('logging texts', error);
}

/** The latest texts for one affiliate, newest first. */
export async function recentTexts(userId: string, limit = 10): Promise<SmsLogEntry[]> {
  const { data, error } = await getSupabaseClient()
    .from('sms_log')
    .select('id, created_at, user_id, usr, phone, status, approvals, message, detail, ghl_message_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('reading texts', error);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at ?? ''),
    userId: String(row.user_id ?? ''),
    usr: String(row.usr ?? ''),
    phone: String(row.phone ?? ''),
    status: (row.status as SmsStatus) ?? 'failed',
    approvals: Number(row.approvals ?? 0),
    message: String(row.message ?? ''),
    detail: String(row.detail ?? ''),
    ghlMessageId: String(row.ghl_message_id ?? ''),
  }));
}

/** What an affiliate's texting looks like, for their own form and the admin page. */
export type SmsSettings = { optInAt: string | null; ghlContactId: string };

export async function readSmsSettings(userId: string): Promise<SmsSettings> {
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('sms_opt_in_at, ghl_contact_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) fail('reading text settings', error);
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    optInAt: typeof row.sms_opt_in_at === 'string' ? row.sms_opt_in_at : null,
    ghlContactId: String(row.ghl_contact_id ?? ''),
  };
}

/**
 * Tick or untick the box. Ticking keeps the moment they first agreed, rather
 * than moving it every time they save their details: that moment is the
 * consent record, and it should say when consent was given.
 */
export async function saveSmsOptIn(userId: string, optIn: boolean): Promise<void> {
  const current = await readSmsSettings(userId);
  if (optIn === Boolean(current.optInAt)) return;
  const { error } = await getSupabaseClient()
    .from('users')
    .update({ sms_opt_in_at: optIn ? new Date().toISOString() : null })
    .eq('id', userId);
  if (error) fail('saving the text opt-in', error);
}
