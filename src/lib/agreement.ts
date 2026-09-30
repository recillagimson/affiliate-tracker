/**
 * The affiliate agreement, as data.
 *
 * One copy of the wording, read by two things that must never disagree: the
 * page somebody signs and the PDF that comes out the other end. A second copy
 * would be a second copy that can drift, and the thing that drifts would be the
 * terms of a contract.
 *
 * Transcribed from "LaunchStone Affiliate Agreement.docx" verbatim, including
 * the section numbering and the summary table. AGREEMENT_VERSION changes
 * whenever a word of it does, and every signed row records the version it was
 * signed under — so a revision never silently reinterprets what somebody
 * already agreed to.
 *
 * Client-safe: no node imports, because the page that renders it runs in the
 * browser.
 */

/**
 * Bumped on any change to the text below. Stored on every signature, which is
 * what makes "which wording did they agree to" answerable a year later.
 *
 * A full date rather than a month, because the payment terms changed twice
 * within August 2026 and "2026-08" could no longer tell the two apart. Two
 * revisions on one day would need a letter after it.
 *
 * Bumping this is half the job. Whatever the old text said has to be written
 * into SUPERSEDED below at the same time, or every copy already signed under
 * the old version re-renders under the new one.
 */
export const AGREEMENT_VERSION = '2026-10-01';

/**
 * Net 15, as a number the payout screens can count in.
 *
 * The payment term is written into clause 4 and into the summary table below in
 * words, and a card can be requested that many days after its approval (see
 * lib/payout-request). Naming it once means
 * the wording somebody signed and the day they are actually paid cannot drift
 * apart: changing the term here changes both, and changing only the prose is
 * caught by the check that reads this number back out of the clause.
 */
export const PAYMENT_DAYS = 15;

/* ------------------------------------------------------------------------- */
/* The blanks the company owns                                               */
/* ------------------------------------------------------------------------- */

/**
 * Two things in this document are the company's to fill in, not the affiliate's:
 * the governing state in §12 and who signs for LaunchStone.
 *
 * They live here as constants rather than in the database because they are the
 * same on every copy — a settings table for two strings that change once a
 * decade would be a table nobody remembers exists. Editing this block is the
 * whole job.
 *
 * GOVERNING_STATE is deliberately left as the placeholder the .docx had. An
 * agreement that names no forum is weaker than one that does, and guessing a
 * state on somebody's behalf is worse than leaving the blank visible.
 */
export const COMPANY = {
  /* Named exactly as it is named on the paperwork, and nothing after it. The
     ", a limited liability company" that used to follow is what a contract
     drafter appends when the entity type is not otherwise stated; here it is
     already in the name, so it read as a stutter on every screen it appeared
     on. */
  name: 'LaunchStone LLC',
  /** TODO(owner): the State whose law governs, e.g. 'Delaware'. Renders as a
   *  visible blank until it is set. */
  governingState: '',
  /** TODO(owner): who countersigns for the company, and their title. */
  signatoryName: '',
  signatoryTitle: '',
} as const;

/** Whether §12 can be printed as a sentence rather than as a blank line. */
export function governingStateSet(): boolean {
  return COMPANY.governingState.trim().length > 0;
}

/* ------------------------------------------------------------------------- */
/* The summary table                                                         */
/* ------------------------------------------------------------------------- */

export const SUMMARY_INTRO =
  'The table below summarizes the key economic and confidentiality terms of this engagement. ' +
  'Full legal terms appear in the numbered sections below.';

export const SUMMARY: { term: string; details: string }[] = [
  {
    term: 'Payout Rate',
    details:
      'A flat amount per approved referral, as set forth in Company’s payout schedule provided to ' +
      'Affiliate separately. Company may update the payout schedule from time to time on notice to Affiliate.',
  },
  {
    term: 'Payment Terms',
    details:
      'Net 15 — paid 15 calendar days after the referral is approved, by ACH, contingent on a signed ' +
      'W-9 and valid banking information on file.',
  },
  {
    term: 'Confidentiality',
    details:
      'Strict. Covers the tracking/ID system, ledgers, payout data, tier rates, and the existence of ' +
      'this Agreement itself. Survives termination indefinitely.',
  },
  {
    term: 'Link Exclusivity',
    details:
      'Affiliate may not create or use any link other than the one issued by Company. The Link may not ' +
      'be posted publicly anywhere (Instagram, YouTube, or any other social media) or used in any paid ' +
      'ad, with the sole exception of posting within the Company-approved, paywalled Skool community. ' +
      'Violation = automatic suspension.',
  },
];

