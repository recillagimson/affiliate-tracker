/**
 * What a new affiliate has to hand over, in what order, and what stops them.
 *
 * Pure: no database, no request, no React. Everything here is a decision that
 * can be wrong in a way a type check will not catch — which step comes next,
 * whether the app is barred, whether a W-9 is complete enough to sign — so it
 * lives apart from the pages and is checked directly in scripts/.
 *
 * Client-safe on purpose. The step list and the field rules are both needed in
 * the browser (to draw the progress bar, to refuse a submit before it is sent)
 * and on the server (because the browser is not a place to enforce anything).
 */

import { addressProblems, type Address } from './address';
import { digitsOf, validTin } from './mask';

export type StepKey = 'profile' | 'agreement' | 'w9' | 'bank';

export type Step = {
  key: StepKey;
  path: string;
  label: string;
  /** The one line that says what this step is for. */
  blurb: string;
  /**
   * Whether the app is barred until it is done.
   *
   * The first three are. §2 of the agreement says no compensation is owed
   * before a signed W-9 and valid banking information are on file, so an
   * affiliate working without the paperwork is an affiliate generating a
   * payment nobody can make.
   *
   * Bank details are the exception, and deliberately: they are the one step
   * somebody might genuinely not have to hand — a new account, a shared
   * business account, a bank that has to be phoned. Net 15 means there are two
   * weeks of slack, so this one nags instead of blocking.
   */
  required: boolean;
};

export const STEPS: Step[] = [
  {
    key: 'profile',
    path: '/welcome',
    label: 'Your details',
    blurb: 'Who you are, how to reach you, and a password of your own.',
    required: true,
  },
  {
    key: 'agreement',
    path: '/welcome/agreement',
    label: 'Affiliate agreement',
    blurb: 'The terms of the engagement, signed.',
    required: true,
  },
  {
    key: 'w9',
    path: '/welcome/w9',
    label: 'Form W-9',
    blurb: 'What the IRS needs before anyone can be paid.',
    required: true,
  },
  {
    key: 'bank',
    path: '/welcome/bank',
    label: 'Bank details',
    blurb: 'Where the ACH payment goes.',
    required: false,
  },
];

export const STEP_KEYS = STEPS.map((step) => step.key);

/**
 * The two steps that end in a signature, and the two a waiver removes.
 *
 * An admin who waives onboarding is nearly always an admin who has the
 * agreement signed on paper and the W-9 sitting in an email. Asking for both
 * again, inside an app the person has already been let into, collects nothing
 * but a second copy of something that is already filed. What that admin still
 * wants is the other two: who this person is, and where the money goes.
 */
export const SIGNED_STEPS: StepKey[] = ['agreement', 'w9'];

export function isSignedStep(key: StepKey): boolean {
  return SIGNED_STEPS.includes(key);
}

/**
 * The steps that still apply to somebody.
 *
 * Everything that counts, orders or offers a step runs through this, so a
 * waived account is never told it is "1 of 4" done on a list where two of the
 * four are never coming.
 */
export function stepsFor(options: { bypassed?: boolean } = {}): Step[] {
  return options.bypassed ? STEPS.filter((step) => !isSignedStep(step.key)) : STEPS;
}

/** The steps a waiver stops requiring. Pages ask for them so they can say so
 *  plainly, rather than quietly dropping two items somebody was expecting.
 *  Still openable, and still fillable: see canOpen. What a waiver removes is
 *  the obligation, not the form. */
export function waivedSteps(options: { bypassed?: boolean } = {}): Step[] {
  return options.bypassed ? STEPS.filter((step) => isSignedStep(step.key)) : [];
}

/** Where somebody whose gate was waived keeps their own paperwork. Named here
 *  because gateFor has to be able to send them back to it. */
export const WAIVED_HOME = '/profile';

