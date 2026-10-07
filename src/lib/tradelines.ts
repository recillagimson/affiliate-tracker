/**
 * The tradelines table: which issuers there are, how a pasted spreadsheet
 * becomes rows, and how old a tradeline is.
 *
 * A tradeline here is five facts: what it is (an issuer and type, such as
 * "Capital One Walmart"), its credit limit, the day it was opened, its age in
 * years, and its user price, which is what the user pays us for it.
 *
 * The age is the sheet's own figure, kept and shown exactly as it was pasted
 * or typed. It is never worked out here. An earlier version calculated it
 * from the open date so that it would always be current, and the result was a
 * table that disagreed with the sheet it had just been loaded from; the sheet
 * is the source of that number, so the table shows the sheet's number. A row
 * pasted without an age has none, and shows none.
 *
 * Nearly every row arrives by paste, copied out of a spreadsheet written for
 * people. So parsePaste is forgiving about shape (copied cells, or one value
 * per line; with a header or without; with the age column or without) and
 * strict about content: a limit or a date it cannot read is reported with its
 * line number rather than guessed at, because a guessed limit is a tradeline
 * quoted to somebody wrongly.
 *
 * Pure: text and dates in, rows out. `today` is always passed in, as a
 * YYYY-MM-DD day, and is used only to read two-digit years and to refuse an
 * open date in the future.
 * scripts/tradelines-checks.ts pins it against the Capital One list exactly as
 * it was handed over.
 */

/* ---------------------------------------------------------------- issuers --- */

/**
 * The tables there are, in the order they are offered. The keys are the same
 * values, in the same order, as the check constraint in migration
 * 20261010120000, and are what goes in the page's address.
 */
export const TRADELINE_ISSUERS = [
  { key: 'capital-one', label: 'Capital One' },
  { key: 'citi', label: 'Citi Tradeline' },
  { key: 'discover', label: 'Discover Tradeline' },
  { key: 'fidelity-elan', label: 'Fidelity/Elan Tradeline' },
  { key: 'pnc', label: 'PNC Tradeline' },
  { key: 'us-bank', label: 'US Bank Tradeline' },
] as const;

export type IssuerKey = (typeof TRADELINE_ISSUERS)[number]['key'];

export function isIssuerKey(value: unknown): value is IssuerKey {
  return typeof value === 'string' && TRADELINE_ISSUERS.some((issuer) => issuer.key === value);
}

/** The issuer an address asks for, or the first when it asks for none or for nonsense. */
export function issuerFrom(value: unknown): IssuerKey {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isIssuerKey(text) ? text : TRADELINE_ISSUERS[0].key;
}

/** Where an issuer's logo is served from: public/issuers/<key>.webp. */
export function issuerLogo(key: IssuerKey): string {
  return `/issuers/${key}.webp`;
}

export function issuerLabel(key: IssuerKey): string {
  return TRADELINE_ISSUERS.find((issuer) => issuer.key === key)?.label ?? key;
}

/* ------------------------------------------------------------------ shape --- */

export type Tradeline = {
  id: string;
  issuer: IssuerKey;
  /** Issuer and type, as the sheet names it: "Capital One/Cabelas". */
  name: string;
  creditLimit: number;
  /** The day it was opened, YYYY-MM-DD. */
  openDate: string;
  /** Its age in years, exactly as given. Null when none was. */
  age: number | null;
  /** What the user pays us for it. Null when no price has been set. */
  userPrice: number | null;
};

/** How many tradelines each issuer has. Every issuer is present, at zero when it has none. */
export function countByIssuer(rows: Pick<Tradeline, 'issuer'>[]): Record<IssuerKey, number> {
  const counts = Object.fromEntries(TRADELINE_ISSUERS.map((issuer) => [issuer.key, 0])) as Record<IssuerKey, number>;
  for (const row of rows) counts[row.issuer] += 1;
  return counts;
}

/** A tradeline before it has been stored: what a form or a paste produces. */
export type TradelineInput = {
  name: string;
  creditLimit: number;
  openDate: string;
  age: number | null;
  userPrice: number | null;
};

export const MAX_NAME = 120;

/** More than any real limit, and few enough digits that a slipped key is caught. */
export const MAX_LIMIT = 10_000_000;

/** More than any tradeline is sold for, and enough to catch a limit pasted into the price column. */
export const MAX_PRICE = 1_000_000;

/** Older than any account could be, and enough to catch a figure pasted into the wrong column. */
export const MAX_AGE = 150;

/** One paste. A whole issuer's list is a few dozen rows; this is room to spare. */
export const MAX_PASTE_ROWS = 500;

