import { z } from 'zod';
import { isSendableUrl } from './campaigns';
import { RESERVED_SLUGS } from './config';
import { LEAD_STATUSES } from './status';

/** Lowercase, url-safe, no leading/trailing dashes. */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .trim()
  .min(2, 'Slug must be at least 2 characters')
  .max(48, 'Slug must be 48 characters or fewer')
  .transform(normalizeKey)
  .refine((v) => keyPattern.test(v), 'Use letters, numbers and dashes only')
  .refine((v) => !RESERVED_SLUGS.has(v), (v) => ({ message: `"${v}" is a reserved path` }));

export const usrSchema = z
  .string()
  .trim()
  .max(48, 'Assignee key must be 48 characters or fewer')
  .transform(normalizeKey)
  .refine((v) => v === '' || keyPattern.test(v), 'Use letters, numbers and dashes only');

/**
 * Destination must be an absolute http(s) URL. This is the only value we ever
 * redirect a visitor to, so anything that is not plainly http/https is rejected
 * here rather than at redirect time.
 */
export const destinationSchema = z
  .string()
  .trim()
  .min(1, 'Destination URL is required')
  .max(2000, 'Destination URL is too long')
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a full URL including https://',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only http:// and https:// destinations are allowed',
      });
    }
  });

export const linkInputSchema = z.object({
  slug: slugSchema,
  usr: usrSchema.optional().default(''),
  assignee: z.string().trim().max(120).optional().default(''),
  assigneeEmail: z
    .union([z.literal(''), z.string().trim().email('Enter a valid email')])
    .optional()
    .default(''),
  campaign: z.string().trim().min(1, 'Campaign name is required').max(120),
  destination: destinationSchema,
  headline: z.string().trim().max(160).optional().default(''),
  subheadline: z.string().trim().max(300).optional().default(''),
  ctaLabel: z.string().trim().max(60).optional().default(''),
  requirePhone: z.boolean().optional().default(false),
  passUsrParam: z
    .string()
    .trim()
    .max(32)
    .optional()
    .default('')
    .transform((v) => v.replace(/[^A-Za-z0-9_\-]/g, '')),
  active: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().default(''),
});

export type LinkInput = z.infer<typeof linkInputSchema>;

export const linkPatchSchema = linkInputSchema.partial();

export const submissionInputSchema = z.object({
  slug: slugSchema,
  usr: usrSchema.optional().default(''),
  fullName: z.string().trim().min(2, 'Please enter your name').max(120),
  email: z.string().trim().email('Enter a valid email address').max(160),
  phone: z.string().trim().max(40).optional().default(''),
  // Honeypot: real people never fill this in.
  company: z.string().max(200).optional().default(''),
});

/**
 * The one field the admin surface may change on a logged lead. Anything a lead
 * actually typed is a record of what happened and stays as captured.
 *
 * The card is not here either. It is the merchant's record of what was applied
 * for and arrives with the report sync; one typed on the dashboard would be a
 * second version of it. Unknown keys are dropped, so a card sent anyway is
 * ignored rather than saved.
 */
export const submissionPatchSchema = z.object({
  // Not approved: that is recorded with an approval behind it, through
  // /api/leads/[id]/approve, so a lead never reads approved with nobody paid.
  status: z.enum(LEAD_STATUSES).refine((status) => status !== 'registered', {
    message: 'Approve the lead with its card instead.',
  }),
});

/**
 * A real calendar date, not just something shaped like one.
 *
 * The shape test alone accepted 9999-99-99 and 2026-02-31. That is worse than
 * it sounds for an approval date: every window on the dashboard is a string
 * comparison against a start and an end, and a date outside the calendar
 * compares as inside *every* window at once — so one mistyped month silently
 * adds its payout to Today, 7 days, 30 days and All time simultaneously, on
 * every page, permanently.
 *
 * Round-tripping through Date is what catches the overflow: Date turns
 * 2026-02-31 into 2026-03-03, so a value that comes back different was never a
 * real date.
 */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-08-13')
  .superRefine((value, ctx) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That is not a real date' });
      return;
    }
    // A far-future approval would sit at the top of every list forever and
    // never fall out of any window. A year of slack covers a clock skew or a
    // merchant reporting ahead; a typo in the year does not.
    const limit = Date.now() + 366 * 24 * 60 * 60 * 1000;
    if (parsed.getTime() > limit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That date is too far in the future' });
    }
    // Before the web had affiliate links. Catches a transposed year like 0226.
    if (parsed.getUTCFullYear() < 2000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That date is too far in the past' });
    }
  });

