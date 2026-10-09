'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Modal } from '@/components/Modal';
import { BusyLabel } from '@/components/Spinner';
import { TableScroller } from '@/components/TableScroller';
import {
  checkTradeline,
  countByIssuer,
  formatAge,
  formatLimit,
  formatOpenDate,
  formatPrice,
  issuerLabel,
  issuerLogo,
  MAX_NAME,
  parseAge,
  parseLimit,
  parsePrice,
  parsePaste,
  sortTradelines,
  TRADELINE_ISSUERS,
  type IssuerKey,
  type PasteResult,
  type Tradeline,
  type TradelineSort,
} from '@/lib/tradelines';

/* ------------------------------------------------------------- the issuers --- */

/**
 * Which issuer's table is showing, and how to reach the others.
 *
 * A card each, with the issuer's logo and nothing written beside it but how
 * many tradelines it holds: the logo is the name. It is still the image's alt
 * text, so a screen reader hears it and it shows if the image does not load.
 *
 * Each is a real link with the issuer's own address, so it can be opened in a
 * new tab or sent to somebody, but an ordinary click is handled in place
 * (see TradelinesBrowser) and does not load the page again.
 *
 * The logo files are squares with the mark in the middle and white round it,
 * and how much of the square the mark fills differs from one to the next: a
 * wide wordmark is a thin strip, a stacked one fills most of the height. So
 * each is drawn at its own size (LOGO_SIZE), chosen so its mark fills the
 * frame, and the frame cuts the empty margin away. Every card stays white,
 * selected or not, since the logos are drawn for a white ground; the one
 * showing is told apart by its border and the bar under it.
 */

/**
 * How large, in pixels, each logo's square is drawn inside a frame 44 high.
 * Worked out from where the mark sits in each file, so that the mark itself
 * comes out about 86 wide or 40 tall, whichever it reaches first. A new logo
 * file needs its own number here; 74 shows any square whole-ish.
 */
const LOGO_SIZE: Record<IssuerKey, number> = {
  'capital-one': 110, // wide wordmark: 78% of the width, 28% of the height
  citi: 84, // 76% wide, 46% tall with its arc
  discover: 110, // 77% wide, a thin strip
  'fidelity-elan': 110, // 77% wide
  pnc: 56, // stacked: 59% wide, 76% tall
  'us-bank': 107, // 80% wide
};

/** The address that opens on an issuer. The first is the bare page, since that is where it opens anyway. */
export function issuerHref(key: IssuerKey): string {
  return key === TRADELINE_ISSUERS[0].key ? '/tradelines' : `/tradelines?issuer=${key}`;
}

/** One issuer's rows out of all of them. */
export function pickIssuer(all: Tradeline[], issuer: IssuerKey): Tradeline[] {
  return all.filter((row) => row.issuer === issuer);
}