/**
 * Whether a signed document has been settled and can no longer be replaced.
 *
 * Only the two that carry a signature, only once they exist, and only once
 * somebody has acted on them: approving an account, or waiving the gate to let
 * the person in, are both decisions taken by reading what was filed. A document
 * that can still be swapped out afterwards makes that decision meaningless,
 * because what was approved and what is on file need never be the same thing
 * again.
 *
 * Which is why a decision settles a document by *when* it arrived rather than
 * by it existing at all. A waived account may still fill either of these in,
 * and one filed after the decision was not read by anybody before it was taken,
 * so it is not part of the record that decision rests on. It settles at the
 * next one: filing anything that completes the set puts the account back in
 * front of an admin.
 *
 * It is not a permanent state and is not meant to read as one. An admin who
 * puts an account back in the review queue unlocks both documents, which is
 * how a genuine correction is made: somebody decides it is warranted.
 *
 * Locked is not closed. The page still opens, the record still shows, the PDF
 * still downloads. What stops is overwriting.
 */
export function isLocked(
  key: StepKey,
  state: OnboardingState,
  options: {
    approved?: boolean;
    /** When the account was reviewed. Absent is treated as "before this
     *  document", which keeps an older caller's behaviour. */
    reviewedAt?: string | null;
    bypassedAt?: string | null;
    signedAt?: string | null;
  } = {},
): boolean {
  if (!isSignedStep(key)) return false;
  if (!state[key]) return false;

  /*
   * The two decisions that can rest on this document, each settling what was on
   * file at the moment it was taken.
   *
   * Neither can settle a document filed afterwards, because there was nothing
   * to read. That case used not to exist: an approval came after the signing,
   * and a waived account could not file anything at all. It exists now, and
   * locking a document the instant it saved would mean a mistyped name needed
   * an admin on a form nobody had asked for.
   *
   * A resubmission puts the account back in the queue, so a document filed
   * after a decision settles at the next one.
   */
  const decisions: (string | null | undefined)[] = [];
  if (options.approved) decisions.push(options.reviewedAt);
  if (options.bypassedAt) decisions.push(options.bypassedAt);
  if (decisions.length === 0) return false;

  const filed = instant(options.signedAt);
  return decisions.some((taken) => {
    const at = instant(taken);
    // A decision with no readable date, or a document with none: assume the
    // document was there. That is the direction that protects the record.
    if (at === null || filed === null) return true;
    return filed <= at;
  });
}

/**
 * A timestamp as a number, or null when there is nothing readable to compare.
 *
 * Parsed rather than string-compared: these arrive from different places and
 * one of them writes "2026-08-24 12:00:00.308994+00" where the other writes an
 * ISO string, and those two sort against each other in the wrong order.
 *
 * Normalised before parsing rather than trusting the engine with the first
 * form. V8 happens to read it, but anything other than an ISO string is
 * implementation-defined, and the failure here would be silent and one-way:
 * an unreadable date is treated as a decision this document predates, so every
 * signed document would quietly lock.
 */
function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value
    .trim()
    .replace(' ', 'T')
    // A bare "+00" is an offset Postgres writes and ISO 8601 does not.
    .replace(/([+-]\d{2})$/, '$1:00');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "Step 2 of 4", counted over the steps that apply to this person. */
export function stepPosition(
  key: StepKey,
  options: { bypassed?: boolean } = {},
): { index: number; total: number } {
  const steps = stepsFor(options);
  return { index: steps.findIndex((step) => step.key === key) + 1, total: steps.length };
}

/** What has been done. Every field is simply "is there a row for this". */
export type OnboardingState = Record<StepKey, boolean>;

export const NOTHING_DONE: OnboardingState = {
  profile: false,
  agreement: false,
  w9: false,
  bank: false,
};

export function stepByKey(key: StepKey): Step {
  const found = STEPS.find((step) => step.key === key);
  if (!found) throw new Error(`Unknown onboarding step: ${key}`);
  return found;
}

/** The first thing left to do, or null when there is nothing. */
export function nextStep(
  state: OnboardingState,
  options: { bypassed?: boolean } = {},
): Step | null {
  return stepsFor(options).find((step) => !state[step.key]) ?? null;
}

/**
 * The step before this one.
 *
 * What Back is wired to. The flow is a queue of forms, and the only way to
 * check what went into the last one used to be to finish all four and go
 * looking on the dashboard — so a step that has been done now stays open, and
 * this is how you get back to it.
 */
