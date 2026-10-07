import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApprovalPill } from '@/components/ApprovalPill';
import { ErrorPanel } from '@/components/ErrorPanel';
import { RevealSecret } from '@/components/onboarding/RevealSecret';
import { BypassSwitch } from '@/components/onboarding/BypassSwitch';
import { ReviewDecision } from '@/components/onboarding/ReviewDecision';
import { formatDateTime } from '@/lib/analytics';
import { isBypassed, NO_BYPASS, UNREVIEWED, type Approval, type Bypass } from '@/lib/approval';
import { maskAccount, maskTin } from '@/lib/mask';
import { firstMissingRequired, NOTHING_DONE, W9_CLASSIFICATIONS } from '@/lib/onboarding';
import { readAgreement, readBank, readProgress, readW9 } from '@/lib/onboarding-store';
import { toE164 } from '@/lib/phone';
import { smsConfigured, testNumber } from '@/lib/sms';
import { readSmsSettings, recentTexts } from '@/lib/sms-store';
import { RoleSelect } from '@/components/RoleSelect';
import { ServicesSelect } from '@/components/ServicesSelect';
import { personRole } from '@/lib/roles';
import { findUserById, isLgfEmployee, readUserServices, usersEnabled } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Onboarding record' };

/**
 * Everything one affiliate has handed over.
 *
 * Admin only. Four blocks in the order they were collected, each either the
 * record or a plain statement that it is not there yet — an empty section says
 * more than a missing one, because "no W-9" is the fact somebody came here for.
 *
 * The two sealed numbers are masked. Pressing Reveal is a separate request that
 * unseals exactly one of them, which is what keeps this page from being a list
 * of Social Security numbers that happens to be behind a login.
 */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAdmin();
  const { id } = await params;

  if (!usersEnabled()) {
    return (
      <ErrorPanel
        title="Accounts need a database"
        message="Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  const account = await findUserById(id);
  if (!account) notFound();

  const [progress, agreement, w9, bank, sms, texts] = await Promise.all([
    readProgress(id).catch(() => null),
    readAgreement(id).catch(() => null),
    readW9(id).catch(() => null),
    readBank(id).catch(() => null),
    readSmsSettings(id).catch(() => null),
    recentTexts(id).catch(() => null),
  ]);
  const lgfEmployee = account.role === 'affiliate' && (await isLgfEmployee(id).catch(() => false));
  // Null for an admin, who is not onboarded for anything.
  const services = account.role === 'affiliate' ? await readUserServices(id).catch(() => null) : null;
  const state = progress?.state ?? null;
  const approval = progress?.approval ?? { ...UNREVIEWED };
  const bypass = progress?.bypass ?? { ...NO_BYPASS };
  const paperworkComplete = state ? firstMissingRequired(state) === null : false;
  /* The read failed rather than came back empty. Those two produce the same
     defaults and mean opposite things, so the page says which one it is
     instead of asserting "not submitted" about somebody it could not look up. */
  const unknown = progress === null;

  const classification = W9_CLASSIFICATIONS.find((c) => c.key === w9?.classification);

  return (
    <div className="mx-auto w-full max-w-[1000px]">
      <div className="rise">
        <p className="label-cap">
          <Link href="/users" className="link-text">
            People
          </Link>
        </p>
        <h1 className="mt-1.5 font-display text-[26px] leading-[1.15]">
          {account.fullName || account.username}
        </h1>
        {account.role === 'affiliate' && !unknown ? (
          <p className="mt-2.5">
            <ApprovalPill approval={approval} bypass={bypass} />
          </p>
        ) : null}
        <p className="plain mt-2">
          <span className="tnum">{account.username}</span>
          {account.usr ? (
            <>
              {' · '}
              <span className="tnum">usr={account.usr}</span>
            </>
          ) : null}
          {account.email ? ` · ${account.email}` : ''}
        </p>
      </div>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">Role</h2>
        <div className="mt-3">
          <RoleSelect
            // Remounted when the saved role changes, so the dropdown starts
            // from what is on file after a save rather than what was picked.
            key={personRole(account.role, lgfEmployee)}
            userId={account.id}
            current={personRole(account.role, lgfEmployee)}
            lockedReason={
              account.id === viewer.id ? 'This is your account. Another admin can change your role.' : ''
            }
          />
        </div>
      </section>

      {services ? (
        <section className="panel mt-5 p-6 sm:p-7">
          <h2 className="text-[15px] font-semibold">Services</h2>
          <p className="plain mt-1.5">
            What this person is onboarded for. Tick Tradelines to add it for somebody already on
            Personal Cards.
          </p>
          <div className="mt-4">
            <ServicesSelect
              // Remounted when what is on file changes, so the boxes start
              // from the saved list after a save.
              key={services.join()}
              userId={account.id}
              current={services}
            />
          </div>
        </section>
      ) : null}

      {/* Step 1 */}
      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">Their details</h2>
        {state?.profile ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Name" value={account.fullName} />
            <Fact label="Email" value={account.email} />
            <Fact label="Position" value={account.position} />
            <Fact label="Mobile" value={account.mobile} mono />
          </div>
        ) : (
          <p className="plain mt-2">
            Not filled in yet. They have not signed in and set a password of their own.
          </p>
        )}
      </section>

      {account.role === 'affiliate' ? (
        <ApprovalTexts mobile={account.mobile} settings={sms} texts={texts} />
      ) : null}

      {/* Step 2 */}
      <section className="panel mt-5 p-6 sm:p-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="text-[15px] font-semibold">Affiliate agreement</h2>
          {agreement ? (
            <a
              href={`/api/onboarding/${encodeURIComponent(id)}/agreement.pdf`}
              className="btn-outline btn-sm"
            >
              Download PDF
            </a>
          ) : null}
        </div>

        {agreement ? (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Signed" value={formatDateTime(agreement.signedAt)} />
              <Fact label="Effective date" value={agreement.effectiveDate} mono />
              <Fact label="Name signed" value={agreement.affiliateName} />
              <Fact label="Version" value={agreement.agreementVersion} mono />
              <Fact label="Email on the agreement" value={agreement.affiliateEmail} />
              <Fact label="Address" value={agreement.affiliateAddress} />
            </div>
            <Signature png={agreement.signaturePng} />
            <Audit ip={agreement.signedIp} agent={agreement.signedUserAgent} />
          </>
        ) : (
          <p className="plain mt-2">
            {isBypassed(bypass)
              ? 'Waived for this account, so they are not being asked to sign it. They can still sign it themselves if they want it on file.'
              : 'Not signed yet.'}
          </p>
        )}
      </section>

      {/* Step 3 */}
      <section className="panel mt-5 p-6 sm:p-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="text-[15px] font-semibold">Form W-9</h2>
          {w9 ? (
            <a href={`/api/onboarding/${encodeURIComponent(id)}/w9.pdf`} className="btn-outline btn-sm">
              Download PDF
            </a>
          ) : null}
        </div>

        {w9 ? (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Filed" value={formatDateTime(w9.signedAt)} />
              <Fact label="Revision" value={w9.formRevision} />
              <Fact label="Line 1, name" value={w9.line1Name} />
              <Fact label="Line 2, business" value={w9.line2Business || 'None'} />
              <Fact
                label="Classification"
                value={
                  classification
                    ? classification.label +
                      (w9.llcCode ? ` (${w9.llcCode})` : '') +
                      (w9.otherText ? `: ${w9.otherText}` : '')
                    : w9.classification
                }
              />
              <Fact label="Address" value={w9.address} />
              <Fact label="City, state, ZIP" value={w9.cityStateZip} />
              <Fact label="Exempt / FATCA" value={[w9.exemptPayeeCode, w9.fatcaCode].filter(Boolean).join(' / ') || 'None'} mono />
              <div className="sm:col-span-2">
                {/* The one number on this page that is not on this page. */}
                <RevealSecret
                  userId={id}
                  what="tin"
                  masked={maskTin(w9.tinLast4, w9.tinType)}
                  label={w9.tinType === 'ssn' ? 'Social security number' : 'Employer identification number'}
                />
              </div>
              {w9.foreignPartners ? (
                <Fact label="Line 3b" value="Has foreign partners, owners or beneficiaries" />
              ) : null}
            </div>
            <Signature png={w9.signaturePng} />
            <Audit ip={w9.signedIp} agent={w9.signedUserAgent} />
          </>
        ) : (
          <p className="plain mt-2">
            {isBypassed(bypass)
              ? 'Waived for this account, so they are not being asked to file one. They can still file one themselves if they want it on record.'
              : 'Not filed yet. Nothing can be paid until it is.'}
          </p>
        )}
      </section>

      {account.role === 'affiliate' && !unknown ? (
        <section className="panel mt-5 p-6 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
            <h2 className="text-[15px] font-semibold">Bypass onboarding</h2>
            {isBypassed(bypass) ? (
              <span className="text-[12px] text-ink-dim">
                Waived {bypass.at ? formatDateTime(bypass.at) : ''}
                {bypass.by ? ` by ${bypass.by}` : ''}
              </span>
            ) : null}
          </div>
          <div className="mt-4">
            <BypassSwitch userId={id} bypass={bypass} state={state ?? NOTHING_DONE} />
          </div>
        </section>
      ) : null}

      {/* The decision. Last on the page on purpose: it comes after reading the
          four things above it, which is the order the job is actually done in. */}
      {account.role === 'affiliate' ? (
        <section className="panel mt-5 p-6 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
            <h2 className="text-[15px] font-semibold">Review this account</h2>
            {unknown ? null : <ApprovalPill approval={approval} bypass={bypass} />}
          </div>

          <p className="plain mt-1">{reviewBlurb(unknown, approval, bypass)}</p>

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="Submitted"
              value={approval.submittedAt ? formatDateTime(approval.submittedAt) : 'Not yet'}
            />
            <Fact
              label="Reviewed"
              value={approval.reviewedAt ? formatDateTime(approval.reviewedAt) : 'Not yet'}
            />
            <Fact label="Reviewed by" value={approval.reviewedBy || 'Nobody'} />
            <Fact
              label="Approval email"
              value={approval.emailedAt ? formatDateTime(approval.emailedAt) : 'Not sent'}
            />
          </dl>

          <div className="mt-6 border-t border-edge-faint pt-6">
            <ReviewDecision
              userId={id}
              approval={approval}
              hasEmail={Boolean(account.email)}
              paperworkComplete={paperworkComplete}
            />
          </div>
        </section>
      ) : null}

      {/* Step 4 */}
      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">Bank details</h2>
        {bank ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Fact label="Saved" value={formatDateTime(bank.savedAt)} />
            <Fact label="Name on the account" value={bank.accountName} />
            <Fact label="Bank" value={bank.bankName} />
            <Fact label="Routing number" value={bank.routingNumber || 'Not on file yet'} />
            <RevealSecret
              userId={id}
              what="account"
              masked={maskAccount(bank.accountLast4)}
              label="Account number"
            />
          </div>
        ) : (
          <p className="plain mt-2">Not on file. ACH cannot be sent without it.</p>
        )}
      </section>
    </div>
  );
}

