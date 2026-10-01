/**
 * Reading and writing what an affiliate hands over on their way in.
 *
 * Sits beside lib/users.ts rather than inside the Store interface, for the same
 * reason accounts do: these rows include a password, a Social Security number
 * and a bank account number, and a Google Sheet is the wrong place for any of
 * the three. Supabase or nothing.
 *
 * The two sensitive numbers are sealed by lib/secret-box.ts before they get
 * here and are only ever unsealed by the two `reveal` functions at the bottom,
 * which exist so that "show me the SSN" is a specific, deliberate, greppable
 * act rather than a side effect of listing a table.
 */

import { addressFrom, formatAddress, tidyAddress, type Address } from './address';
import { hashPassword } from './password';
import { digitsOf, last4 } from './mask';
import {
  isApprovalStatus,
  NO_BYPASS,
  UNREVIEWED,
  type Approval,
  type Bypass,
  type ReviewDecision,
} from './approval';
import { NOTHING_DONE, type OnboardingState } from './onboarding';
import { seal, open } from './secret-box';
import { StoreConfigError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';

export function onboardingEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!onboardingEnabled()) {
    throw new StoreConfigError(
      'Onboarding needs a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

type PostgrestErrorish = { code?: string; message?: string; details?: string } | null;

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? 'unknown error';
  if (code === '42P01') {
    throw new StoreConfigError(
      'The onboarding tables are missing from this Supabase project. Run: npx supabase db push',
    );
  }
  if (code === '42703') {
    throw new StoreConfigError(
      'The users table is missing its onboarding columns. Run: npx supabase db push',
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
  if (code === '23503') {
    throw new StoreConfigError('That account no longer exists.');
  }
  throw new Error(`${context}: ${message}${code ? ` (${code})` : ''}`);
}

/**
 * PostgREST returns an embedded one-to-one as an object and a one-to-many as an
 * array, and which one it decides on depends on it noticing the child's primary
 * key is also its foreign key. Rather than depend on that inference, both
 * shapes are accepted and the question asked of either is only ever "is there a
 * row".
 */
function embedded(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

/**
 * When an embedded document was signed, or null if there is none.
 *
 * Read alongside the mere existence of the row because a waiver settles a
 * document by when it arrived: one filed before the waiver was granted is part
 * of what the admin decided on, and one filed after it is not. See isLocked.
 */
function embeddedAt(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const at = (row as Record<string, unknown>).signed_at;
  return typeof at === 'string' && at ? at : null;
}

/* ------------------------------------------------------------------ */
/* Where somebody is up to                                              */
/* ------------------------------------------------------------------ */

/** An approval as it comes out of a users row. */
function approvalFrom(row: Record<string, unknown>): Approval {
  const status = row.approval_status;
  return {
    status: isApprovalStatus(status) ? status : 'pending',
    submittedAt: typeof row.submitted_at === 'string' ? row.submitted_at : null,
    reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
    reviewedBy: String(row.reviewed_by ?? ''),
    note: String(row.review_note ?? ''),
    emailedAt: typeof row.approval_emailed_at === 'string' ? row.approval_emailed_at : null,
  };
}

/** A waiver as it comes out of a users row. */
function bypassFrom(row: Record<string, unknown>): Bypass {
  const at = row.onboarding_bypassed_at;
  return {
    at: typeof at === 'string' ? at : null,
    by: String(row.onboarding_bypassed_by ?? ''),
    note: String(row.onboarding_bypass_note ?? ''),
  };
}

const PROGRESS_COLUMNS =
  'id, profile_completed_at, approval_status, submitted_at, reviewed_at, reviewed_by, ' +
  'review_note, approval_emailed_at, onboarding_bypassed_at, onboarding_bypassed_by, ' +
  'onboarding_bypass_note, affiliate_agreements(user_id, signed_at), ' +
  'w9_forms(user_id, signed_at), bank_details(user_id, routing_number)';
const PROGRESS_COLUMNS_BEFORE_ROUTING = PROGRESS_COLUMNS.replace('bank_details(user_id, routing_number)', 'bank_details(user_id)');

/** When each signed document was filed, for the two steps that have one. Null
 *  where there is no document. Nothing else is read from those rows here. */
export type SignedAt = { agreement: string | null; w9: string | null };

export const NOTHING_SIGNED: SignedAt = { agreement: null, w9: null };

export type Progress = {
  state: OnboardingState;
  approval: Approval;
  bypass: Bypass;
  signedAt: SignedAt;
};

/**
 * Where somebody is up to, and whether anybody has let them in yet.
 *
 * This runs on every admin page render for every affiliate, so it is one query
 * with three embeds rather than four queries, and the approval columns ride
 * along on the row that was being read anyway. Only the keys are selected from
 * the children — nothing here needs the SSN, and a select that does not ask for
 * it is a select that cannot leak it.
 */
/**
 * Bank details count as done only with a routing number. Rows saved before it
 * was asked for have '', which leaves the step open so the affiliate is asked
 * for it; their sealed account number stays.
 */
function bankComplete(value: unknown, routingKnown = true): boolean {
  if (!routingKnown) return embedded(value);
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return false;
  return String((row as Record<string, unknown>).routing_number ?? '') !== '';
}

/**
 * A database that has not had 20261002120000_bank_routing.sql yet. These reads
 * run on every page, so rather than take the whole app down they retry without
 * the column and treat bank details as they were before routing numbers.
 */
function noRoutingColumn(error: PostgrestErrorish | null): boolean {
  return Boolean(error) && ['42703', 'PGRST204'].includes(error?.code ?? '') && /routing_number/.test(error?.message ?? '');
}

export async function readProgress(userId: string): Promise<Progress> {
  requireStore();
  let routingKnown = true;
  let { data, error } = await getSupabaseClient()
    .from('users')
    .select(PROGRESS_COLUMNS)
    .eq('id', userId)
    .maybeSingle();
  if (noRoutingColumn(error)) {
    routingKnown = false;
    ({ data, error } = await getSupabaseClient()
      .from('users')
      .select(PROGRESS_COLUMNS_BEFORE_ROUTING)
      .eq('id', userId)
      .maybeSingle());
  }
  if (error) fail('reading onboarding progress', error);
  if (!data) {
    return {
      state: { ...NOTHING_DONE },
      approval: { ...UNREVIEWED },
      bypass: { ...NO_BYPASS },
      signedAt: { ...NOTHING_SIGNED },
    };
  }

  const row = data as unknown as Record<string, unknown>;
  return {
    state: {
      profile: Boolean(row.profile_completed_at),
      agreement: embedded(row.affiliate_agreements),
      w9: embedded(row.w9_forms),
      bank: bankComplete(row.bank_details, routingKnown),
    },
    approval: approvalFrom(row),
    bypass: bypassFrom(row),
    signedAt: {
      agreement: embeddedAt(row.affiliate_agreements),
      w9: embeddedAt(row.w9_forms),
    },
  };
}

/** The four steps on their own, for callers that do not care about approval. */
export async function readOnboarding(userId: string): Promise<OnboardingState> {
  return (await readProgress(userId)).state;
}

/** One row per affiliate for the admin table: who has done what. */
export type OnboardingSummary = {
  userId: string;
  /** When the account was opened. Payouts no longer count from it: each
   *  approval runs on its own clock, see eligibleOn in lib/payout-request. */
  createdAt: string;
  username: string;
  fullName: string;
  email: string;
  position: string;
  mobile: string;
  usr: string;
  state: OnboardingState;
  approval: Approval;
  bypass: Bypass;
  agreementSignedAt: string | null;
  w9SignedAt: string | null;
  bankSavedAt: string | null;
};

export async function listOnboarding(): Promise<OnboardingSummary[]> {
  requireStore();
  const columns =
    'id, created_at, username, full_name, email, position, mobile, usr, role, profile_completed_at, ' +
    'approval_status, submitted_at, reviewed_at, reviewed_by, review_note, ' +
    'approval_emailed_at, onboarding_bypassed_at, onboarding_bypassed_by, ' +
    'onboarding_bypass_note, affiliate_agreements(signed_at), w9_forms(signed_at), ' +
    'bank_details(saved_at, routing_number)';
  let routingKnown = true;
  let { data, error } = await getSupabaseClient()
    .from('users')
    .select(columns)
    .eq('role', 'affiliate')
    .order('created_at', { ascending: true });
  if (noRoutingColumn(error)) {
    routingKnown = false;
    ({ data, error } = await getSupabaseClient()
      .from('users')
      .select(columns.replace('bank_details(saved_at, routing_number)', 'bank_details(saved_at)'))
      .eq('role', 'affiliate')
      .order('created_at', { ascending: true }));
  }
  if (error) fail('listing onboarding', error);

  /** The embed is an object or a one-element array; either way we want the date. */
  function stamp(value: unknown, key: string): string | null {
    const row = Array.isArray(value) ? value[0] : value;
    if (!row || typeof row !== 'object') return null;
    const found = (row as Record<string, unknown>)[key];
    return typeof found === 'string' ? found : null;
  }

  return (data ?? []).map((raw) => {
    // Through unknown: an embedded select can type a row as a Postgrest error
    // shape, and the two do not overlap enough for a direct cast.
    const row = raw as unknown as Record<string, unknown>;
    const agreementSignedAt = stamp(row.affiliate_agreements, 'signed_at');
    const w9SignedAt = stamp(row.w9_forms, 'signed_at');
    const bankSavedAt = stamp(row.bank_details, 'saved_at');
    return {
      userId: String(row.id ?? ''),
      createdAt: String(row.created_at ?? ''),
      username: String(row.username ?? ''),
      fullName: String(row.full_name ?? ''),
      email: String(row.email ?? ''),
      position: String(row.position ?? ''),
      mobile: String(row.mobile ?? ''),
      usr: String(row.usr ?? ''),
      state: {
        profile: Boolean(row.profile_completed_at),
        agreement: agreementSignedAt !== null,
        w9: w9SignedAt !== null,
        bank: bankSavedAt !== null && bankComplete(row.bank_details, routingKnown),
      },
      approval: approvalFrom(row),
      bypass: bypassFrom(row),
      agreementSignedAt,
      w9SignedAt,
      bankSavedAt,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Being let in                                                         */
/* ------------------------------------------------------------------ */

/**
 * Their paperwork is in, so they are in the queue.
 *
 * Called after every step that completes the required set, not only the last
 * one, because "the last one" is not a fixed step: somebody can come back and
 * re-save the agreement, and that is a resubmission an admin should see as
 * such.
 *
 * A declined account that saves something goes back to pending. That is the
 * whole route back for somebody who was turned down for a fixable reason, and
 * the alternative is a locked account whose owner has corrected the problem and
 * has no way to say so.
 */
export async function markSubmitted(userId: string): Promise<void> {
  requireStore();
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('approval_status')
    .eq('id', userId)
    .maybeSingle();
  if (error) fail('reading the account status', error);
  const status = (data as Record<string, unknown> | null)?.approval_status;

  const patch: Record<string, unknown> = { submitted_at: now };
  if (status === 'declined') {
    patch.approval_status = 'pending';
    patch.reviewed_at = null;
    patch.reviewed_by = null;
    // The reason stays. They were told it, and an admin looking at a
    // resubmission wants to know what was wrong last time.
  }

  const { error: writeError } = await getSupabaseClient()
    .from('users')
    .update(patch)
    .eq('id', userId);
  if (writeError) fail('recording the submission', writeError);
}

/** The admin's decision. Returns the account as it now stands. */
export async function setApproval(
  userId: string,
  input: { decision: ReviewDecision; note: string; by: string },
): Promise<Approval> {
  requireStore();
  const reviewed = input.decision !== 'pending';
  const patch: Record<string, unknown> = {
    approval_status: input.decision,
    review_note: input.note.trim(),
    reviewed_at: reviewed ? new Date().toISOString() : null,
    reviewed_by: reviewed ? input.by : null,
  };

  const { data, error } = await getSupabaseClient()
    .from('users')
    .update(patch)
    .eq('id', userId)
    .select(
      'approval_status, submitted_at, reviewed_at, reviewed_by, review_note, approval_emailed_at',
    );
  if (error) fail('saving the decision', error);
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('That account no longer exists.');
  return approvalFrom(row);
}

/**
 * Waive the gate for one person, or put it back.
 *
 * Turning it off leaves the note and the name behind rather than clearing them:
 * "this account was let in early, by whom, and why" stays true after the fact,
 * and a column that erases its own history answers no questions later.
 */
export async function setBypass(
  userId: string,
  input: { on: boolean; note: string; by: string },
): Promise<Bypass> {
  requireStore();
  const patch: Record<string, unknown> = input.on
    ? {
        onboarding_bypassed_at: new Date().toISOString(),
        onboarding_bypassed_by: input.by,
        onboarding_bypass_note: input.note.trim(),
      }
    : { onboarding_bypassed_at: null };

  const { data, error } = await getSupabaseClient()
    .from('users')
    .update(patch)
    .eq('id', userId)
    .select('onboarding_bypassed_at, onboarding_bypassed_by, onboarding_bypass_note');
  if (error) fail('saving the bypass', error);
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('That account no longer exists.');
  return bypassFrom(row);
}

/**
 * Written only once the provider has accepted the message.
 *
 * Separate from setApproval so the two cannot be confused: an approval is a
 * decision and a send is a side effect, and the gap between them is exactly
 * what an admin needs to see when a mail domain is not verified yet.
 */
export async function markApprovalEmailed(userId: string): Promise<void> {
  requireStore();
  const { error } = await getSupabaseClient()
    .from('users')
    .update({ approval_emailed_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) fail('recording the email', error);
}

/* ------------------------------------------------------------------ */
/* Step 1 — their details and a password of their own                   */
/* ------------------------------------------------------------------ */

export type ProfileWrite = {
  fullName: string;
  email: string;
  position: string;
  mobile: string;
  /** Empty means leave the existing one alone, which is what a second visit to
   *  step 1 sends when they are only correcting a phone number. */
  password: string;
};

/**
 * Writes the details and the new password together, and returns the moment the
 * password changed.
 *
 * The caller needs that timestamp: every session token carries the
 * password_changed_at it was minted under, so moving it forward signs this
 * person out of the very session they are using. The route mints a replacement
 * cookie from the returned value, which is what stops step 1 from ending at the
 * sign-in page.
 */
export async function saveProfile(
  userId: string,
  input: ProfileWrite,
): Promise<{ passwordChangedAt: string | null }> {
  requireStore();
  const now = new Date().toISOString();
  const changingPassword = input.password.length > 0;

  const patch: Record<string, unknown> = {
    full_name: input.fullName.trim(),
    email: input.email.trim(),
    position: input.position.trim(),
    mobile: input.mobile.trim(),
    profile_completed_at: now,
  };

  /*
   * The two password columns are written together or not at all. Moving
   * password_changed_at without changing the hash would end every session this
   * person has for no reason, and writing a hash of an empty string because the
   * field was left blank would be very much worse than that.
   */
  if (changingPassword) {
    patch.password_hash = await hashPassword(input.password);
    patch.password_changed_at = now;
  }

  const { error } = await getSupabaseClient().from('users').update(patch).eq('id', userId);
  if (error) fail('saving your details', error);
  return { passwordChangedAt: changingPassword ? now : null };
}

/* ------------------------------------------------------------------ */
/* Step 2 — the agreement                                               */
/* ------------------------------------------------------------------ */

/** Where a signature came from. Kept because ESIGN and UETA both turn on being
 *  able to show who signed, when, and that they meant to. */
export type SigningMeta = { ip: string; userAgent: string };

export type AgreementWrite = {
  affiliateName: string;
  affiliateEmail: string;
  /* Street, city, state and ZIP as the form asks for them. The one line the
     document prints is composed from these on the way in, so the two can never
     drift apart: see formatAddress in lib/address. */
  address: Address;
  effectiveDate: string;
  signaturePng: string;
};

export type AgreementRecord = AgreementWrite & {
  userId: string;
  signedAt: string;
  /** The address as the signed copy prints it. On a row signed before the parts
   *  existed it is the only address there is. */
  affiliateAddress: string;
  affirmed: boolean;
  signedIp: string;
  signedUserAgent: string;
  agreementVersion: string;
};

export async function saveAgreement(
  userId: string,
  input: AgreementWrite,
  meta: SigningMeta,
  version: string,
): Promise<void> {
  requireStore();
  // Composed once, from the tidied parts, so the line the document prints and
  // the columns it was built from can never disagree.
  const address = tidyAddress(input.address);
  const { error } = await getSupabaseClient()
    .from('affiliate_agreements')
    .upsert(
      {
        user_id: userId,
        signed_at: new Date().toISOString(),
        affiliate_name: input.affiliateName.trim(),
        affiliate_email: input.affiliateEmail.trim(),
        affiliate_address: formatAddress(address),
        affiliate_address_line1: address.line1,
        affiliate_address_line2: address.line2,
        affiliate_city: address.city,
        affiliate_state: address.state,
        affiliate_postal_code: address.postalCode,
        effective_date: input.effectiveDate,
        signature_png: input.signaturePng,
        affirmed: true,
        signed_ip: meta.ip,
        signed_user_agent: meta.userAgent.slice(0, 400),
        agreement_version: version,
      },
      { onConflict: 'user_id' },
    );
  if (error) fail('saving the agreement', error);
}

export async function readAgreement(userId: string): Promise<AgreementRecord | null> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('affiliate_agreements')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail('reading the agreement', error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    userId: String(row.user_id ?? ''),
    signedAt: String(row.signed_at ?? ''),
    affiliateName: String(row.affiliate_name ?? ''),
    affiliateEmail: String(row.affiliate_email ?? ''),
    affiliateAddress: String(row.affiliate_address ?? ''),
    address: addressFrom(
      {
        line1: String(row.affiliate_address_line1 ?? ''),
        line2: String(row.affiliate_address_line2 ?? ''),
        city: String(row.affiliate_city ?? ''),
        state: String(row.affiliate_state ?? ''),
        postalCode: String(row.affiliate_postal_code ?? ''),
      },
      String(row.affiliate_address ?? ''),
    ),
    effectiveDate: String(row.effective_date ?? ''),
    signaturePng: String(row.signature_png ?? ''),
    affirmed: row.affirmed === true,
    signedIp: String(row.signed_ip ?? ''),
    signedUserAgent: String(row.signed_user_agent ?? ''),
    agreementVersion: String(row.agreement_version ?? ''),
  };
}

/* ------------------------------------------------------------------ */
/* Step 3 — the W-9                                                     */
/* ------------------------------------------------------------------ */

export type W9Write = {
  line1Name: string;
  line2Business: string;
  classification: string;
  llcCode: string;
  otherText: string;
  foreignPartners: boolean;
  exemptPayeeCode: string;
  fatcaCode: string;
  address: string;
  cityStateZip: string;
  accountNumbers: string;
  tinType: 'ssn' | 'ein';
  /** Plaintext, and the only place in this module that holds one. Sealed below
   *  before it goes anywhere near the database. Empty means the number already
   *  on file stands — see the branch in saveW9. */
  tin: string;
  signaturePng: string;
};

/**
 * A stored W-9 as everything except the two reveal functions may see it: the
 * taxpayer number is four digits and a type, never the number.
 */
export type W9Record = Omit<W9Write, 'tin'> & {
  userId: string;
  signedAt: string;
  tinLast4: string;
  certified: boolean;
  signedIp: string;
  signedUserAgent: string;
  formRevision: string;
};

export async function saveW9(
  userId: string,
  input: W9Write,
  meta: SigningMeta,
  revision: string,
): Promise<void> {
  requireStore();
  const digits = digitsOf(input.tin);

  // Everything except the two columns that hold the number itself.
  const columns = {
    signed_at: new Date().toISOString(),
    line1_name: input.line1Name.trim(),
    line2_business: input.line2Business.trim(),
    classification: input.classification,
    llc_code: input.classification === 'llc' ? input.llcCode : '',
    // Only kept for the one box that has a rule beside it to write on.
    other_text: input.classification === 'other' ? input.otherText.trim() : '',
    exempt_payee_code: input.exemptPayeeCode.trim(),
    fatca_code: input.fatcaCode.trim(),
    foreign_partners: input.foreignPartners,
    address: input.address.trim(),
    city_state_zip: input.cityStateZip.trim(),
    account_numbers: input.accountNumbers.trim(),
    tin_type: input.tinType,
    signature_png: input.signaturePng,
    certified: true,
    signed_ip: meta.ip,
    signed_user_agent: meta.userAgent.slice(0, 400),
    form_revision: revision,
  };

  /*
   * No number in hand: this is somebody who came back to fix a line and left
   * the taxpayer field empty, because nothing can read it back to show them.
   * An UPDATE, so the sealed value and its last four are the two columns the
   * statement does not mention and therefore cannot disturb — and it is
   * matched on the row rather than upserted, so a missing row surfaces as an
   * error instead of quietly inserting a W-9 with no number in it.
   */
  if (digits.length === 0) {
    const { data, error } = await getSupabaseClient()
      .from('w9_forms')
      .update(columns)
      .eq('user_id', userId)
      .select('user_id');
    if (error) fail('saving the W-9', error);
    if (!data || data.length === 0) {
      throw new Error('There is no W-9 on file to update. Enter your taxpayer number.');
    }
    return;
  }

  const { error } = await getSupabaseClient()
    .from('w9_forms')
    .upsert(
      {
        ...columns,
        user_id: userId,
        tin_encrypted: seal(digits),
        tin_last4: last4(digits),
      },
      { onConflict: 'user_id' },
    );
  if (error) fail('saving the W-9', error);
}

export async function readW9(userId: string): Promise<W9Record | null> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('w9_forms')
    // Every column except the ciphertext. Spelled out so the sealed number
    // cannot arrive somewhere that did not ask for it.
    .select(
      'user_id, signed_at, line1_name, line2_business, classification, llc_code, other_text, ' +
        'foreign_partners, exempt_payee_code, fatca_code, address, city_state_zip, account_numbers, ' +
        'tin_type, tin_last4, signature_png, certified, signed_ip, signed_user_agent, form_revision',
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail('reading the W-9', error);
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return {
    userId: String(row.user_id ?? ''),
    signedAt: String(row.signed_at ?? ''),
    line1Name: String(row.line1_name ?? ''),
    line2Business: String(row.line2_business ?? ''),
    classification: String(row.classification ?? ''),
    llcCode: String(row.llc_code ?? ''),
    otherText: String(row.other_text ?? ''),
    foreignPartners: row.foreign_partners === true,
    exemptPayeeCode: String(row.exempt_payee_code ?? ''),
    fatcaCode: String(row.fatca_code ?? ''),
    address: String(row.address ?? ''),
    cityStateZip: String(row.city_state_zip ?? ''),
    accountNumbers: String(row.account_numbers ?? ''),
    tinType: row.tin_type === 'ein' ? 'ein' : 'ssn',
    tinLast4: String(row.tin_last4 ?? ''),
    signaturePng: String(row.signature_png ?? ''),
    certified: row.certified === true,
    signedIp: String(row.signed_ip ?? ''),
    signedUserAgent: String(row.signed_user_agent ?? ''),
    formRevision: String(row.form_revision ?? ''),
  };
}

/* ------------------------------------------------------------------ */
/* Step 4 — where the money goes                                        */
/* ------------------------------------------------------------------ */

export type BankWrite = {
  accountName: string;
  bankName: string;
  /** Nine digits, checked by lib/onboarding isRoutingNumber. Not sealed: it names a bank, not an account. */
  routingNumber: string;
  /** Plaintext, sealed below. Empty means the number already on file stands,
   *  so a misspelled account name can be fixed on its own. */
  accountNumber: string;
};

export type BankRecord = {
  userId: string;
  savedAt: string;
  accountName: string;
  bankName: string;
  /** '' on a row saved before routing numbers were asked for. */
  routingNumber: string;
  accountLast4: string;
};

export async function saveBank(userId: string, input: BankWrite): Promise<void> {
  requireStore();
  const digits = digitsOf(input.accountNumber);
  const columns = {
    saved_at: new Date().toISOString(),
    account_name: input.accountName.trim(),
    bank_name: input.bankName.trim(),
    routing_number: digitsOf(input.routingNumber),
  };

  // Same shape as saveW9: an empty number means leave the sealed one alone.
  if (digits.length === 0) {
    const { data, error } = await getSupabaseClient()
      .from('bank_details')
      .update(columns)
      .eq('user_id', userId)
      .select('user_id');
    if (error) fail('saving your bank details', error);
    if (!data || data.length === 0) {
      throw new Error('There are no bank details on file to update. Enter your account number.');
    }
    return;
  }

  const { error } = await getSupabaseClient()
    .from('bank_details')
    .upsert(
      {
        ...columns,
        user_id: userId,
        account_number_encrypted: seal(digits),
        account_number_last4: last4(digits),
      },
      { onConflict: 'user_id' },
    );
  if (error) fail('saving your bank details', error);
}

export async function readBank(userId: string): Promise<BankRecord | null> {
  requireStore();
  let { data, error } = await getSupabaseClient()
    .from('bank_details')
    .select('user_id, saved_at, account_name, bank_name, routing_number, account_number_last4')
    .eq('user_id', userId)
    .maybeSingle();
  if (noRoutingColumn(error)) {
    ({ data, error } = await getSupabaseClient()
      .from('bank_details')
      .select('user_id, saved_at, account_name, bank_name, account_number_last4')
      .eq('user_id', userId)
      .maybeSingle());
  }
  if (error) fail('reading the bank details', error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    userId: String(row.user_id ?? ''),
    savedAt: String(row.saved_at ?? ''),
    accountName: String(row.account_name ?? ''),
    bankName: String(row.bank_name ?? ''),
    routingNumber: String(row.routing_number ?? ''),
    accountLast4: String(row.account_number_last4 ?? ''),
  };
}

/* ------------------------------------------------------------------ */
/* Unsealing, which is its own act                                      */
/* ------------------------------------------------------------------ */

/*
 * These two are the only code in the application that turns a sealed number
 * back into a readable one. They are deliberately not folded into readW9 and
 * readBank: a page that lists twenty affiliates should not be able to decrypt
 * twenty Social Security numbers as a side effect of rendering a table, and
 * keeping the plaintext path in two named functions means "who can see an SSN"
 * is a question you can answer by finding their callers.
 */

export async function revealTin(userId: string): Promise<{ tin: string; type: 'ssn' | 'ein' } | null> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('w9_forms')
    .select('tin_encrypted, tin_type')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail('reading the taxpayer number', error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    tin: open(String(row.tin_encrypted ?? '')),
    type: row.tin_type === 'ein' ? 'ein' : 'ssn',
  };
}

export async function revealAccountNumber(userId: string): Promise<string | null> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('bank_details')
    .select('account_number_encrypted')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail('reading the account number', error);
  if (!data) return null;
  return open(String((data as Record<string, unknown>).account_number_encrypted ?? ''));
}