export const PREAMBLE =
  'This Agreement is entered into as of the Effective Date set forth above by and between ' +
  'LaunchStone LLC (the "Company") and the Affiliate named above (the "Affiliate"). Company and ' +
  'Affiliate are each a "Party" and together the "Parties."';

/* ------------------------------------------------------------------------- */
/* The numbered sections                                                     */
/* ------------------------------------------------------------------------- */

export type Clause = {
  n: number;
  title: string;
  /** One entry per paragraph in the source document. */
  paras: string[];
};

export const CLAUSES: Clause[] = [
  {
    n: 1,
    title: 'Relationship With Company Only',
    paras: [
      'Affiliate’s sole contractual relationship under this Agreement is with Company. This Agreement does not create any contract, agency, partnership, joint venture, or employment relationship between Affiliate and any affiliated, related, or associated business, brand, or individual outside of Company, including without limitation "LetsGetFunded" and its owners, members, employees, or representatives (collectively, "Third-Party Affiliates"). Affiliate agrees it has no claim of any kind against any Third-Party Affiliate arising out of this Agreement or Affiliate’s activities hereunder, and waives and releases any such claim to the fullest extent permitted by law.',
    ],
  },
  {
    n: 2,
    title: 'Independent Contractor Status',
    paras: [
      'Affiliate is an independent contractor, not an employee, agent, partner, or joint venturer of Company or any Third-Party Affiliate. Affiliate is solely responsible for all applicable taxes on amounts paid under this Agreement and will provide Company a completed and signed IRS Form W-9 and valid banking/ACH information before any compensation is owed or paid. Company will issue Form 1099 reporting as required by law.',
    ],
  },
  {
    n: 3,
    title: 'Scope of Services',
    paras: [
      'Company will provide Affiliate a unique, Company-issued tracking link (the "Link") for referring prospective clients to personal financial/credit card offers made available through Company’s platform. Affiliate may distribute the Link to prospective clients and, upon a qualifying approval, will be compensated as set out in Section 4.',
    ],
  },
  {
    n: 4,
    title: 'Compensation',
    paras: [
      'Affiliate will be paid a flat amount per approved referral, as set forth in Company’s payout schedule provided to Affiliate separately. Company may update the payout schedule from time to time on notice to Affiliate.',
      'Payment terms are net fifteen (15) days ("Net 15"), meaning payment is due fifteen (15) calendar days after the referral is approved by the applicable card issuer/program, subject to Company’s receipt of its own payment from its upstream partner.',
      'All payments will be made by ACH to the bank account Affiliate provides in writing. Company is not obligated to pay by any other method.',
      'Company may withhold, offset, or reverse any payment associated with a referral that is later reversed, charged back, found fraudulent, or found to violate this Agreement or any card issuer/program terms.',
      'No compensation is owed for referrals submitted through any link, method, or channel other than the Link issued directly by Company to Affiliate.',
    ],
  },
  {
    n: 5,
    title: 'Confidentiality',
    paras: [
      'In connection with this Agreement, Affiliate will have access to confidential and proprietary information of Company and its business partners, including but not limited to: the existence and structure of Company’s tracking/ID system, referral and approval data, ledgers and payout reports, compensation and tier rates, the identities of Company’s upstream partners and program relationships, client and applicant information, business plans, and the terms of this Agreement (collectively, "Confidential Information").',
      'Affiliate will hold all Confidential Information in strict confidence and will not disclose, publish, post, or share it with any person or entity, in any form, without Company’s prior written consent.',
      'Affiliate will use Confidential Information solely to perform under this Agreement, and for no other purpose.',
      'Affiliate will not disclose the existence, structure, or terms of this Agreement or the affiliate program itself to any third party, including other affiliates, clients, or the public.',
      'This confidentiality obligation survives termination of this Agreement indefinitely and applies regardless of how or why the Agreement ends.',
      'Upon Company’s request or termination of this Agreement, Affiliate will immediately return or destroy all Confidential Information and certify such destruction in writing.',
    ],
  },
  {
    n: 6,
    title: 'No Independent or Additional Links; Non-Circumvention',
    paras: [
      'Affiliate will not create, generate, request, distribute, or use any tracking link, referral code, or similar mechanism for the offers covered by this Agreement other than the single Link issued to Affiliate directly by Company.',
      'Affiliate will not post, publish, or share the Link anywhere publicly, on any platform, for any reason — including but not limited to YouTube, Instagram, TikTok, Facebook, X/Twitter, personal or business websites, forums, or any other social media or public channel, whether now existing or later created. The sole exception is posting the Link within the Company-designated, paywalled Skool community.',
      'Affiliate will not run, place, or facilitate any paid advertisement or promotion of any kind (including social media ads, search ads, influencer placements, or any other paid traffic) using or referencing the Link, under any circumstances, including within Skool.',
      'Outside of the Skool exception above, the Link may only be shared privately and directly with prospective clients, consistent with the confidentiality obligations in Section 5.',
      'Affiliate will not recruit, appoint, authorize, or enable any other person or entity to act as a referral source of Affiliate’s own, whether for compensation or not.',
      'Affiliate will not contact, apply to, or enter into any direct or indirect relationship with Company’s upstream partners, card issuers, programs, or networks in a manner that bypasses Company, during the term of this Agreement and for twelve (12) months after termination.',
      'Any violation of this Section — including any public posting or paid promotion of the Link — results in the automatic and immediate suspension of Affiliate’s account, is a material breach entitling Company to immediate termination, forfeiture of unpaid compensation related to the violation, and pursuit of all available remedies.',
    ],
  },
  {
    n: 7,
    title: 'Compliance and Representations',
    paras: [
      'Affiliate will comply with all applicable laws and regulations, including those governing lending, financial promotions, data privacy, and consumer protection, and with all applicable card issuer/program terms and conditions.',
      'Affiliate will not make false, misleading, or unauthorized representations to prospective clients about the offers, Company, or any Third-Party Affiliate, and will only use marketing materials approved in advance by Company.',
      'Affiliate will obtain any consent required from prospective clients before submitting their personal information and will handle all client personal information in compliance with applicable privacy laws.',
    ],
  },
  {
    n: 8,
    title: 'Ownership',
    paras: [
      'All tracking systems, dashboards, ledgers, reports, links, and related technology and data are and remain the sole property of Company. This Agreement grants Affiliate no ownership or license rights in any of the foregoing beyond the limited right to use the Link as permitted herein.',
    ],
  },
  {
    n: 9,
    title: 'Indemnification',
    paras: [
      'Affiliate will indemnify, defend, and hold harmless Company, its members, and all Third-Party Affiliates (including LetsGetFunded and its owners, employees, and representatives) from and against any and all claims, losses, damages, liabilities, and expenses (including reasonable attorneys’ fees) arising out of or relating to: (a) Affiliate’s breach of this Agreement; (b) Affiliate’s violation of any law or third-party right; or (c) any representation Affiliate makes to a prospective client that is not authorized by Company.',
    ],
  },
  {
    n: 10,
    title: 'No Guarantee; Limitation of Liability',
    paras: [
      'Company makes no guarantee regarding the volume of referrals, approvals, or compensation Affiliate may earn. To the fullest extent permitted by law, Company’s total liability under this Agreement will not exceed the total compensation actually paid to Affiliate in the three (3) months preceding the claim, and Company will not be liable for indirect, incidental, or consequential damages.',
    ],
  },
  {
    n: 11,
    title: 'Term and Termination',
    paras: [
      'This Agreement begins on the Effective Date and continues until terminated by either Party with written notice. Company may terminate immediately for any breach of Sections 5, 6, or 7. Sections 5 (Confidentiality), 6 (Non-Circumvention, for the period stated), 8 (Ownership), 9 (Indemnification), and 10 (Limitation of Liability) survive termination.',
    ],
  },
  {
    n: 12,
    title: 'General',
    // Written as two halves so the governing state can sit between them as a
    // filled value or as a visible blank, without the sentence being rebuilt
    // by string surgery at three call sites.
    paras: [
      'This Agreement is governed by the laws of the State of {{STATE}}, without regard to conflict-of-law principles, and any dispute will be resolved exclusively in the state or federal courts located in that state. This is the entire agreement between the Parties on this subject and supersedes all prior discussions. It may only be amended in writing signed by both Parties. Affiliate may not assign this Agreement. If any provision is found unenforceable, the remainder remains in full force. This Agreement may be signed electronically and in counterparts.',
    ],
  },
];

