'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { stepsFor, waivedSteps, type OnboardingState } from '@/lib/onboarding';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';
import { Pager } from './Pager';
import { RowMenu, RowMenuItem } from './RowMenu';
import { TableScroller } from './TableScroller';
import { BusyLabel } from './Spinner';
import { ApprovalPill } from './ApprovalPill';
import { awaitingReview, isBypassed, NO_BYPASS, type Approval, type Bypass } from '@/lib/approval';
import { PERSON_ROLES, personRole, ROLE_LABELS, type PersonRole } from '@/lib/roles';
import { DEFAULT_SERVICES, servicesProblem, type Service } from '@/lib/services';
import { ServiceBoxes, ServiceChips } from '@/components/ServicesSelect';

export type AccountRow = {
  id: string;
  username: string;
  role: 'admin' | 'affiliate';
  /** An affiliate who is an LGF employee. Shown as its own role; see lib/roles. */
  lgfEmployee?: boolean;
  /** What they are onboarded for. Absent for an admin, who is not. */
  services?: Service[];
  usr: string;
  fullName: string;
  email: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  createdBy: string;
  /** How far through onboarding they are. Null for an admin, who does not. */
  setup: OnboardingState | null;
  /** Whether anybody has let them in. Null for an admin, who is not reviewed. */
  approval: Approval | null;
  /** Whether an admin waived the gate for them. */
  bypass: Bypass | null;
};

type Fields = {
  username: string;
  role: PersonRole;
  fullName: string;
  email: string;
  services: Service[];
};

type RoleFilter = 'all' | PersonRole;

const EMPTY: Fields = { username: '', role: 'affiliate', fullName: '', email: '', services: [...DEFAULT_SERVICES] };

function softUsername(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
}

/**
 * "21 Aug 2026", or the plain truth that they never have.
 *
 * Deliberately not a relative time. "3 months ago" is the wrong unit for the
 * question this column answers, which is whether an account is still in use and
 * ought to still exist.
 */
function signInDate(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The accounts a search and a role filter leave behind.
 *
 * Pulled out as a plain function so it can be checked without mounting the
 * panel, which calls useRouter and so cannot be rendered outside a request.
 * Username, name and email all match: an admin looking someone up has whichever
 * one of the three they were given.
 */
/**
 * The four answers the status filter can give.
 *
 * "Waiting" is the one that matters and the reason this exists: an admin coming
 * to this page to clear a queue wants the queue, not a list of everybody with a
 * few gold pills scattered through it. It is deliberately narrower than
 * "pending", which also covers people who have signed up and filled in nothing.
 */
export type StatusFilter = 'all' | 'waiting' | 'approved' | 'declined' | 'bypassed';

export function matchAccounts(
  rows: AccountRow[],
  query: string,
  role: RoleFilter,
  status: StatusFilter = 'all',
): AccountRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (role !== 'all' && personRole(row.role, Boolean(row.lgfEmployee)) !== role) return false;
    if (status !== 'all') {
      // An admin has no approval state, so any status filter excludes them
      // rather than silently treating "no answer" as a match.
      if (!row.approval) return false;
      const waived = row.bypass ? isBypassed(row.bypass) : false;
      if (status === 'bypassed') return waived;
      /*
       * A waived account is in none of the other three. It is not in the queue
       * (nobody is waiting on it), and listing it under approved or declined
       * would put an account nobody has read beside accounts somebody has.
       */
      if (waived) return false;
      if (status === 'waiting' && !awaitingReview(row.approval)) return false;
      if (status === 'approved' && row.approval.status !== 'approved') return false;
      if (status === 'declined' && row.approval.status !== 'declined') return false;
    }
    if (!needle) return true;
    return [row.username, row.fullName, row.email, row.usr]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
}

/**
 * The password that was just issued, and who it belongs to.
 *
 * `usr` is carried too, but only for a newly created affiliate: the generated
 * tracking key is the other thing an admin needs off this screen, and it is
 * shown here rather than hunted for in the list below.
 */