export function previousStep(
  key: StepKey,
  options: { bypassed?: boolean } = {},
): Step | null {
  const steps = stepsFor(options);
  const index = steps.findIndex((step) => step.key === key);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

/** The first *required* thing left to do. This is what bars the app. */
export function firstMissingRequired(
  state: OnboardingState,
  options: { bypassed?: boolean } = {},
): Step | null {
  return stepsFor(options).find((step) => step.required && !state[step.key]) ?? null;
}

/** Whether the app is barred to this person right now. */
export function isBlocked(state: OnboardingState): boolean {
  return firstMissingRequired(state) !== null;
}

/** Everything, including the step that only nags. */
export function isComplete(state: OnboardingState, options: { bypassed?: boolean } = {}): boolean {
  return stepsFor(options).every((step) => state[step.key]);
}

/** For the progress bar: how far through, counting every step. */
export function progressOf(
  state: OnboardingState,
  options: { bypassed?: boolean } = {},
): { done: number; total: number } {
  const steps = stepsFor(options);
  return {
    done: steps.filter((step) => state[step.key]).length,
    total: steps.length,
  };
}

/**
 * A step you have not earned yet cannot be opened.
 *
 * Not for security — the routes check their own preconditions — but because
 * signing an agreement before you have set a password means signing it as an
 * account somebody else was handed the keys to. The order is the point.
 *
 * `bypassed` changes what the question even is. A waiver shortens what is
 * *required*, not what is available: the agreement and the W-9 stop being
 * things anybody is waiting on, and stop appearing in the queue and the count.
 * They do not stop being things this person may want to fill in.
 *
 * So a waived account can open all four, in whatever order it likes. It used to
 * be refused the two documents unless it had already signed them, which made
 * the waiver read as a door locked from the outside: somebody who wanted their
 * agreement on file had no way to put it there, and nothing in the app said why
 * beyond "there is nothing here for you to sign". Not required and not
 * permitted are different things, and only the first one was ever meant.
 */
export function canOpen(
  state: OnboardingState,
  key: StepKey,
  options: { bypassed?: boolean } = {},
): boolean {
  if (options.bypassed) return true;
  const index = STEP_KEYS.indexOf(key);
  if (index <= 0) return true;
  // Every earlier step done, or this is the one they are already on.
  return STEP_KEYS.slice(0, index).every((earlier) => state[earlier]);
}

/**
 * Where a request should be sent, or null to let it through.
 *
 * `pathname` is the page being asked for. The welcome pages themselves are
 * never redirected away from — that is the loop this exists to avoid.
 *
 * A finished step used to be bounced forward, on the reasoning that nobody
 * should sign the same document twice. That reasoning was about the *submit*
 * and it was applied to the *page*, which left no way to go back and look at
 * what had been put in — including on the step that is only a name, an email
 * and a phone number. Order is still enforced going forwards. Going backwards
 * is now allowed, and each page says plainly what re-submitting it would do.
 */
export function gateFor(
  pathname: string,
  state: OnboardingState,
  options: { bypassed?: boolean } = {},
): string | null {
  const onWelcome = pathname === '/welcome' || pathname.startsWith('/welcome/');

  if (onWelcome) {
    const step = STEPS.find((candidate) => candidate.path === pathname);
    // An unknown /welcome/* path, or one whose earlier steps are unfinished:
    // send them to the earliest thing they can actually do.
    if (!step || !canOpen(state, step.key, options)) {
      // A waived account has no next step to be marched to. What is left of
      // their paperwork is a list, and the list lives on their profile.
      if (options.bypassed) return WAIVED_HOME;
      return (nextStep(state) ?? STEPS[0]!).path;
    }
    return null;
  }

  // Waived: nothing here bars any page. They still have the forms, reachable
  // from their profile, and can work through whichever ones they need.
  if (options.bypassed) return null;

  const missing = firstMissingRequired(state);
  return missing ? missing.path : null;
}

/* --------------------------------------------------------- what a step needs */

export type ProfileInput = {
  fullName: string;
  email: string;
  position: string;
  mobile: string;
  /** Agreed to approval texts. Optional: nothing about step 1 requires it. */
  smsOptIn?: boolean;
  password: string;
  confirmPassword: string;
};

/** Loose on purpose: the point is that it can receive mail, not that it obeys
 *  RFC 5322. Anything stricter rejects real addresses. */
export function looksLikeEmail(value: string): boolean {
  const tidy = (value ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(tidy);
}

/** Seven digits is the shortest real phone number anywhere; the upper bound is
 *  E.164's fifteen. Punctuation and a leading + are formatting. */
export function looksLikePhone(value: string): boolean {
  const digits = digitsOf(value);
  return digits.length >= 7 && digits.length <= 15;
}

export const MIN_PASSWORD = 12;

/**
 * `passwordSet` is true when they have already chosen one — which is to say,
 * when this is a second visit to step 1 rather than the first.
 *
 * On that second visit, both password fields being empty means "leave it
 * alone", not "set an empty password". Without that, coming back to correct a
 * typo in a phone number would force a password change, and forcing a password
 * change to fix a phone number is how people end up with a password they cannot
 * remember.
 */
export function profileProblems(
  input: ProfileInput,
  options: { passwordSet?: boolean } = {},
): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!input.fullName?.trim()) problems.fullName = 'Tell us your name.';
  if (!looksLikeEmail(input.email ?? '')) problems.email = 'That does not look like an email address.';
  if (!input.position?.trim()) problems.position = 'What is your role?';
  if (!looksLikePhone(input.mobile ?? '')) problems.mobile = 'A mobile number, including the area code.';

  if (keepsPassword(input, options)) return problems;

  const password = input.password ?? '';
  if (password.length < MIN_PASSWORD) {
    problems.password = `At least ${MIN_PASSWORD} characters. Long beats complicated.`;
  } else if (password !== input.confirmPassword) {
    problems.confirmPassword = 'The two passwords are not the same.';
  }
  return problems;
}