/* ------------------------------------------------------------------ money --- */

/**
 * A credit limit as a sheet writes it: "$1,524", "3000", "$ 5,000.00".
 * Null for anything that is not a positive amount.
 */
export function parseLimit(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\s$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatLimit(amount: number): string {
  const whole = Number.isInteger(amount);
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A user price as a sheet writes it: "$450", "1,250.50". Null for nothing and
 * for anything that is not an amount from 0 to MAX_PRICE. Zero is a price;
 * no price is null, and the two are shown differently.
 */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= MAX_PRICE ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\s$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount <= MAX_PRICE ? amount : null;
}

/** A price as money, and nothing for a tradeline that has none. */
export function formatPrice(amount: number | null): string {
  return amount === null || !Number.isFinite(amount) ? '' : formatLimit(amount);
}

/* ------------------------------------------------------------------ dates --- */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1 to 12 for "Apr", "April" or "apr."; 0 for anything that is not a month. */
function monthNumber(name: string): number {
  const text = name.toLowerCase().replace(/\.$/, '');
  if (text.length < 3) return 0;
  const at = MONTHS.findIndex((month) => month === text || month.slice(0, 3) === text || (text === 'sept' && month === 'september'));
  return at + 1;
}

/**
 * A year as written. Two digits are this century unless that would be later
 * than this year, in which case they are the last one: nothing is opened in
 * the future, so "98" in 2025 can only be 1998.
 */
function fullYear(text: string, today: string): number {
  const value = Number(text);
  if (text.length > 2) return value;
  const thisYear = Number(today.slice(0, 4));
  const guess = 2000 + value;
  return guess > thisYear ? guess - 100 : guess;
}

/** YYYY-MM-DD when year, month and day name a day that exists; '' otherwise. */
function isoDay(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date rolls 31 February into March rather than refusing it; this refuses it.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * An open date in any of the ways a sheet or a person writes one:
 *
 *   10-Apr-12, 10 Apr 2012     the sheet's own format
 *   2012-04-10                 what a date field produces
 *   4/10/2012, 04/10/12        month first, as US spreadsheets write it
 *   April 10, 2012
 *
 * '' for anything else, including a day that does not exist. Whether the day
 * is acceptable (not in the future) is checkTradeline's to say.
 */
export function parseOpenDate(raw: unknown, today: string): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return isoDay(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[-\s/.]+([A-Za-z]{3,9})\.?[-\s/.,]+(\d{4}|\d{2})$/.exec(text);
  if (match) return isoDay(fullYear(match[3]!, today), monthNumber(match[2]!), Number(match[1]));

  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}|\d{2})$/.exec(text);
  if (match) return isoDay(fullYear(match[3]!, today), monthNumber(match[1]!), Number(match[2]));

  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
  if (match) return isoDay(fullYear(match[3]!, today), Number(match[1]), Number(match[2]));

  return '';
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10 Apr 2012": a month in letters and a year in full, so it cannot be misread. */
export function formatOpenDate(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return `${Number(match[3])} ${SHORT_MONTHS[Number(match[2]) - 1] ?? ''} ${match[1]}`;
}

function utcDays(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

/* -------------------------------------------------------------------- age --- */

/**
 * An age in years as a sheet writes it: "13.38356164". Null for nothing, and
 * for anything that is not a plain number from 0 to MAX_AGE.
 */
export function parseAge(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= MAX_AGE ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const years = Number(text);
  return Number.isFinite(years) && years <= MAX_AGE ? years : null;
}

/**
 * An age as it is shown: the number that was given, with every digit it was
 * given with, and nothing for a tradeline that has none. Not rounded, because
 * the point is that the table and the sheet read the same.
 */
export function formatAge(years: number | null): string {
  return years === null || !Number.isFinite(years) ? '' : String(years);
}

/* ----------------------------------------------------------- one tradeline --- */

/** One sentence per field that cannot be saved as it stands. Empty when it can. */
export function checkTradeline(input: TradelineInput, today: string): Record<string, string> {
  const problems: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) problems.name = 'Give it a name, such as the issuer and type.';
  else if (name.length > MAX_NAME) problems.name = `Keep the name to ${MAX_NAME} characters.`;

  if (!Number.isFinite(input.creditLimit) || input.creditLimit <= 0) {
    problems.creditLimit = 'Enter the credit limit as an amount, such as $3,000.';
  } else if (input.creditLimit > MAX_LIMIT) {
    problems.creditLimit = 'That credit limit is too large to be right. Check it for an extra digit.';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openDate) || Number.isNaN(utcDays(input.openDate))) {
    problems.openDate = 'Enter the date it was opened, such as 10-Apr-12.';
  } else if (input.openDate > today) {
    problems.openDate = 'The open date is in the future. Check the year.';
  }

  if (input.age !== null && (!Number.isFinite(input.age) || input.age < 0 || input.age > MAX_AGE)) {
    problems.age = 'Enter the age in years as a number, such as 13.38, or leave it blank.';
  }

  if (input.userPrice !== null && (!Number.isFinite(input.userPrice) || input.userPrice < 0 || input.userPrice > MAX_PRICE)) {
    problems.userPrice = 'Enter the user price as an amount, such as $450, or leave it blank.';
  }
  return problems;
}