/** One sentence for where this account stands, and what pressing a button
 *  below would do about it. */
function reviewBlurb(unknown: boolean, approval: Approval, bypass: Bypass): string {
  if (isBypassed(bypass)) {
    return 'Onboarding is waived for this account, so nothing here is blocking them. A decision is still worth recording for when the waiver comes off.';
  }
  if (unknown) {
    return 'Their onboarding record could not be read, so nothing below is known. If this project has not had its migrations applied yet, run: npx supabase db push';
  }
  if (approval.status === 'approved') return 'Approved. Their dashboard is open.';
  if (approval.status === 'declined') {
    return 'Declined. They can see the reason and can correct it, which puts them back in the queue.';
  }
  if (approval.submittedAt) {
    return 'Everything is in and waiting on you. Approving it opens their dashboard and emails them.';
  }
  return 'They have not finished their paperwork, so there is nothing to read yet.';
}

/**
 * Whether this affiliate is texted when their approvals land, and the last few
 * texts. null for either read means the texting migration has not been run.
 */
function ApprovalTexts({
  mobile,
  settings,
  texts,
}: {
  mobile: string;
  settings: Awaited<ReturnType<typeof readSmsSettings>> | null;
  texts: Awaited<ReturnType<typeof recentTexts>> | null;
}) {
  const number = toE164(mobile);
  const test = testNumber();
  return (
    <section className="panel mt-5 p-6 sm:p-7">
      <h2 className="text-[15px] font-semibold">Approval texts</h2>
      {!smsConfigured() ? (
        <p className="plain mt-2">
          Texting is off. Set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID to switch it on.
        </p>
      ) : null}
      {settings === null ? (
        <p className="plain mt-2">
          Could not read their text settings. If this is a new deploy, run: npx supabase db push
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="Opted in"
              value={settings.optInAt ? formatDateTime(settings.optInAt) : 'No, so they are not texted'}
            />
            <Fact
              label="Texted at"
              value={number || 'Their mobile number cannot be texted. Ask them to correct it.'}
              mono={Boolean(number)}
            />
            <Fact label="GoHighLevel contact" value={settings.ghlContactId || 'Found on the first text'} mono />
          </div>
          {test ? (
            <p className="plain-note mt-4">
              Test mode: every text goes to {test} instead, marked with who it was for.
            </p>
          ) : null}
          {texts && texts.length > 0 ? (
            <ul className="mt-5 grid gap-3">
              {texts.map((row) => (
                <li key={row.id} className="border-t border-edge-faint pt-3 text-[13px]">
                  <p className="text-ink-soft">
                    <span className="tnum">{formatDateTime(row.createdAt)}</span> ·{' '}
                    {row.status === 'sent' ? 'Sent' : row.status === 'skipped' ? 'Not sent' : 'Failed'}
                    {' · '}
                    {row.approvals} approval{row.approvals === 1 ? '' : 's'}
                    {row.detail ? ` · ${row.detail}` : ''}
                  </p>
                  {row.message ? <p className="plain mt-1 whitespace-pre-line">{row.message}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="plain mt-4">No approval texts yet.</p>
          )}
        </>
      )}
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <span className="field-label">{label}</span>
      <p className={`mt-1 break-words text-[13px] text-ink-soft ${mono ? 'tnum' : ''}`}>
        {value || 'Not given'}
      </p>
    </div>
  );
}

/* eslint-disable @next/next/no-img-element */
function Signature({ png }: { png: string }) {
  if (!png.startsWith('data:image/png;base64,')) return null;
  return (
    <div className="mt-5">
      <span className="field-label">Signature</span>
      {/* A data URL, so next/image would have nothing to optimise and would
          need the origin allow-listed for no gain. */}
      <img
        src={png}
        alt="The signature as drawn"
        className="mt-1.5 max-h-[90px] w-auto max-w-full rounded-[3px] border border-edge bg-panel p-2"
      />
    </div>
  );
}

/** Where the signature came from. Printed because it is the evidence. */
function Audit({ ip, agent }: { ip: string; agent: string }) {
  if (!ip && !agent) return null;
  return (
    <p className="mt-4 border-t border-edge-faint pt-3 text-[11px] text-ink-dim">
      Signed from <span className="tnum">{ip || 'an unrecorded address'}</span>
      {agent ? ` · ${agent}` : ''}
    </p>
  );
}