/* ------------------------------------------------------------------------- */
/* What the earlier versions said                                            */
/* ------------------------------------------------------------------------- */

/**
 * Wording that has been replaced, kept under the version it was replaced from.
 *
 * A signed row records which version somebody agreed to, and nothing else: the
 * text itself is read from this file every time a copy is drawn. So without
 * this archive, revising a sentence would silently redraw every agreement ever
 * signed under today's wording while still stamping it with the version of the
 * one they actually signed. That is not a formatting problem. It is showing
 * somebody a contract they never agreed to, over their own signature.
 *
 * Only the paragraphs that changed are kept. A second full copy of a document
 * that differs in two sentences is a copy nobody can diff, and what the next
 * reader needs to see is what moved.
 *
 * scripts/agreement-checks.ts holds every entry here to a paragraph that still
 * exists and to text that still differs from the current wording, so a later
 * edit that renumbers a clause fails loudly rather than archiving nothing.
 */
export type Revision = {
  version: string;
  /** What changed, for somebody reading this file rather than the diff. */
  note: string;
  /** Summary rows this version worded differently, keyed by term. */
  summary: Record<string, string>;
  /** Clause paragraphs it worded differently, by clause number and position. */
  paras: { clause: number; at: number; text: string }[];
};

export const SUPERSEDED: Revision[] = [
  {
    version: '2026-08-27',
    note: 'Payment was Net 45 from 27 August until 1 October 2026.',
    summary: {
      'Payment Terms':
        'Net 45 — paid 45 calendar days after the referral is approved, by ACH, contingent on a signed ' +
        'W-9 and valid banking information on file.',
    },
    paras: [
      {
        clause: 4,
        at: 1,
        text: 'Payment terms are net forty-five (45) days ("Net 45"), meaning payment is due forty-five (45) calendar days after the referral is approved by the applicable card issuer/program, subject to Company’s receipt of its own payment from its upstream partner.',
      },
    ],
  },
  {
    version: '2026-08',
    note: 'Payment was Net 30 until 27 August 2026.',
    summary: {
      'Payment Terms':
        'Net 30 — paid 30 calendar days after the referral is approved, by ACH, contingent on a signed ' +
        'W-9 and valid banking information on file.',
    },
    paras: [
      {
        clause: 4,
        at: 1,
        text: 'Payment terms are net thirty (30) days ("Net 30"), meaning payment is due thirty (30) calendar days after the referral is approved by the applicable card issuer/program, subject to Company’s receipt of its own payment from its upstream partner.',
      },
    ],
  },
];