/**
 * A tradeline as a form or a request body sends it, read and checked.
 *
 * The limit may be a number or text ("$3,000"), and the date any way
 * parseOpenDate reads one, so a form field, a paste and a hand-made request
 * all go through the same reading.
 */
export function readTradelineInput(
  value: unknown,
  today: string,
): { ok: true; value: TradelineInput } | { ok: false; fields: Record<string, string> } {
  const item = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const input: TradelineInput = {
    name: typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '',
    creditLimit: parseLimit(item.creditLimit) ?? 0,
    openDate: parseOpenDate(item.openDate, today),
    age: parseAge(item.age),
    userPrice: parsePrice(item.userPrice),
  };
  const fields = checkTradeline(input, today);
  // A blank age is no age. Anything else that did not read as one is a
  // mistake to say, not a value to drop quietly.
  const given = item.age;
  const blank = given === undefined || given === null || (typeof given === 'string' && given.trim() === '');
  if (!blank && input.age === null) fields.age = 'Enter the age in years as a number, such as 13.38, or leave it blank.';
  const price = item.userPrice;
  const noPrice = price === undefined || price === null || (typeof price === 'string' && price.trim() === '');
  if (!noPrice && input.userPrice === null) {
    fields.userPrice = 'Enter the user price as an amount, such as $450, or leave it blank.';
  }
  return Object.keys(fields).length === 0 ? { ok: true, value: input } : { ok: false, fields };
}

/* ------------------------------------------------------------------ paste --- */

export type PasteProblem = {
  /** The line of the paste it is on, counting from 1. */
  line: number;
  /** What was on it, so the row can be found again. */
  text: string;
  reason: string;
};

export type PasteResult = { rows: TradelineInput[]; problems: PasteProblem[] };

const HEADERS = [
  /^issuer(\s*\/\s*type)?$/i,
  /^credit\s*limit$/i,
  /^open\s*date$/i,
  /^age(\s*\(\s*years?\s*\))?$/i,
  /^(user\s*)?price$/i,
];

function isHeader(text: string): boolean {
  return HEADERS.some((pattern) => pattern.test(text.trim()));
}

/** What is wrong with one pasted row, as one sentence, or '' when nothing is. */
function rowProblem(
  name: string,
  limit: string,
  date: string,
  age: string,
  price: string,
  today: string,
): { reason: string; value: TradelineInput | null } {
  if (!name.trim()) return { reason: 'This row has no name.', value: null };
  const creditLimit = parseLimit(limit);
  if (creditLimit === null) return { reason: `The credit limit could not be read: "${limit.trim()}".`, value: null };
  const openDate = parseOpenDate(date, today);
  if (!openDate) return { reason: `The open date could not be read: "${date.trim()}".`, value: null };
  // The age column is optional. Given, it has to be a number; a cell that is
  // there but unreadable is reported, never swapped for a worked-out figure.
  const years = age.trim() === '' ? null : parseAge(age);
  if (age.trim() !== '' && years === null) return { reason: `The age could not be read: "${age.trim()}".`, value: null };
  // The same for the price: optional, but if a cell is there it has to read.
  const userPrice = price.trim() === '' ? null : parsePrice(price);
  if (price.trim() !== '' && userPrice === null) {
    return { reason: `The user price could not be read: "${price.trim()}".`, value: null };
  }
  const value = { name: name.replace(/\s+/g, ' ').trim(), creditLimit, openDate, age: years, userPrice };
  const found = Object.values(checkTradeline(value, today));
  return found.length > 0 ? { reason: found[0]!, value: null } : { reason: '', value };
}

/**
 * Rows copied out of a spreadsheet, read into tradelines.
 *
 * Two shapes arrive, and which one is told from whether there is a tab in it.
 * Cells copied from a sheet come across with tabs between them, one row a
 * line. The same table copied out of a chat or a document comes as one value
 * per line: a name, a limit, a date, and sometimes the age. Either may start
 * with the sheet's header, which is skipped, and either may carry the age
 * column, which is kept exactly as written: see the note at the top of this
 * file.
 *
 * Every row that could be read is returned, and every one that could not is
 * reported with its line, so a paste with one bad row still loads the rest and
 * says which to fix.
 */