/** An approved application, recorded by hand on the dashboard or in the sheet. */
export const conversionInputSchema = z.object({
  // slug + usr identify the link, and the link supplies the person and the card.
  slug: slugSchema,
  usr: usrSchema.optional().default(''),
  // Coerced because it arrives as a string from a number input, and the sheet
  // may hold it either way.
  amount: z.coerce
    .number({ invalid_type_error: 'Enter an amount' })
    .min(0, 'Amount cannot be negative')
    .max(1_000_000, 'That amount looks wrong')
    .optional()
    .default(0),
  approvedOn: isoDateSchema,
  notes: z.string().trim().max(300).optional().default(''),
});

/**
 * Approving a lead by hand, from the leads list.
 *
 * No slug or usr: the lead supplies both, so an approval cannot be filed under
 * somebody other than the person whose link the lead came through. The card
 * goes first in the approval's notes, where the sync reads it back from, so it
 * may not carry the separator or a machine tag that would make a hand-recorded
 * approval pass for one the sync imported.
 */
export const manualApprovalSchema = z.object({
  card: z
    .string()
    .trim()
    .min(1, 'Pick the card they were approved for')
    .max(200, 'That card name is too long')
    .refine((card) => !/·|\b(qmp|manual|lead):/i.test(card), 'That is not a card name'),
  amount: z.coerce
    .number({ invalid_type_error: 'Enter an amount' })
    .min(0, 'Amount cannot be negative')
    .max(1_000_000, 'That amount looks wrong'),
  approvedOn: isoDateSchema,
});

export const visitInputSchema = z.object({
  slug: slugSchema,
  usr: usrSchema.optional().default(''),
});

/* ------------------------------------------------------------------ */
/* Accounts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Matches the users_username_shape_check constraint exactly. Kept in step by
 * hand rather than derived, because the database is the one that has to be
 * right — this copy only exists so the person typing gets told before the
 * insert fails.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username must be 32 characters or fewer')
  .refine(
    (v) => /^[a-z0-9][a-z0-9._-]*$/.test(v),
    'Letters, numbers, dot, dash and underscore only, starting with a letter or number',
  );

/**
 * No `usr` field: an affiliate's tracking key is generated server-side (see
 * lib/tracking-key.ts) rather than chosen. Accepting one here would let a
 * caller bind a new account to an existing person's key and inherit their
 * links, leads and earnings — the unique index would stop the second one, but
 * only after the request had already tried.
 */
export const newUserSchema = z.object({
  username: usernameSchema,
  role: z.enum(['admin', 'affiliate']),
  fullName: z.string().trim().max(120).optional().default(''),
  email: z
    .union([z.literal(''), z.string().trim().email('Enter a valid email')])
    .optional()
    .default(''),
});

export type NewUserInput = z.infer<typeof newUserSchema>;

/** The three things an admin may do to an existing account. */
export const userPatchSchema = z.object({
  action: z.enum(['reset-password', 'enable', 'disable']),
});

/**
 * The campaign list, as the settings page posts it.
 *
 * A blank destination is allowed and means "a category with no URL yet", which
 * is what every campaign was before this list had URLs at all. Anything else
 * has to be a real http(s) address, because the only thing done with it is to
 * send a person there.
 */
export const campaignsInputSchema = z.object({
  campaigns: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1, 'Give the campaign a name')
          .max(80, 'Name must be 80 characters or fewer'),
        destination: z
          .string()
          .trim()
          .max(2000, 'That URL is too long')
          .refine((value) => value === '' || isSendableUrl(value), 'Enter a full URL including https://')
          .default(''),
      }),
    )
    .max(200, 'That is more campaigns than this list is meant to hold'),
});

/** Flatten a ZodError into `{ field: message }` for form rendering. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
