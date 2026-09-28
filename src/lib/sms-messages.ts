import { formatDay } from './analytics';
import { toE164 } from './phone';

/**
 * What an affiliate's phone says when their approvals land, and who is texted.
 *
 * Pure: no network, no database, no environment. lib/sms.ts gathers the
 * accounts and does the sending; everything that decides what is said, and to
 * whom, is here, so it can be checked without texting anybody.
 *
 * The rules, each checked in scripts/sms-checks.ts:
 *
 * - One text per affiliate per event. A sync that imports three approvals for
 *   the same person sends them one summary, not three texts.
 * - The number comes from the affiliate's own account, never from a lead. The
 *   client whose card was approved is not texted and is not named.
 * - No money. Like the Slack line, a text says what was approved and when, and
 *   the figures stay behind the sign-in.
 * - Only somebody who ticked the box is texted, from a number we can read.
 * - With a test number set, every text goes to that number instead, marked with
 *   who it was for, and the opt-in and the stored number are not needed.
 */

/** One approval, as far as a text needs it. */
export type ApprovalText = {
  /** The tracking key the approval landed on: whose it is. */
  usr: string;
  /** The card as the merchant names it. '' when none is on record. */
  card: string;
  /** The link's campaign, which stands in for the card when there is none. */
  campaign: string;
  approvedOn: string;
};

/** An affiliate account, as far as texting needs it. */
export type TextRecipient = {
  userId: string;
  usr: string;
  username: string;
  fullName: string;
  email: string;
  mobile: string;
  active: boolean;
  smsOptIn: boolean;
  ghlContactId: string;
};

export type PlannedText = {
  recipient: TextRecipient;
  /** E.164. The test number when there is one. */
  to: string;
  message: string;
  approvals: number;
  test: boolean;
};

export type SkippedText = {
  usr: string;
  userId: string;
  name: string;
  approvals: number;
  reason: string;
};

/** How many cards a summary names before the rest become "+ N more". */
export const SMS_CARD_CAP = 3;

export const SKIP_NO_ACCOUNT = 'no affiliate account has this tracking key';
export const SKIP_INACTIVE = 'the account is disabled';
export const SKIP_NO_OPT_IN = 'has not opted in to texts';
export const SKIP_BAD_NUMBER = 'the mobile number on their profile cannot be texted';

/**
 * Characters outside the plain SMS alphabet make the carrier send the whole
 * message as Unicode, which fits 70 characters to a segment instead of 160 —
 * the same text, billed two or three times over. Card names are the usual
 * culprit ("Chase Freedom Unlimited®"), so the common ones are spelled out.
 */
const PLAIN: [RegExp, string][] = [
  [/®/g, '(R)'],
  [/™/g, '(TM)'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
];

export function plainText(value: string): string {
  return PLAIN.reduce((text, [pattern, swap]) => text.replace(pattern, swap), value);
}

function firstName(recipient: TextRecipient): string {
  return recipient.fullName.trim().split(/\s+/)[0] || recipient.username;
}

/**
 * The cards, each once, with a count when it came up more than once, capped.
 * A card-less approval is named by its campaign; one with neither is counted
 * but not named.
 */
function cardList(approvals: ApprovalText[]): string {
  const counts = new Map<string, number>();
  for (const approval of approvals) {
    const label = plainText((approval.card || approval.campaign).trim());
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const named = [...counts].map(([label, count]) => (count > 1 ? `${label} (x${count})` : label));
  const shown = named.slice(0, SMS_CARD_CAP);
  const rest = named.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` + ${rest} more` : '');
}

/**
 * The text itself.
 *
 *   LEDGER: Hi Gimson, you have a new approval: Chase Freedom Unlimited(R) (28 Sept 2026).
 *   View: https://ledger.example.com/
 *   Reply STOP to opt out.
 *
 *   LEDGER: Hi Gimson, you have 2 new approvals: Chase Freedom Unlimited(R), Capital One Venture.
 *   View: https://ledger.example.com/
 *   Reply STOP to opt out.
 *
 * The STOP line is not decoration: carriers expect it on business texts, and
 * GoHighLevel honours the reply by marking the contact do-not-disturb.
 */
export function approvalText(
  recipient: TextRecipient,
  approvals: ApprovalText[],
  dashboardUrl: string,
): string {
  const cards = cardList(approvals);
  let headline: string;
  if (approvals.length === 1) {
    const day = formatDay(approvals[0]!.approvedOn);
    headline = cards
      ? `you have a new approval: ${cards} (${day}).`
      : `you have a new approval (${day}).`;
  } else {
    headline = `you have ${approvals.length} new approvals${cards ? `: ${cards}` : ''}.`;
  }

  return [
    `LEDGER: Hi ${plainText(firstName(recipient))}, ${headline}`,
    dashboardUrl ? `View: ${dashboardUrl}` : '',
    'Reply STOP to opt out.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Who gets what. Groups the approvals by the affiliate they belong to, and
 * either writes that affiliate one text or says why not.
 *
 * `recipients` is keyed by tracking key. `testNumber` is already E.164, or ''.
 */
export function planTexts(
  approvals: ApprovalText[],
  recipients: Map<string, TextRecipient>,
  options: { dashboardUrl: string; testNumber: string },
): { send: PlannedText[]; skipped: SkippedText[] } {
  // In the order the approvals came, so the first affiliate named in a sync is
  // the first texted.
  const byUsr = new Map<string, ApprovalText[]>();
  for (const approval of approvals) {
    const key = approval.usr.trim();
    if (!key) continue;
    byUsr.set(key, [...(byUsr.get(key) ?? []), approval]);
  }

  const send: PlannedText[] = [];
  const skipped: SkippedText[] = [];
  const test = Boolean(options.testNumber);

  for (const [usr, theirs] of byUsr) {
    const recipient = recipients.get(usr);
    const skip = (reason: string) =>
      skipped.push({
        usr,
        userId: recipient?.userId ?? '',
        name: recipient ? recipient.fullName || recipient.username : usr,
        approvals: theirs.length,
        reason,
      });

    if (!recipient) {
      skip(SKIP_NO_ACCOUNT);
      continue;
    }
    if (!recipient.active) {
      skip(SKIP_INACTIVE);
      continue;
    }

    const message = approvalText(recipient, theirs, options.dashboardUrl);
    if (test) {
      // Nobody real is texted, so neither the opt-in nor their number matters:
      // this is how the texts get seen before anyone has ticked the box.
      send.push({
        recipient,
        to: options.testNumber,
        message: `[TEST for ${plainText(recipient.fullName || recipient.username)}] ${message}`,
        approvals: theirs.length,
        test: true,
      });
      continue;
    }

    if (!recipient.smsOptIn) {
      skip(SKIP_NO_OPT_IN);
      continue;
    }
    const to = toE164(recipient.mobile);
    if (!to) {
      skip(SKIP_BAD_NUMBER);
      continue;
    }
    send.push({ recipient, to, message, approvals: theirs.length, test: false });
  }

  return { send, skipped };
}