export function IssuerTabs({
  current,
  counts,
  onChoose,
}: {
  current: IssuerKey;
  counts: Record<IssuerKey, number>;
  /** When given, a plain click switches in place instead of loading the page again. */
  onChoose?: (issuer: IssuerKey) => void;
}) {
  return (
    <nav aria-label="Issuers" className="mt-5 flex flex-wrap gap-2">
      {TRADELINE_ISSUERS.map((issuer) => {
        const active = issuer.key === current;
        const count = counts[issuer.key] ?? 0;
        return (
          <a
            key={issuer.key}
            href={issuerHref(issuer.key)}
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => {
              // A modified click (new tab, new window) is left to the browser,
              // which is what the address on the link is for.
              if (!onChoose || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              onChoose(issuer.key);
            }}
            className={`group relative flex w-[132px] cursor-pointer flex-col items-center overflow-hidden rounded-[8px] border bg-white px-2 pb-2 pt-1 text-center transition-colors active:bg-paper-sunk ${
              active ? 'border-navy shadow-[0_0_0_1px_var(--color-navy)]' : 'border-edge hover:border-edge-strong'
            }`}
          >
            <span className="pointer-events-none relative block h-[44px] w-full overflow-hidden">
              {/* A plain img: a small static file from this app's own public
                  folder, with nothing for next/image to optimise. Its alt is
                  the issuer's name, since no name is written beside it. */}
              <img
                src={issuerLogo(issuer.key)}
                alt={issuer.label}
                width={LOGO_SIZE[issuer.key]}
                height={LOGO_SIZE[issuer.key]}
                style={{ width: LOGO_SIZE[issuer.key], height: LOGO_SIZE[issuer.key] }}
                className="absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2"
              />
            </span>
            <span className={`tnum pointer-events-none block text-[10px] ${active ? 'font-semibold text-ink' : 'text-ink-dim'}`}>
              <span>{count}</span> {count === 1 ? 'tradeline' : 'tradelines'}
            </span>
            <span aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] ${active ? 'bg-navy' : 'bg-transparent'}`} />
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The issuer cards and the table under them, switching without a round trip.
 *
 * The page hands over every issuer's tradelines at once; they are a few dozen
 * small rows each, and the counts on the cards need them all anyway. So
 * choosing an issuer is a change of which rows are drawn, and happens the
 * moment the card is pressed. It used to be a link that loaded the page
 * again, which took a second or two with nothing on screen to say it had
 * been pressed, and read as a card that could not be clicked.
 *
 * The address is still kept in step, without a navigation, so a reload or a
 * copied link opens on the same issuer.
 */
export function TradelinesBrowser({
  all,
  initialIssuer,
  today,
  canEdit = false,
}: {
  all: Tradeline[];
  initialIssuer: IssuerKey;
  today: string;
  /** Whether the viewer keeps the table (an admin) or only reads it. */
  canEdit?: boolean;
}) {
  const [issuer, setIssuer] = useState<IssuerKey>(initialIssuer);
  const counts = useMemo(() => countByIssuer(all), [all]);

  function choose(next: IssuerKey) {
    setIssuer(next);
    window.history.replaceState(null, '', issuerHref(next));
  }

  return (
    <>
      <IssuerTabs current={issuer} counts={counts} onChoose={choose} />
      {/* Remounted per issuer, so a sort or an open dialog does not carry from one table to the next. */}
      <TradelinesTable key={issuer} issuer={issuer} rows={pickIssuer(all, issuer)} today={today} canEdit={canEdit} />
    </>
  );
}

/* ---------------------------------------------------------------- requests --- */

async function post(body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string; fields: Record<string, string> }> {
  let response: Response;
  try {
    response = await fetch('/api/tradelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server.', fields: {} };
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; hint?: string; fields?: Record<string, string> };
  if (response.ok) return { ok: true };
  const error = data.error ? (data.hint ? `${data.error} ${data.hint}` : data.error) : `That did not save (${response.status}).`;
  return { ok: false, error, fields: data.fields ?? {} };
}

function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="warn-note">
      <span aria-hidden className="warn-note-mark">
        ⚠
      </span>
      <span>{children}</span>
    </p>
  );
}

/* --------------------------------------------------------------- the table --- */

const COLUMNS: { key: TradelineSort; label: string; right: boolean }[] = [
  { key: 'name', label: 'Issuer/Type', right: false },
  { key: 'creditLimit', label: 'Credit Limit', right: true },
  { key: 'openDate', label: 'Open Date', right: true },
  { key: 'age', label: 'Age (Years)', right: true },
  { key: 'userPrice', label: 'User Price', right: true },
];

type Editing = { mode: 'add' } | { mode: 'edit'; row: Tradeline } | null;

/**
 * One issuer's tradelines, and the ways an admin keeps them up to date.
 *
 * Five columns. The fourth, age, is the sheet's figure shown exactly as it
 * was pasted or typed; nothing here works it out. The fifth, user price, is
 * what the user pays us for the tradeline, blank until one is set. `today` is
 * only for reading a paste's two-digit years and for stopping an open date
 * being set in the future.
 *
 * Rows start in the order they were entered, which is the order of the sheet
 * they came from. A heading sorts by its column, and pressing it again turns
 * the sort round.
 *
 * Only an admin changes it. Unless canEdit is said, nothing that adds, edits,
 * deletes or pastes is drawn, which is how an affiliate on tradelines sees it.
 * That is presentation: the route refuses them whatever the page shows.
 */
export function TradelinesTable({
  issuer,
  rows,
  today,
  canEdit = false,
}: {
  issuer: IssuerKey;
  rows: Tradeline[];
  today: string;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: TradelineSort; direction: 'asc' | 'desc' }>({ key: 'entered', direction: 'asc' });
  const [editing, setEditing] = useState<Editing>(null);
  const [pasting, setPasting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => sortTradelines(rows, sort.key, sort.direction), [rows, sort]);
  const label = issuerLabel(issuer);

  function sortBy(key: TradelineSort) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : // Numbers open on the big end, which is the end people look for:
          // the oldest tradeline, the highest limit. Names open at A.
          { key, direction: key === 'name' || key === 'openDate' ? 'asc' : 'desc' },
    );
  }

  async function remove(row: Tradeline) {
    if (!confirm(`Delete ${row.name}, ${formatLimit(row.creditLimit)}, opened ${formatOpenDate(row.openDate)}?`)) return;
    setBusyId(row.id);
    setError(null);
    const result = await post({ action: 'delete', id: row.id });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-semibold">{label}</h2>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            {rows.length === 1 ? '1 tradeline' : `${rows.length} tradelines`}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2.5">
            <button type="button" className="btn-outline" aria-haspopup="dialog" onClick={() => setPasting(true)}>
              Paste rows
            </button>
            <button type="button" className="btn-gold" aria-haspopup="dialog" onClick={() => setEditing({ mode: 'add' })}>
              + Add tradeline
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-edge px-5 py-3.5">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="px-5 py-14 text-center text-[13px] text-ink-soft">
          {canEdit
            ? `No tradelines for ${label} yet. Paste them in from a spreadsheet, or add one at a time.`
            : `No tradelines for ${label} yet.`}
        </p>
      ) : (
        <TableScroller label={`${label} tradelines`}>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={`border-b border-edge px-5 py-0 ${column.right ? 'text-right' : 'text-left'}`}
                    >
                      <button
                        type="button"
                        onClick={() => sortBy(column.key)}
                        className={`label-cap inline-flex items-center gap-1.5 py-2.5 text-[10px] ${active ? 'text-ink' : ''}`}
                      >
                        {column.label}
                        {/* Always there, dimmed when idle, so the row does not shift when a sort starts. */}
                        <span aria-hidden className={active ? '' : 'opacity-30'}>
                          {active && sort.direction === 'asc' ? '▲' : '▼'}
                        </span>
                      </button>
                    </th>
                  );
                })}
                {canEdit ? (
                  <th scope="col" className="border-b border-edge px-5 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id} className="border-b border-edge last:border-b-0">
                  <td className="px-5 py-3 text-[13px] font-medium text-ink">{row.name}</td>
                  <td className="tnum px-5 py-3 text-right text-[13px] text-ink">{formatLimit(row.creditLimit)}</td>
                  <td className="tnum whitespace-nowrap px-5 py-3 text-right text-[13px] text-ink-soft">
                    {formatOpenDate(row.openDate)}
                  </td>
                  <td className="tnum px-5 py-3 text-right text-[13px] text-ink">{formatAge(row.age)}</td>
                  <td className="tnum px-5 py-3 text-right text-[13px] font-medium text-ink">{formatPrice(row.userPrice)}</td>
                  {canEdit ? (
                    <td className="whitespace-nowrap px-5 py-2 text-right">
                      <span className="inline-flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="btn-quiet btn-sm"
                          disabled={busyId === row.id}
                          onClick={() => setEditing({ mode: 'edit', row })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          disabled={busyId === row.id}
                          aria-busy={busyId === row.id}
                          onClick={() => remove(row)}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      {canEdit ? (
          <>
        {/* Keyed by what is being edited, so each opening starts from that row's own values. */}
        <TradelineForm
          key={editing ? (editing.mode === 'edit' ? `edit-${editing.row.id}` : 'add') : 'closed'}
          issuer={issuer}
          editing={editing}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
        <PasteDialog
          open={pasting}
          issuer={issuer}
          existing={rows.length}
          today={today}
          onClose={() => setPasting(false)}
          onSaved={() => {
            setPasting(false);
            router.refresh();
          }}
        />
          </>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------- one tradeline --- */

/**
 * Adding one tradeline, or changing one.
 *
 * The limit is typed the way it is written, "$3,000" or "3000", and read the
 * way a paste is. The date is a date field, so there is no format to get
 * wrong, and it cannot be set past today. The age is typed too, and saved as
 * typed: it is not filled in from the date.
 */
function TradelineForm({
  issuer,
  editing,
  today,
  onClose,
  onSaved,
}: {
  issuer: IssuerKey;
  editing: Editing;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const row = editing?.mode === 'edit' ? editing.row : null;
  const [name, setName] = useState(row?.name ?? '');
  const [limit, setLimit] = useState(row ? formatLimit(row.creditLimit) : '');
  const [openDate, setOpenDate] = useState(row?.openDate ?? '');
  const [age, setAge] = useState(row ? formatAge(row.age) : '');
  const [price, setPrice] = useState(row ? formatPrice(row.userPrice) : '');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const input = {
      name: name.trim(),
      creditLimit: parseLimit(limit) ?? 0,
      openDate,
      age: parseAge(age),
      userPrice: parsePrice(price),
    };
    const found = checkTradeline(input, today);
    // Something typed that is not a number is a mistake to say, not a blank.
    if (age.trim() !== '' && input.age === null) found.age = 'Enter the age in years as a number, such as 13.38, or leave it blank.';
    if (price.trim() !== '' && input.userPrice === null) {
      found.userPrice = 'Enter the user price as an amount, such as $450, or leave it blank.';
    }
    if (Object.keys(found).length > 0) {
      setProblems(found);
      return;
    }
    setBusy(true);
    setError(null);
    setProblems({});
    const result = await post(row ? { action: 'update', id: row.id, ...input } : { action: 'add', issuer, ...input });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setProblems(result.fields);
      return;
    }
    onSaved();
  }

  return (
    <Modal open={editing !== null} title={row ? 'Edit tradeline' : `Add a tradeline to ${issuerLabel(issuer)}`} onClose={onClose}>
      <form onSubmit={save} className="mt-5 flex flex-col gap-6">
        {error ? <Alert>{error}</Alert> : null}

        <label className="block">
          <span className="field-label">Issuer/Type</span>
          <input
            name="name"
            className="field mt-1.5"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            placeholder="Capital One Walmart"
            autoComplete="off"
            disabled={busy}
            aria-invalid={problems.name ? true : undefined}
          />
          {problems.name ? <span className="field-error">{problems.name}</span> : null}
        </label>

        <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Credit limit</span>
            <input
              name="creditLimit"
              className="field mt-1.5"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="$3,000"
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              aria-invalid={problems.creditLimit ? true : undefined}
            />
            {problems.creditLimit ? <span className="field-error">{problems.creditLimit}</span> : null}
          </label>

          <label className="block">
            <span className="field-label">Open date</span>
            <input
              name="openDate"
              type="date"
              className="field mt-1.5"
              value={openDate}
              max={today}
              onChange={(e) => setOpenDate(e.target.value)}
              disabled={busy}
              aria-invalid={problems.openDate ? true : undefined}
            />
            {problems.openDate ? <span className="field-error">{problems.openDate}</span> : null}
          </label>

          <label className="block">
            <span className="field-label">Age (Years)</span>
            <input
              name="age"
              className="field mt-1.5"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="13.38356164"
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              aria-invalid={problems.age ? true : undefined}
            />
            {problems.age ? (
              <span className="field-error">{problems.age}</span>
            ) : (
              <span className="field-note">Shown exactly as typed. It is not worked out from the date.</span>
            )}
          </label>

          <label className="block">
            <span className="field-label">User Price</span>
            <input
              name="userPrice"
              className="field mt-1.5"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$450"
              inputMode="decimal"
              autoComplete="off"
              disabled={busy}
              aria-invalid={problems.userPrice ? true : undefined}
            />
            {problems.userPrice ? (
              <span className="field-error">{problems.userPrice}</span>
            ) : (
              <span className="field-note">What the user pays us. Leave blank if it is not set yet.</span>
            )}
          </label>
        </div>

        <div className="flex flex-wrap justify-end gap-2.5 border-t border-edge pt-5">
          <button type="button" className="btn-outline" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-gold" disabled={busy} aria-busy={busy}>
            <BusyLabel busy={busy} idle={row ? 'Save changes' : 'Add tradeline'} busyLabel="Saving…" />
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------- paste --- */

/** How many of a paste's rows are drawn before the rest become a line. */
const PREVIEW_ROWS = 8;

/**
 * What a paste was read as, before anything is saved: how many tradelines,
 * the first few of them with the age as it was pasted, and every row that
 * could not be read, with its line.
 *
 * No state, so every shape it takes is rendered directly by
 * scripts/tradelines-render-checks.tsx.
 */
export function PastePreview({ result }: { result: PasteResult }) {
  const { rows, problems } = result;
  if (rows.length === 0 && problems.length === 0) return null;
  const more = rows.length - PREVIEW_ROWS;

  return (
    <div className="flex flex-col gap-4">
      {rows.length > 0 ? (
        <div>
          <p className="text-[13px] font-medium text-ink">
            {rows.length === 1 ? '1 tradeline read' : `${rows.length} tradelines read`}
          </p>
          <div className="mt-2 overflow-x-auto rounded-[6px] border border-edge">
            <table className="w-full border-collapse text-left text-[12px]">
              <tbody>
                {rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                  <tr key={index} className="border-b border-edge last:border-b-0">
                    <td className="px-3 py-1.5 text-ink">{row.name}</td>
                    <td className="tnum px-3 py-1.5 text-right text-ink">{formatLimit(row.creditLimit)}</td>
                    <td className="tnum whitespace-nowrap px-3 py-1.5 text-right text-ink-soft">{formatOpenDate(row.openDate)}</td>
                    <td className="tnum px-3 py-1.5 text-right text-ink-soft">{formatAge(row.age)}</td>
                    <td className="tnum px-3 py-1.5 text-right text-ink">{formatPrice(row.userPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more > 0 ? <p className="mt-1.5 text-[12px] text-ink-soft">and {more} more.</p> : null}
        </div>
      ) : null}

      {problems.length > 0 ? (
        <div className="rounded-[6px] border border-alarm-edge bg-alarm-wash p-3">
          <p className="text-[13px] font-medium text-alarm">
            {problems.length === 1 ? '1 row could not be read' : `${problems.length} rows could not be read`}, and will be left
            out.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 text-[12px] text-ink">
            {problems.map((problem, index) => (
              <li key={index}>
                {problem.line > 0 ? <strong className="font-semibold">Line {problem.line}: </strong> : null}
                {problem.reason}
                {problem.text ? <span className="block text-ink-soft">{problem.text}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Loading tradelines from a spreadsheet.
 *
 * Paste, and what it was read as appears underneath at once: nothing is saved
 * until the admin has seen it and pressed the button. Rows that could not be
 * read are listed and left out, and the rest can still be saved.
 *
 * Adding is the default. Replacing throws away what the table holds, so it
 * has to be chosen, says how many rows it will remove, and asks once more.
 */
function PasteDialog({
  open,
  issuer,
  existing,
  today,
  onClose,
  onSaved,
}: {
  open: boolean;
  issuer: IssuerKey;
  existing: number;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => parsePaste(text, today), [text, today]);
  const count = result.rows.length;
  const label = issuerLabel(issuer);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || count === 0) return;
    if (
      mode === 'replace' &&
      existing > 0 &&
      !confirm(`Replace all ${existing} ${label} tradelines with these ${count}? The current ones are deleted.`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const saved = await post({ action: 'import', issuer, mode, rows: result.rows });
    setBusy(false);
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setText('');
    setMode('add');
    onSaved();
  }

  return (
    <Modal open={open} title={`Paste tradelines into ${label}`} onClose={onClose}>
      <form onSubmit={save} className="mt-5 flex flex-col gap-6">
        {error ? <Alert>{error}</Alert> : null}

        <label className="block">
          <span className="field-label">Rows from your spreadsheet</span>
          <textarea
            name="rows"
            className="field mt-1.5 min-h-[150px] py-2 font-mono text-[12px] leading-relaxed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Capital One Walmart\t$1,524\t31-Dec-17\t7.654794521\t$250'}
            spellCheck={false}
            disabled={busy}
          />
          <span className="field-note">
            Copy the Issuer/Type, Credit Limit, Open Date, Age (Years) and User Price columns, in that order, and paste them
            here. Copied cells and CSV both work. A header row is fine, and the last two columns can be left out. The age is
            saved exactly as pasted.
          </span>
        </label>

        <PastePreview result={result} />

        <fieldset className="block">
          <legend className="field-label">What to do with them</legend>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {(
              [
                ['add', 'Add to the table', 'The tradelines already there are kept, and these go after them.'],
                [
                  'replace',
                  'Replace the table',
                  existing > 0
                    ? `The ${existing === 1 ? '1 tradeline' : `${existing} tradelines`} there now ${existing === 1 ? 'is' : 'are'} deleted, and these take their place.`
                    : 'The table is empty, so this is the same as adding.',
                ],
              ] as const
            ).map(([value, title, meaning]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  disabled={busy}
                  onChange={() => setMode(value)}
                  className="mt-0.5 h-4 w-4 flex-none accent-navy"
                />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink">{title}</span>
                  <span className="block text-[12px] leading-relaxed text-ink-soft">{meaning}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2.5 border-t border-edge pt-5">
          <button type="button" className="btn-outline" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={mode === 'replace' ? 'btn-danger' : 'btn-gold'} disabled={busy || count === 0} aria-busy={busy}>
            <BusyLabel
              busy={busy}
              idle={
                count === 0
                  ? 'Nothing to save yet'
                  : mode === 'replace'
                    ? `Replace with ${count === 1 ? '1 tradeline' : `${count} tradelines`}`
                    : `Add ${count === 1 ? '1 tradeline' : `${count} tradelines`}`
              }
              busyLabel="Saving…"
            />
          </button>
        </div>
      </form>
    </Modal>
  );
}