function revisionFor(version: string): Revision | null {
  if (!version || version === AGREEMENT_VERSION) return null;
  return SUPERSEDED.find((entry) => entry.version === version) ?? null;
}

/**
 * Whether the exact wording of a signed version is still on file.
 *
 * False for a version this file has never heard of, which is what a row from a
 * future revision looks like to an older deployment. The copy is still drawn,
 * because refusing to produce somebody's own signed agreement is worse, but it
 * says on its face that the text is today's rather than theirs.
 */
export function wordingKnown(version: string): boolean {
  return version === AGREEMENT_VERSION || revisionFor(version) !== null;
}

/** The summary table as one version worded it. */
export function summaryFor(version: string = AGREEMENT_VERSION): { term: string; details: string }[] {
  const revision = revisionFor(version);
  if (!revision) return SUMMARY;
  return SUMMARY.map((row) => {
    const was = revision.summary[row.term];
    return was ? { ...row, details: was } : row;
  });
}

/** The numbered sections as one version worded them. */
export function clausesFor(version: string = AGREEMENT_VERSION): Clause[] {
  const revision = revisionFor(version);
  if (!revision) return CLAUSES;
  return CLAUSES.map((clause) => {
    const changed = revision.paras.filter((entry) => entry.clause === clause.n);
    if (changed.length === 0) return clause;
    const paras = [...clause.paras];
    for (const entry of changed) {
      if (entry.at >= 0 && entry.at < paras.length) paras[entry.at] = entry.text;
    }
    return { ...clause, paras };
  });
}

/** The governing-state placeholder filled in, or left as a rule to write on. */
export function clauseText(paragraph: string): string {
  if (!paragraph.includes('{{STATE}}')) return paragraph;
  return paragraph.replace('{{STATE}}', COMPANY.governingState.trim() || '____________________');
}

/** Every paragraph of the agreement, in order, with placeholders resolved.
 *  Used by the PDF, which has no notion of clauses — only lines.
 *
 *  Takes a version so that a copy of somebody's signed agreement is drawn from
 *  the wording they signed rather than from whatever the file says today. */
export function allParagraphs(
  version: string = AGREEMENT_VERSION,
): { heading: string | null; text: string }[] {
  const out: { heading: string | null; text: string }[] = [];
  out.push({ heading: null, text: PREAMBLE });
  for (const clause of clausesFor(version)) {
    out.push({ heading: `${clause.n}. ${clause.title}`, text: '' });
    for (const para of clause.paras) out.push({ heading: null, text: clauseText(para) });
  }
  return out;
}