export function parsePaste(text: string, today: string): PasteResult {
  const lines = text.split(/\r\n|\r|\n/);
  const rows: TradelineInput[] = [];
  const problems: PasteProblem[] = [];
  let dropped = 0;

  function take(line: number, shown: string, name: string, limit: string, date: string, age: string, price: string) {
    const { reason, value } = rowProblem(name, limit, date, age, price, today);
    if (!value) {
      problems.push({ line, text: shown, reason });
      return;
    }
    if (rows.length >= MAX_PASTE_ROWS) {
      dropped += 1;
      return;
    }
    rows.push(value);
  }

  if (lines.some((line) => line.includes('\t'))) {
    lines.forEach((raw, index) => {
      if (raw.trim() === '') return;
      const cells = raw.split('\t').map((cell) => cell.trim());
      // The header: its second cell names a column instead of holding an amount.
      if (isHeader(cells[0] ?? '') && parseLimit(cells[1] ?? '') === null) return;
      take(index + 1, cells.filter(Boolean).join(' | '), cells[0] ?? '', cells[1] ?? '', cells[2] ?? '', cells[3] ?? '', cells[4] ?? '');
    });
  } else {
    const filled = lines.map((raw, index) => ({ text: raw.trim(), line: index + 1 })).filter((entry) => entry.text !== '');
    let at = 0;
    while (at < filled.length && isHeader(filled[at]!.text)) at += 1;
    while (at < filled.length) {
      const [name, limit, date] = [filled[at]!, filled[at + 1], filled[at + 2]];
      if (!limit || !date) {
        problems.push({
          line: name.line,
          text: filled.slice(at).map((entry) => entry.text).join(' | '),
          reason: 'This row is incomplete. Each tradeline needs a name, a credit limit and an open date.',
        });
        break;
      }
      at += 3;
      // The age, when the sheet's fourth column came along. A bare number
      // straight after a date can only be that.
      let age = '';
      if (at < filled.length && /^\d+(\.\d+)?$/.test(filled[at]!.text)) {
        age = filled[at]!.text;
        at += 1;
      }
      // The user price, when the sheet's fifth column came along too. An
      // amount written as money can only be that, since the next row would
      // begin with a name; so can a second bare number straight after an age.
      let price = '';
      const next = at < filled.length ? filled[at]!.text : '';
      if ((next.startsWith('$') && parsePrice(next) !== null) || (age !== '' && /^\d+(\.\d+)?$/.test(next))) {
        price = next;
        at += 1;
      }
      take(
        name.line,
        [name.text, limit.text, date.text, age, price].filter(Boolean).join(' | '),
        name.text,
        limit.text,
        date.text,
        age,
        price,
      );
    }
  }

  if (dropped > 0) {
    problems.push({
      line: 0,
      text: '',
      reason: `Only ${MAX_PASTE_ROWS} rows can be pasted at a time. The last ${dropped} were left out; paste them separately.`,
    });
  }
  return { rows, problems };
}

/* ---------------------------------------------------------------- sorting --- */

export type TradelineSort = 'entered' | 'name' | 'creditLimit' | 'openDate' | 'age' | 'userPrice';

/**
 * The table in the order asked for. A new list; the one given is left alone.
 *
 * Age sorts by the age on the row, which is the sheet's figure and need not
 * agree with the open date. A row with no age, or no price when sorting by
 * price, goes last whichever way the sort runs: it is not the least and it is
 * not the most, it is unknown.
 * Anything that ties falls back to the order the rows were entered in, so a
 * sort never shuffles rows that are equal.
 */
export function sortTradelines(rows: Tradeline[], key: TradelineSort, direction: 'asc' | 'desc'): Tradeline[] {
  const entered = (a: Tradeline, b: Tradeline) => Number(a.id) - Number(b.id);
  const sign = direction === 'asc' ? 1 : -1;
  const by = (a: Tradeline, b: Tradeline): number => {
    if (key === 'name') return sign * a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (key === 'creditLimit') return sign * (a.creditLimit - b.creditLimit);
    if (key === 'openDate') return sign * (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0);
    if (key === 'age' || key === 'userPrice') {
      const [x, y] = [a[key], b[key]];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return sign * (x - y);
    }
    return sign * entered(a, b);
  };
  return [...rows].sort((a, b) => by(a, b) || entered(a, b));
}