/** Whether this submission is asking for the password to be left as it is. */
export function keepsPassword(
  input: ProfileInput,
  options: { passwordSet?: boolean } = {},
): boolean {
  return Boolean(options.passwordSet) && !(input.password ?? '') && !(input.confirmPassword ?? '');
}

export type AgreementInput = {
  affiliateName: string;
  affiliateEmail: string;
  /* Asked for in parts, so that a state is picked from a list rather than
     spelled, and the W-9 after it can fill its own two address lines without
     guessing where one ends. */
  address: Address;
  effectiveDate: string;
  signaturePng: string;
  affirmed: boolean;
};

/** A blank signature pad still produces a PNG, so length is what tells an
 *  actual signature from an untouched canvas. */
export const MIN_SIGNATURE_CHARS = 800;

export function looksSigned(signaturePng: string): boolean {
  const value = signaturePng ?? '';
  return value.startsWith('data:image/png;base64,') && value.length >= MIN_SIGNATURE_CHARS;
}

export function agreementProblems(input: AgreementInput): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!input.affiliateName?.trim()) problems.affiliateName = 'Your full legal name.';
  if (!looksLikeEmail(input.affiliateEmail ?? '')) problems.affiliateEmail = 'An email address.';
  Object.assign(problems, addressProblems(input.address));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate ?? '')) {
    problems.effectiveDate = 'Pick a date.';
  }
  if (!looksSigned(input.signaturePng ?? '')) problems.signaturePng = 'Sign in the box.';
  if (!input.affirmed) problems.affirmed = 'Tick the box to sign.';
  return problems;
}

export type W9Classification =
  | 'individual'
  | 'c_corp'
  | 's_corp'
  | 'partnership'
  | 'trust_estate'
  | 'llc'
  | 'other';

/** The seven boxes on line 3a, in the order the form prints them. */
export const W9_CLASSIFICATIONS: { key: W9Classification; label: string }[] = [
  { key: 'individual', label: 'Individual/sole proprietor' },
  { key: 'c_corp', label: 'C corporation' },
  { key: 's_corp', label: 'S corporation' },
  { key: 'partnership', label: 'Partnership' },
  { key: 'trust_estate', label: 'Trust/estate' },
  { key: 'llc', label: 'LLC' },
  { key: 'other', label: 'Other (see instructions)' },
];