type Issued = {
  username: string;
  password: string;
  reason: 'created' | 'reset';
  usr?: string;
};

export function UsersPanel({
  rows,
  viewerId,
  viewerUsername,
}: {
  rows: AccountRow[];
  viewerId: string;
  viewerUsername: string;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Which of the row's three buttons is running. `busy` alone says which row,
   * and a row has Reset password, Disable/Enable and Delete side by side — so
   * without this the spinner would have to go on all three or none.
   */
  const [running, setRunning] = useState<null | 'reset-password' | 'enable' | 'disable' | 'delete' | 'view-as'>(
    null,
  );
  const [issued, setIssued] = useState<Issued | null>(null);
  /* The create form is a drawer rather than a permanent fixture at the top of
     the page. Adding someone happens a handful of times a year; reading the
     list happens every week, and the form was pushing it below the fold. */
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[0]);
  /* Ticked for a bulk role change. Kept across pages and filters, so an admin
     can gather people from several searches and change them in one go; the bar
     says how many are ticked, so nothing is changed that is out of sight
     without being counted. Your own account cannot be ticked. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<PersonRole>('lgf_employee');
  const [notice, setNotice] = useState<string | null>(null);
  const issuedRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLInputElement | null>(null);

  const matched = useMemo(
    () => matchAccounts(rows, query, role, status),
    [rows, query, role, status],
  );

  /* Counted over everything rather than over what is on screen, so the number
     beside "Waiting" does not change when somebody types in the search box. */
  const waitingCount = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.approval &&
          awaitingReview(row.approval) &&
          !(row.bypass && isBypassed(row.bypass)),
      ).length,
    [rows],
  );

  /*
   * Sliced rather than cut: an account disabled or deleted from the last page
   * shortens the list under a page number this component is still holding, and
   * pageSlice clamps that back to the last page there is.
   */
  const visible = pageSlice(matched, page, perPage);
  const tickable = visible.filter((row) => row.id !== viewerId);
  const pageState =
    tickable.length > 0 && tickable.every((row) => selected.has(row.id))
      ? 'all'
      : tickable.some((row) => selected.has(row.id))
        ? 'some'
        : 'none';

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of tickable) {
        if (pageState === 'all') next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  async function applyBulkRole() {
    const ids = [...selected];
    const people = ids.length === 1 ? '1 person' : `${ids.length} people`;
    const demotesAdmin = rows.some((row) => selected.has(row.id) && row.role === 'admin');
    const warning =
      bulkRole === 'admin'
        ? ' They will see everybody’s numbers.'
        : demotesAdmin
          ? ' Any admins among them will lose admin.'
          : '';
    if (!confirm(`Set ${people} to ${ROLE_LABELS[bulkRole]}?${warning}`)) return;

    setBusy('bulk');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/users/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, role: bulkRole }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Could not change the roles.');
        return;
      }
      const skipped: { name: string; reason: string }[] = data.skipped ?? [];
      setNotice(
        `${data.updated} set to ${ROLE_LABELS[bulkRole]}.` +
          (skipped.length
            ? ` Not changed: ${skipped.map((row) => `${row.name} (${row.reason})`).join('; ')}.`
            : ''),
      );
      setSelected(new Set());
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  // Move focus to the password the moment it appears. It is shown exactly once,
  // so a screen reader user must not have to go looking for it, and a sighted
  // user should not miss it because the page scrolled.
  useEffect(() => {
    if (issued) issuedRef.current?.focus();
  }, [issued]);

  // Opening the drawer puts the caret in the first field. A form that appears
  // somewhere below the button you just pressed is a form you then have to go
  // and find.
  useEffect(() => {
    if (adding) formRef.current?.focus();
  }, [adding]);

  function set<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const noService = fields.role === 'admin' ? '' : servicesProblem(fields.services);
    if (noService) {
      setFieldErrors({ services: noService });
      return;
    }
    setBusy('create');
    setError(null);
    setFieldErrors({});
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: fields.username.trim().toLowerCase(),
          role: fields.role,
          fullName: fields.fullName.trim(),
          email: fields.email.trim(),
          // An admin is onboarded for nothing; the route ignores it for them.
          services: fields.role === 'admin' ? undefined : fields.services,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Could not create that account.');
        if (data.fields) setFieldErrors(data.fields);
        return;
      }
      setIssued({
        username: data.user.username,
        password: data.password,
        reason: 'created',
        usr: data.user.usr || undefined,
      });
      setFields(EMPTY);
      // Created, but not quite as asked: an LGF employee whose marker did not
      // save. Said in the page's alert, which is where the admin is looking.
      if (data.warning) setError(data.warning);
      // Closed on success only. A failed submit keeps the form open with what
      // was typed still in it.
      setAdding(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
      setRunning(null);
    }
  }

  async function act(row: AccountRow, action: 'reset-password' | 'enable' | 'disable') {
    if (action === 'disable' && !confirm(`Disable ${row.username}? They will be signed out.`)) return;
    setBusy(row.id);
    setRunning(action);
    setError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not work.');
        return;
      }
      if (action === 'reset-password') {
        setIssued({ username: row.username, password: data.password, reason: 'reset' });
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
      setRunning(null);
    }
  }

  /**
   * Become this affiliate, then land on the dashboard they see at sign-in.
   *
   * Confirmed first, because it is not a read: while it is active, anything
   * submitted is stored as that person's own action, and an admin who clicked
   * by accident should find that out here rather than three forms later.
   */
  async function viewAs(row: AccountRow) {
    if (
      !confirm(
        `View the app as ${row.username}?

` +
          'You will see exactly what they see, including their onboarding if it is unfinished. ' +
          'Anything you submit while looking is recorded as theirs.',
      )
    ) {
      return;
    }
    setBusy(row.id);
    setRunning('view-as');
    setError(null);
    try {
      const response = await fetch('/api/view-as', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: row.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not work.');
        return;
      }
      // A whole-document navigation, not router.push: the ticket is a cookie,
      // and every server component has to re-render behind it rather than the
      // client reusing a tree built as the admin.
      window.location.assign('/');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
      setRunning(null);
    }
  }

  async function remove(row: AccountRow) {
    if (
      !confirm(
        `Delete ${row.username} for good? Their links, leads and approvals are not touched. Only the sign-in goes.`,
      )
    ) {
      return;
    }
    setBusy(row.id);
    setRunning('delete');
    setError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
      setRunning(null);
    }
  }

  const affiliate = fields.role !== 'admin';

  return (
    <div className="w-full">
      {issued ? (
        <PasswordReveal issued={issued} onDismiss={() => setIssued(null)} ref={issuedRef} />
      ) : null}

      {error ? (
        <p role="alert" className="warn-note mt-5">
          <span aria-hidden className="warn-note-mark">
            ⚠
          </span>
          <span>{error}</span>
        </p>
      ) : null}

      {/* Add someone — a drawer, opened from the toolbar below */}
      {adding ? (
        <section className="panel mt-5 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-edge px-5 py-3.5">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.03em] text-ink-soft">
              Add someone
            </h2>
            <button type="button" className="btn-quiet btn-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>

          <form onSubmit={create} className="grid gap-5 p-5 lg:grid-cols-2">
            <p className="plain lg:col-span-2">
              The password is generated here and shown once. Nothing stores it, so if it is lost the
              only way forward is to reset it.
            </p>

            <label className="block">
              <span className="field-label">Username</span>
              <input
                ref={formRef}
                className="field mt-1.5"
                value={fields.username}
                onChange={(e) => set('username', softUsername(e.target.value))}
                placeholder="arthur"
                autoComplete="off"
                spellCheck={false}
                required
                aria-describedby="username-note"
                aria-invalid={fieldErrors.username ? true : undefined}
              />
              <span id="username-note" className="field-note">
                What they type to sign in. Lowercase letters, numbers, dot, dash and underscore.
              </span>
              {fieldErrors.username ? (
                <span className="field-error">{fieldErrors.username}</span>
              ) : null}
            </label>

            <fieldset className="block">
              <legend className="field-label">What they can see</legend>
              <div className="mt-1.5 flex flex-wrap gap-2.5">
                {(
                  [
                    ['affiliate', 'Affiliate: their own links only'],
                    ['lgf_employee', 'LGF - Employee: their own links only'],
                    ['admin', 'Admin: everything, and can add people'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="pill-filter cursor-pointer"
                    data-active={fields.role === value}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={value}
                      checked={fields.role === value}
                      onChange={() => set('role', value)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <span className="field-note">
                {affiliate
                  ? 'A six-character tracking key is generated with the account. It becomes the ?usr= on their links, and it decides which rows they can see.'
                  : 'An admin sees every person’s numbers and is the only role that can create links, record approvals and add people.'}
              </span>
            </fieldset>

            {affiliate ? (
              <fieldset className="block">
                <legend className="field-label">What they are onboarded for</legend>
                <div className="mt-2.5">
                  <ServiceBoxes
                    value={fields.services}
                    onChange={(next) => set('services', next)}
                    disabled={busy === 'create'}
                  />
                </div>
                {fieldErrors.services ? (
                  <span role="alert" className="field-note text-alarm">
                    {fieldErrors.services}
                  </span>
                ) : (
                  <span className="field-note">
                    Tick one or both. You can change this later from their page.
                  </span>
                )}
              </fieldset>
            ) : null}

            <label className="block">
              <span className="field-label">Full name</span>
              <input
                className="field mt-1.5"
                value={fields.fullName}
                onChange={(e) => set('fullName', e.target.value)}
                placeholder="Arthur Reyes"
                autoComplete="off"
              />
              <span className="field-note">Optional. Only used to label them here.</span>
            </label>

            <label className="block">
              <span className="field-label">Email</span>
              <input
                className="field mt-1.5"
                type="email"
                value={fields.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder="arthur@example.com"
                autoComplete="off"
                aria-invalid={fieldErrors.email ? true : undefined}
              />
              <span className="field-note">
                Optional, and nothing is sent to it. The password is handed over by you.
              </span>
              {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
            </label>

            <div className="lg:col-span-2">
              <button
                type="submit"
                className="btn-gold"
                disabled={busy === 'create'}
                aria-busy={busy === 'create'}
              >
                <BusyLabel busy={busy === 'create'} idle="Create account" busyLabel="Creating…" />
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {/* The list */}
      <div className="panel mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-5 py-3.5">
          <div className="min-w-[180px] flex-1">
            <label className="sr-only" htmlFor="account-search">
              Search accounts
            </label>
            <input
              id="account-search"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search a username, name or email…"
              className="field"
            />
          </div>

          <label className="sr-only" htmlFor="account-role">
            Filter accounts by role
          </label>
          <select
            id="account-role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as RoleFilter);
              setPage(1);
            }}
            className="field w-auto"
          >
            <option value="all">All roles</option>
            <option value="admin">{ROLE_LABELS.admin}</option>
            <option value="affiliate">{ROLE_LABELS.affiliate}</option>
            <option value="lgf_employee">{ROLE_LABELS.lgf_employee}</option>
          </select>

          <label className="sr-only" htmlFor="account-status">
            Filter by approval
          </label>
          <select
            id="account-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setPage(1);
            }}
            className="field w-auto"
          >
            <option value="all">Any status</option>
            <option value="waiting">Waiting for review ({waitingCount})</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="bypassed">Bypassed</option>
          </select>

          {/* The primary action sits in the toolbar rather than above it: this
              panel is the whole page, and a button floating over it would have
              nothing to belong to. */}
          <button
            type="button"
            className="btn-gold"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            {adding ? 'Close form' : '+ Add account'}
          </button>
        </div>

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2.5 border-b border-edge bg-paper-card px-5 py-3">
            <span className="text-[13px] font-medium">{selected.size} selected</span>
            <label className="sr-only" htmlFor="bulk-role">
              Role to set
            </label>
            <span className="text-[13px] text-ink-soft">Set role to</span>
            <select
              id="bulk-role"
              className="field w-auto"
              value={bulkRole}
              disabled={busy === 'bulk'}
              onChange={(e) => setBulkRole(e.target.value as PersonRole)}
            >
              {PERSON_ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-gold btn-sm"
              disabled={busy === 'bulk'}
              onClick={applyBulkRole}
            >
              <BusyLabel busy={busy === 'bulk'} idle="Apply" busyLabel="Saving…" />
            </button>
            <button
              type="button"
              className="btn-outline btn-sm"
              disabled={busy === 'bulk'}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        ) : null}

        {notice ? <p className="plain-note border-b border-edge px-5 py-3">{notice}</p> : null}

        {rows.length === 0 ? (
          <p className="px-5 py-16 text-center text-[13px] text-ink-soft">
            Nobody yet. You are signed in as <strong>{viewerUsername}</strong>, which comes from the
            environment rather than from this list.
          </p>
        ) : matched.length === 0 ? (
          <p className="px-5 py-16 text-center text-[13px] text-ink-soft">
            Nothing matches{query ? ` “${query}”` : ''} in this view.
          </p>
        ) : (
          <TableScroller label="Accounts" controlsClassName="px-5 pt-3">
            <table className="w-full min-w-[1300px] border-collapse text-left">
              <thead>
                <tr className="bg-paper-card">
                  <th scope="col" className="w-[56px] border-b border-edge px-2 py-0.5">
                    {/* The whole cell is the target: 44px is what a thumb hits. */}
                    <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        aria-label="Select everyone on this page"
                        checked={pageState === 'all'}
                        ref={(element) => {
                          if (element) element.indeterminate = pageState === 'some';
                        }}
                        disabled={tickable.length === 0 || busy === 'bulk'}
                        onChange={togglePage}
                      />
                    </label>
                  </th>
                  <Th>Username</Th>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Tracking key</Th>
                  <Th>Setup</Th>
                  <Th>Status</Th>
                  <Th>Last sign-in</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const isSelf = row.id === viewerId;
                  const working = busy === row.id;
                  return (
                    <tr key={row.id} className="divider-row last:border-0">
                      <td className="px-2 py-0.5">
                        <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="h-5 w-5"
                            aria-label={
                              isSelf
                                ? 'Your own account cannot be changed in bulk'
                                : `Select ${row.username}`
                            }
                            checked={selected.has(row.id)}
                            disabled={isSelf || busy === 'bulk'}
                            onChange={() => toggle(row.id)}
                          />
                        </label>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="flex items-center gap-2">
                          <span className="tnum text-[13px] font-medium">{row.username}</span>
                          {isSelf ? <span className="chip chip-quiet">You</span> : null}
                        </span>
                      </td>

                      <td className="max-w-[220px] px-5 py-3.5">
                        <span className="block truncate text-[14px]">
                          {row.fullName || <span className="text-ink-dim">No name given</span>}
                        </span>
                        {row.email ? (
                          <span className="mt-0.5 block truncate text-[11px] text-ink-dim">
                            {row.email}
                          </span>
                        ) : null}
                      </td>

                      <td className="px-5 py-3.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={`chip chip-quiet ${row.role === 'admin' ? 'text-ink' : ''}`}
                          >
                            {ROLE_LABELS[personRole(row.role, Boolean(row.lgfEmployee))]}
                          </span>
                          {row.role === 'affiliate' && row.services ? (
                            <ServiceChips services={row.services} />
                          ) : null}
                          {/* Disabled is the state worth interrupting for: the
                              account is still listed and still cannot sign in. */}
                          {row.active ? null : (
                            <span className="chip border-alarm-edge bg-alarm-wash text-alarm">
                              Disabled
                            </span>
                          )}
                        </span>
                      </td>

                      <td className="tnum px-5 py-3.5 text-[12px] text-ink-dim">
                        {row.usr ? `usr=${row.usr}` : 'None'}
                      </td>

                      <td className="px-5 py-3.5">
                        <SetupCell
                          id={row.id}
                          state={row.setup}
                          role={row.role}
                          bypass={row.bypass ?? NO_BYPASS}
                        />
                      </td>

                      <td className="px-5 py-3.5">
                        {row.approval ? (
                          <ApprovalPill approval={row.approval} bypass={row.bypass ?? NO_BYPASS} />
                        ) : null}
                      </td>

                      <td className="tnum px-5 py-3.5 text-[13px] text-ink-dim">
                        {signInDate(row.lastLoginAt)}
                      </td>

                      <td className="whitespace-nowrap px-5 py-2.5 text-right">
                        <span className="inline-flex justify-end gap-1.5">
                          {/*
                            First, and a link rather than a button: it is the
                            only action here that is not destructive and the one
                            most often wanted. The record was reachable before
                            only through the ticks in the Setup column, which is
                            a link nobody reads as "open this person".
                          */}
                          <Link href={`/users/${encodeURIComponent(row.id)}`} className="btn-quiet btn-sm">
                            Details
                          </Link>
                          <button
                            type="button"
                            className="btn-danger btn-sm"
                            disabled={working || isSelf}
                            aria-busy={working && running === 'delete'}
                            title={isSelf ? 'You cannot delete your own account' : undefined}
                            onClick={() => remove(row)}
                          >
                            <BusyLabel
                              busy={working && running === 'delete'}
                              idle="Delete"
                              busyLabel="Deleting…"
                            />
                          </button>
                          {/*
                            Everything else. These are the once-in-a-while
                            actions, and four of them spread across the row made
                            every line something to read rather than scan.
                          */}
                          <RowMenu
                            label={`More actions for ${row.username}`}
                            disabled={working && running === 'delete'}
                            busy={working && running !== 'delete'}
                            busyLabel={
                              running === 'view-as'
                                ? 'Switching'
                                : running === 'reset-password'
                                  ? 'Resetting the password'
                                  : running === 'disable'
                                    ? 'Disabling'
                                    : 'Enabling'
                            }
                          >
                            {(close) => (
                              <>
                                {/*
                                  Affiliates only, and only live ones. An admin
                                  has no separate view to look at, and a disabled
                                  account has no view at all: the API refuses
                                  both, so this is about not offering something
                                  that cannot work.
                                */}
                                {row.role === 'affiliate' && row.active && row.usr ? (
                                  <RowMenuItem
                                    title={`See the app as ${row.username} sees it`}
                                    onClick={() => {
                                      close();
                                      viewAs(row);
                                    }}
                                  >
                                    Client View
                                  </RowMenuItem>
                                ) : null}
                                <RowMenuItem
                                  onClick={() => {
                                    close();
                                    act(row, 'reset-password');
                                  }}
                                >
                                  Reset password
                                </RowMenuItem>
                                {row.active ? (
                                  <RowMenuItem
                                    disabled={isSelf}
                                    title={
                                      isSelf ? 'You cannot disable your own account' : undefined
                                    }
                                    onClick={() => {
                                      close();
                                      act(row, 'disable');
                                    }}
                                  >
                                    Disable
                                  </RowMenuItem>
                                ) : (
                                  <RowMenuItem
                                    onClick={() => {
                                      close();
                                      act(row, 'enable');
                                    }}
                                  >
                                    Enable
                                  </RowMenuItem>
                                )}
                              </>
                            )}
                          </RowMenu>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroller>
        )}

        {/* Nothing to page through when there is nobody: the line above
            already says so, and better than a count of zero would. */}
        {rows.length > 0 ? (
          <Pager
            total={matched.length}
            page={page}
            perPage={perPage}
            onPage={setPage}
            onPerPage={setPerPage}
            label="Accounts"
            note={matched.length === rows.length ? '' : ` · ${rows.length} in total`}
            className="border-t border-edge px-5 py-3"
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Four ticks and a link, rather than "3/4".
 *
 * Which step is outstanding is the useful fact — a missing W-9 stops a payment
 * and a missing bank account stops a different one — and a fraction hides
 * exactly that. Hovering names each one; the link opens the record.
 *
 * A waived account gets two ticks rather than four. Drawing the two waived
 * documents in the red of an outstanding item would put a whole column of
 * accounts in a queue nobody is actually waiting on.
 */
function SetupCell({
  id,
  state,
  role,
  bypass,
}: {
  id: string;
  state: OnboardingState | null;
  role: 'admin' | 'affiliate';
  bypass: Bypass;
}) {
  /* Two different nothings. An admin has no onboarding, which is a fact; an
     affiliate with no state is one the read did not answer for, which is not.
     Printing the first when it is the second is a confident wrong answer. */
  if (!state) {
    return (
      <span className="text-[12px] text-ink-dim">
        {role === 'admin' ? 'Not applicable' : 'Unknown'}
      </span>
    );
  }
  const waived = isBypassed(bypass);
  const steps = stepsFor({ bypassed: waived });
  const done = steps.filter((step) => state[step.key]).length;
  return (
    <Link
      href={`/users/${encodeURIComponent(id)}`}
      className="inline-flex items-center gap-2 hover:underline"
      title={[
        ...steps.map((step) => `${step.label}: ${state[step.key] ? 'done' : 'outstanding'}`),
        ...waivedSteps({ bypassed: waived }).map((step) => `${step.label}: waived`),
      ].join(' · ')}
    >
      <span aria-hidden className="flex gap-[3px]">
        {steps.map((step) => (
          <span
            key={step.key}
            className={`h-[10px] w-[10px] rounded-[2px] ${
              state[step.key]
                ? 'bg-leaf-live'
                : step.required
                  ? 'bg-alarm-edge'
                  : 'bg-edge-strong'
            }`}
          />
        ))}
      </span>
      <span className="tnum text-[12px] text-ink-soft">
        {done}/{steps.length}
      </span>
    </Link>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`label-cap border-b border-edge px-5 py-2.5 text-[10px] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

/**
 * The one and only sight of a new password.
 *
 * Deliberately loud, deliberately dismissible only by choice, and it does not
 * disappear on a re-render: losing it costs a reset, and a person who has just
 * clicked "create" is about to look away to write it down.
 */
const PasswordReveal = function PasswordReveal({
  issued,
  onDismiss,
  ref,
}: {
  issued: Issued;
  onDismiss: () => void;
  ref: React.Ref<HTMLDivElement>;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.password);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard on plain http. The password is on screen and selectable,
      // which is the fallback.
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      /* The one panel in the app with a gold edge. Gold is the highlighter
         everywhere else here, and this is the one thing on the page that has
         to be read before it is scrolled past. */
      className="panel mt-5 border-gold-edge p-5"
    >
      <h2 className="text-[16px]">
        {issued.reason === 'created' ? 'Account created' : 'New password'} for {issued.username}
      </h2>
      <p className="plain mt-2">
        Copy this now and give it to them. It is not stored anywhere and cannot be shown again. If
        it is lost, reset it and hand over a new one.
      </p>

      {issued.usr ? (
        <p className="plain mt-2">
          Their tracking key is{' '}
          <code className="tnum font-semibold text-ink">{issued.usr}</code>. It is already picked
          for them on the create-a-link page, and it stays in the list below.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Selectable text, not an input: there is nothing to edit, and select-all
            is the fallback when the clipboard is unavailable. */}
        <code className="url-box tnum select-all text-[14px] font-semibold tracking-[0.08em]">
          {issued.password}
        </code>
        <button type="button" className="btn-primary" onClick={copy} aria-live="polite">
          {copied ? '✓ Copied' : 'Copy password'}
        </button>
        <button type="button" className="btn-quiet" onClick={onDismiss}>
          I have saved it
        </button>
      </div>
    </div>
  );
};
