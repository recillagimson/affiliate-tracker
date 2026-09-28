import { digitsOf } from './mask';

/**
 * A mobile number as a text message needs it: E.164, a plus and the country
 * code in front of the digits.
 *
 * The number on an account is whatever the affiliate typed at onboarding —
 * "(415) 555-0123", "0917 123 4567", "+1 415 555 0123" — and step 1 only checks
 * that it has a sensible count of digits. So the stored value is left alone and
 * converted here, at the moment something is sent to it.
 *
 * Two countries are understood without a prefix, because those are the two the
 * affiliates are in: the US (ten digits, or eleven starting with 1) and the
 * Philippines (09XXXXXXXXX, or 63 in front of the ten). Anything written with a
 * leading + is taken as already international. Anything else comes back '' —
 * a number we are not sure of is a text to a stranger, and not sending is the
 * better mistake.
 */
export function toE164(raw: string): string {
  const value = (raw ?? '').trim();
  const digits = digitsOf(value);
  if (!digits) return '';

  if (value.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  }

  // US: 415 555 0123, or 1 415 555 0123. The first digit of an area code and
  // of an exchange is never 0 or 1, which is what tells a US number from a
  // local one that happens to be ten digits long.
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && /^1[2-9]\d{2}[2-9]/.test(digits)) return `+${digits}`;

  // Philippines: 0917 123 4567, or 63 917 123 4567. Mobiles start with 9.
  if (digits.length === 11 && digits.startsWith('09')) return `+63${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('639')) return `+${digits}`;

  return '';
}
