/**
 * GoHighLevel, for the one thing Ledger asks of it: text an affiliate.
 *
 * GHL sends a text to a contact, not to a number, so sending is two steps:
 * find (or make) the contact for the affiliate's number, then send to that
 * contact. The text goes out from the sub-account's own number, under the A2P
 * registration that number already has, and shows in that contact's
 * conversation in GHL like any other.
 *
 * Configuration is a Private Integration token from the sub-account (Settings ->
 * Private Integrations, with contacts.write, contacts.readonly and
 * conversations/message.write) and the sub-account's Location ID. Either one
 * unset means texting is off, and off is silent, the way Slack and email are.
 *
 * Every function here throws on failure. lib/sms.ts is the one caller, and it
 * is what makes sure a text that fails never fails an approval.
 */

const BASE_URL = 'https://services.leadconnectorhq.com';
/** GHL versions each API by date, and the two used here are on different ones. */
const CONTACTS_VERSION = '2021-07-28';
const CONVERSATIONS_VERSION = '2021-04-15';
const TIMEOUT_MS = 10_000;

/** What every contact Ledger texts is tagged with, so they can be found in GHL. */
export const GHL_AFFILIATE_TAG = 'ledger-affiliate';

function token(): string {
  return (process.env.GHL_PRIVATE_TOKEN ?? '').trim();
}

function locationId(): string {
  return (process.env.GHL_LOCATION_ID ?? '').trim();
}

export function ghlConfigured(): boolean {
  return Boolean(token() && locationId());
}

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Anything GHL sent back beside the message, e.g. meta.contactId on a duplicate. */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'GhlError';
  }
}

async function ghl(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; version: string },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token()}`,
        version: options.version,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not JSON: an HTML error page from something in front of GHL. The status
      // and the start of it are the useful part.
    }
    if (!response.ok) {
      // GHL's message is sometimes a string and sometimes a list of them.
      const said = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
      const detail = typeof said === 'string' && said ? said : text.slice(0, 200);
      throw new GhlError(
        `GoHighLevel refused the request (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`,
        response.status,
        parsed,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof GhlError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GhlError('GoHighLevel did not answer in time.', 0);
    }
    throw new GhlError(error instanceof Error ? error.message : 'Could not reach GoHighLevel.', 0);
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type GhlContact = { id: string; name: string };

function contactFrom(value: unknown): GhlContact | null {
  const contact = record(value);
  const id = text(contact?.id);
  if (!contact || !id) return null;
  const name =
    text(contact.contactName) ||
    text(contact.name) ||
    [text(contact.firstName), text(contact.lastName)].filter(Boolean).join(' ');
  return { id, name };
}

/** The contact that already has this number, if the sub-account has one. */
export async function findContactByPhone(phone: string): Promise<GhlContact | null> {
  const query = new URLSearchParams({ locationId: locationId(), number: phone });
  const found = await ghl(`/contacts/search/duplicate?${query}`, { version: CONTACTS_VERSION });
  return contactFrom(found.contact);
}

export async function addTags(contactId: string, tags: string[]): Promise<void> {
  await ghl(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: 'POST',
    body: { tags },
    version: CONTACTS_VERSION,
  });
}

export async function createContact(input: {
  fullName: string;
  email: string;
  phone: string;
  tags: string[];
}): Promise<GhlContact> {
  const [first = '', ...rest] = input.fullName.trim().split(/\s+/);
  try {
    const created = await ghl('/contacts/', {
      method: 'POST',
      body: {
        locationId: locationId(),
        firstName: first,
        lastName: rest.join(' '),
        email: input.email.trim() || undefined,
        phone: input.phone,
        tags: input.tags,
        source: 'Ledger',
      },
      version: CONTACTS_VERSION,
    });
    const contact = contactFrom(created.contact);
    if (!contact) throw new GhlError('GoHighLevel created the contact but sent back no id.', 200);
    return contact;
  } catch (error) {
    /*
     * A sub-account that refuses duplicates answers a create for an email it
     * already has with the existing contact's id in meta. That is the contact
     * we wanted to find, so it is used rather than reported.
     */
    const existing = error instanceof GhlError ? text(record(record(error.body)?.meta)?.contactId) : '';
    if (existing) return { id: existing, name: '' };
    throw error;
  }
}

/**
 * The contact to text for this number: the one GHL already has, tagged, or a
 * new one. An existing contact's name and details are never changed — it may
 * be somebody's record GHL was keeping long before Ledger came along.
 */
export async function resolveContact(input: {
  fullName: string;
  email: string;
  phone: string;
}): Promise<GhlContact & { created: boolean }> {
  const found = await findContactByPhone(input.phone);
  if (found) {
    await addTags(found.id, [GHL_AFFILIATE_TAG]);
    return { ...found, created: false };
  }
  const created = await createContact({ ...input, tags: [GHL_AFFILIATE_TAG] });
  return { ...created, created: true };
}

/** Send one SMS to one contact. Returns GHL's message id. */
export async function sendSms(contactId: string, message: string): Promise<string> {
  const sent = await ghl('/conversations/messages', {
    method: 'POST',
    body: { type: 'SMS', contactId, message },
    version: CONVERSATIONS_VERSION,
  });
  return text(sent.messageId);
}
