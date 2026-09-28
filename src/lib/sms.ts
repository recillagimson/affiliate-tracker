import { configuredBaseUrl } from './config';
import { ghlConfigured, resolveContact, sendSms } from './ghl';
import { toE164 } from './phone';
import { planTexts, type ApprovalText, type PlannedText } from './sms-messages';
import {
  readRecipients,
  saveContactId,
  smsStoreEnabled,
  writeSmsLog,
  type SmsLogWrite,
} from './sms-store';

/**
 * Texting affiliates when their approvals land, through GoHighLevel.
 *
 * The rule Slack follows holds here too: **a text never fails an approval**.
 * The routes call this after the money is written, and nothing in here throws.
 * A text that did not go is logged, reported where there is somewhere to
 * report it, and otherwise left: an approval refused because GHL was slow is
 * money nobody recorded.
 *
 * Who gets what is lib/sms-messages.ts. This file is the fetching, sending and
 * logging around it.
 */

export type SmsReport = {
  /** False when GHL is not configured: nothing was attempted. */
  enabled: boolean;
  /** Affiliates texted. */
  sent: number;
  /** Affiliates not texted, and why. */
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
  /** True when every text went to SMS_TEST_NUMBER instead. */
  test: boolean;
};

const OFF: SmsReport = { enabled: false, sent: 0, skipped: [], failed: [], test: false };

export function smsConfigured(): boolean {
  return ghlConfigured() && smsStoreEnabled();
}

/** SMS_TEST_NUMBER, as E.164, or ''. A number that cannot be read is no test number. */
export function testNumber(): string {
  const raw = (process.env.SMS_TEST_NUMBER ?? '').trim();
  if (!raw) return '';
  const number = toE164(raw);
  if (!number) console.error('sms: SMS_TEST_NUMBER is set but is not a number that can be texted.');
  return number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'GoHighLevel did not accept the text.';
}

/**
 * The GHL contact to text. An affiliate's is remembered after the first text,
 * so later ones are one call rather than three. The test number's never is:
 * it is nobody's, and remembering it on an affiliate would text them later as
 * whoever the test number belongs to.
 */
async function contactFor(plan: PlannedText): Promise<string> {
  const { recipient } = plan;
  if (!plan.test && recipient.ghlContactId) return recipient.ghlContactId;

  const contact = await resolveContact(
    plan.test
      ? { fullName: 'Ledger SMS test', email: '', phone: plan.to }
      : { fullName: recipient.fullName, email: recipient.email, phone: plan.to },
  );
  if (!plan.test) {
    await saveContactId(recipient.userId, contact.id).catch((error) =>
      console.error('sms: could not remember the GHL contact:', describe(error)),
    );
  }
  return contact.id;
}

/**
 * Text the affiliates behind these approvals: one text each, however many of
 * the approvals are theirs. Call it once per event — once for a manual
 * approval, once for a whole sync — and never before the approvals are
 * written.
 */
export async function textApprovals(approvals: ApprovalText[]): Promise<SmsReport> {
  if (approvals.length === 0 || !smsConfigured()) return OFF;

  const test = testNumber();
  const report: SmsReport = { enabled: true, sent: 0, skipped: [], failed: [], test: Boolean(test) };
  const log: SmsLogWrite[] = [];

  try {
    const recipients = await readRecipients(approvals.map((approval) => approval.usr));
    const base = configuredBaseUrl();
    const plan = planTexts(approvals, recipients, {
      dashboardUrl: base ? `${base}/` : '',
      testNumber: test,
    });

    for (const skipped of plan.skipped) {
      report.skipped.push({ name: skipped.name, reason: skipped.reason });
      log.push({
        userId: skipped.userId,
        usr: skipped.usr,
        phone: '',
        status: 'skipped',
        approvals: skipped.approvals,
        message: '',
        detail: skipped.reason,
        ghlMessageId: '',
      });
    }

    // One after another: GHL allows 100 requests in 10 seconds, and a big sync
    // sent all at once is how that is found out.
    for (const text of plan.send) {
      const name = text.recipient.fullName || text.recipient.username;
      const entry: SmsLogWrite = {
        userId: text.recipient.userId,
        usr: text.recipient.usr,
        phone: text.to,
        status: 'sent',
        approvals: text.approvals,
        message: text.message,
        detail: text.test ? 'test: sent to SMS_TEST_NUMBER instead' : '',
        ghlMessageId: '',
      };
      try {
        const contactId = await contactFor(text);
        entry.ghlMessageId = await sendSms(contactId, text.message);
        report.sent += 1;
      } catch (error) {
        entry.status = 'failed';
        entry.detail = describe(error);
        report.failed.push({ name, reason: entry.detail });
        console.error(`sms: ${name}:`, entry.detail);
        // A remembered contact that GHL refuses may have been deleted or
        // merged there. Forgetting it means the next text looks it up afresh.
        if (!text.test && text.recipient.ghlContactId) {
          await saveContactId(text.recipient.userId, '').catch(() => undefined);
        }
      }
      log.push(entry);
    }
  } catch (error) {
    // Could not even read who to text: the migrations are behind, or the
    // database is down. Said once, rather than once per affiliate.
    const reason = describe(error);
    console.error('sms:', reason);
    report.failed.push({ name: 'Everyone', reason });
    return report;
  }

  await writeSmsLog(log).catch((error) => console.error('sms: could not write the log:', describe(error)));
  return report;
}

/** One line for a screen that has room for one: '' when there is nothing to say. */
export function smsSummary(report: SmsReport): string {
  if (!report.enabled) return '';
  const parts: string[] = [];
  if (report.sent > 0) {
    parts.push(
      `Texted ${report.sent} affiliate${report.sent === 1 ? '' : 's'}${report.test ? ' (to the test number)' : ''}.`,
    );
  }
  if (report.skipped.length > 0) {
    parts.push(`Not texted: ${report.skipped.map((row) => `${row.name} (${row.reason})`).join('; ')}.`);
  }
  if (report.failed.length > 0) {
    parts.push(`Failed: ${report.failed.map((row) => `${row.name} (${row.reason})`).join('; ')}.`);
  }
  return parts.join(' ');
}