/** Line 3b only applies to these three, per the form's own wording. */
export function needsForeignPartnersQuestion(
  classification: W9Classification,
  llcCode: string,
): boolean {
  if (classification === 'partnership' || classification === 'trust_estate') return true;
  return classification === 'llc' && llcCode === 'P';
}

export type W9Input = {
  line1Name: string;
  line2Business: string;
  classification: W9Classification | '';
  llcCode: string;
  otherText: string;
  foreignPartners: boolean;
  exemptPayeeCode: string;
  fatcaCode: string;
  address: string;
  cityStateZip: string;
  accountNumbers: string;
  tinType: 'ssn' | 'ein' | '';
  tin: string;
  signaturePng: string;
  certified: boolean;
};

/**
 * `tinOnFile` is the kind of number already sealed away for this person, or
 * null when there is none.
 *
 * Nothing can read that number back to prefill it — that is the point of
 * sealing it — so on a return visit the field is empty, and an empty field
 * must not mean "erase it". It means keep it, but only while the *kind* still
 * matches: switching SSN to EIN and saving would otherwise leave nine digits
 * filed under the wrong sort of number.
 */
export function w9Problems(
  input: W9Input,
  options: { tinOnFile?: 'ssn' | 'ein' | null } = {},
): Record<string, string> {
  const problems: Record<string, string> = {};

  // The form says it in as many words: "An entry is required."
  if (!input.line1Name?.trim()) problems.line1Name = 'Line 1 is required.';

  if (!input.classification) {
    problems.classification = 'Check one box on line 3a.';
  } else if (input.classification === 'llc' && !['C', 'S', 'P'].includes(input.llcCode ?? '')) {
    problems.llcCode = 'Enter C, S or P for the LLC’s tax classification.';
  } else if (input.classification === 'other' && !input.otherText?.trim()) {
    problems.otherText = 'Say what it is.';
  }

  if (!input.address?.trim()) problems.address = 'Line 5 is required.';
  if (!input.cityStateZip?.trim()) problems.cityStateZip = 'Line 6 is required.';

  if (!input.tinType) {
    problems.tinType = 'An SSN or an EIN, whichever applies.';
  } else if (keepsTin(input, options)) {
    // Left empty on purpose, with the same kind of number already on file.
  } else if (!validTin(input.tin ?? '')) {
    problems.tin = `A ${input.tinType === 'ssn' ? 'Social Security number' : 'an employer identification number'} is nine digits.`;
  }

  if (!looksSigned(input.signaturePng ?? '')) problems.signaturePng = 'Sign in the box.';
  // Part II is signed under penalties of perjury. Nothing goes in the table
  // without it, and the database says so too.
  if (!input.certified) problems.certified = 'Tick the certification to sign.';

  return problems;
}

/** Whether this submission is asking for the stored taxpayer number to stand. */
export function keepsTin(
  input: W9Input,
  options: { tinOnFile?: 'ssn' | 'ein' | null } = {},
): boolean {
  if (!options.tinOnFile) return false;
  if (digitsOf(input.tin ?? '').length > 0) return false;
  return input.tinType === options.tinOnFile;
}

export type BankInput = {
  accountName: string;
  bankName: string;
  accountNumber: string;
};

/** `accountOnFile` says an account number is already sealed away, so leaving
 *  the field empty corrects the name or the bank without retyping it. */
export function bankProblems(
  input: BankInput,
  options: { accountOnFile?: boolean } = {},
): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!input.accountName?.trim()) problems.accountName = 'The name on the account.';
  if (!input.bankName?.trim()) problems.bankName = 'Which bank.';
  if (keepsAccountNumber(input, options)) return problems;
  const digits = digitsOf(input.accountNumber ?? '');
  // No country agrees on a length. Four is the shortest that could identify
  // anything and seventeen covers the longest domestic account numbers.
  if (digits.length < 4 || digits.length > 17) {
    problems.accountNumber = 'An account number, 4 to 17 digits.';
  }
  return problems;
}

/** Whether this submission is asking for the stored account number to stand. */
export function keepsAccountNumber(
  input: BankInput,
  options: { accountOnFile?: boolean } = {},
): boolean {
  return Boolean(options.accountOnFile) && digitsOf(input.accountNumber ?? '').length === 0;
}
