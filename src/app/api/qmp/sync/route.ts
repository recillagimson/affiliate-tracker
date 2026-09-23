import { NextResponse } from 'next/server';
import { fetchQmpReport, QmpError, qmpConfig } from '@/lib/qmp';
import {
  applicationsByLead,
  leadUpdateKind,
  leadUpdates,
  planManualSwaps,
  planSync,
  writeLeadUpdates,
  type LeadUpdate,
  type LeadUpdateKind,
} from '@/lib/qmp-sync';
import { clientIndex, nameIndex, UNKNOWN_CLIENT } from '@/lib/analytics';
import { listCommittedConversionIds, payoutsEnabled } from '@/lib/payout-request-store';
import { announceSync } from '@/lib/slack';
import { getStore, statusForError, StoreNotFoundError } from '@/lib/store';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

/**
 * Copy a QMP report's approvals into Ledger.
 *
 * Two things about the shape of this, both deliberate:
 *
 * The rows are fetched here rather than accepted from the browser. The client
 * has already seen them, so posting them back would be convenient, but it
 * would mean a page could write any approval and any amount it liked into the
 * money record. The server asks QMP itself.
 *
 * Nothing is written unless `apply` is true. The default is a plan: what would
 * be created, what was already imported, and what could not be resolved. A
 * sync that writes on the first click is a sync nobody reads the output of.
 *
 * The leads come along after the money. One the report shows applying moves to
 * applied, one an approval names moves to approved, and each gets the card it
 * applied for. The rules are leadUpdates' in lib/qmp-sync.
 *
 * An approval an admin recorded by hand with Approve is swapped for QMP's when
 * the report brings it: QMP's is written and the manual one deleted, so it is
 * counted once, at what the merchant paid. One already on a payout request is
 * kept, and QMP's is not written. The rules are planManualSwaps'.
 */

export const dynamic = 'force-dynamic';

/** How many of each kind, in the shape both the plan and the result report. */
function countKinds(updates: LeadUpdate[]): Record<LeadUpdateKind, number> {
  const counts: Record<LeadUpdateKind, number> = { registered: 0, applied: 0, card: 0 };
  for (const update of updates) counts[leadUpdateKind(update)] += 1;
  return counts;
}

export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  // This one writes approvals for every affiliate at once, so it is the most
  // consequential button in the app and the least ambiguous admin gate.
  if (viewer.role !== 'admin') return forbidden('Only an admin can sync approvals.');

  const config = qmpConfig();
  if (!config.ready) {
    return NextResponse.json(
      {
        error: config.configured ? 'No report is configured.' : 'QMP is not configured.',
        hint: 'Set QMP_API_KEY, QMP_API_SECRET and REPORT_ID in .env.local.',
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const { startDate, endDate, apply } = (body ?? {}) as Record<string, unknown>;

  let report;
  try {
    report = await fetchQmpReport({
      reportKey: config.reportId,
      startDate: typeof startDate === 'string' ? startDate : '',
      endDate: typeof endDate === 'string' ? endDate : '',
      config,
    });
  } catch (error) {
    if (error instanceof QmpError) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
      return NextResponse.json({ error: error.message, hint: error.hint }, { status });
    }
    throw error;
  }

  const store = getStore();
  let links;
  let existing;
  let submissions;
  let committed: Set<string>;
  try {
    [links, existing, submissions, committed] = await Promise.all([
      store.listLinks(),
      store.listConversions(),
      // Two jobs: a name beside each planned row, and the leads the report and
      // the approvals move along. Nothing about which approvals get written
      // depends on either.
      store.listSubmissions(),
      // Which approvals a payout request holds, so a manual one that has been
      // asked for is not swapped out from under it. No database, no requests.
      payoutsEnabled() ? listCommittedConversionIds() : Promise.resolve(new Set<string>()),
    ]);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read the current data.' },
      { status: statusForError(error) },
    );
  }

  const plan = planSync({
    rows: report.table.rows,
    reportKey: config.reportId,
    links,
    existing,
    defaultSlug: (process.env.QMP_DEFAULT_SLUG || '').trim(),
  });

  // What is actually written: the plan less every approval a manual one on a
  // payout request already stands for.
  const swaps = planManualSwaps({ create: plan.create, existing, committed });
  const keptMarkers = new Set(swaps.kept.map((swap) => swap.marker));
  const replacing = new Map(swaps.replace.map((swap) => [swap.marker, swap.manualId]));
  const toWrite = plan.create.filter((row) => !keptMarkers.has(row.marker));

  /*
   * What the report and the approvals say about the leads behind them.
   *
   * The approvals are every one on file, the ones this run would write as well
   * as everything imported before it, so a run with nothing left to import
   * still catches up the leads it never marked. The applications are read off
   * every row of the report, including rows whose var2 matches no link: the
   * money follows var2, but var3 is what names the lead. var3 is text the
   * visitor could have edited, so what it moves is a label on a lead and never
   * money; applicationsByLead says what that trust covers and what it cannot.
   */
  const applications = applicationsByLead(report.table.rows);
  const updates = leadUpdates({ conversions: [...existing, ...toWrite], applications, submissions });
  const planned = countKinds(updates);

  const summary = {
    reportRows: report.table.rowCount,
    rowsWithApprovals: plan.rowsWithApprovals,
    totalApprovals: plan.totalApprovals,
    totalEarnings: plan.totalEarnings,
    toCreate: toWrite.length,
    // Money about to be written, which is the number worth reading twice.
    amountToCreate: Math.round(toWrite.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
    alreadyImported: plan.skipped,
    /** Approvals recorded by hand that QMP's own replace. */
    manualToReplace: swaps.replace.length,
    /** QMP approvals not written because a manual one on a payout request stands for them. */
    manualKept: swaps.kept.length,
    issues: plan.issues,
    unusable: plan.unusable,
    shape: report.table.shape,
    /** Leads moving to approved: an approval names them and they do not read approved yet. */
    leadsToMark: planned.registered,
    /** Leads moving to applied: the report shows an application and no approval names them. */
    leadsToApply: planned.applied,
    /** Leads whose status stands and which only gain a card. */
    cardsToRecord: planned.card,
  };

  if (apply !== true) {
    const clients = clientIndex(submissions);
    // Whose row it is, in the name their links carry rather than the tracking
    // key those links are matched on. The same index the result table above
    // reads, so one person cannot be two different things on one screen.
    const names = nameIndex(links);
    return NextResponse.json({
      applied: false,
      ...summary,
      // A sample rather than the whole plan: enough to see it is right. Both
      // names are for display only — the tracking key is what actually gets
      // written — and a dash where var3 names nobody is a normal state rather
      // than a reason to hold the row back. A key with no name behind it falls
      // back to the key: better a code you can look up than a blank.
      preview: toWrite.slice(0, 25).map((row) => ({
        ...row,
        replacesManual: replacing.has(row.marker),
        person: names.get(row.usr) ?? row.usr,
        client: clients.get(row.leadRef) ?? UNKNOWN_CLIENT,
      })),
    });
  }

  // Written one at a time on purpose. The Sheets adapter appends, and firing
  // these concurrently is how two rows end up on the same line.
  let created = 0;
  let replaced = 0;
  const failures: string[] = [];
  for (const row of toWrite) {
    try {
      /*
       * The manual approval goes first. If writing QMP's then fails, the lead
       * is short an approval until the next sync writes it, which it will,
       * since nothing marks it imported. The other order would leave both on
       * file after a failed delete, and the next sync would skip QMP's as
       * imported and never come back for the manual one: paid twice, quietly.
       */
      const manualId = replacing.get(row.marker);
      if (manualId) {
        try {
          await store.deleteConversion(manualId);
        } catch (error) {
          // Already gone, removed by hand since the plan was read: nothing to swap.
          if (!(error instanceof StoreNotFoundError)) throw error;
        }
      }
      await store.addConversion({
        slug: row.slug,
        usr: row.usr,
        approvedOn: row.approvedOn,
        amount: row.amount,
        notes: row.notes,
      });
      created += 1;
      if (manualId) replaced += 1;
    } catch (error) {
      failures.push(
        `${row.approvedOn} ${row.slug}: ${error instanceof Error ? error.message : 'failed'}`,
      );
      // Stop at the first failure. Ploughing on would leave the run half
      // applied in a way nobody can reason about, and the markers make a
      // second run safe.
      break;
    }
  }

  /*
   * The leads, after the money. In that order because the approval is the
   * record that matters: if updating a lead fails, the payout is still written
   * and correct, and the next sync will try the lead again. The reverse would
   * leave a lead marked approved against an approval that never landed.
   *
   * For the same reason the moves are worked out again from what did land when
   * the run stopped short. The approvals are written in plan order and the
   * loop stops at the first failure, so what landed is the first `created` of
   * them. One that was never written vouches for nobody; its lead keeps what
   * the report alone says, applied at most, until a sync that writes it.
   *
   * A failure here is collected rather than thrown for the same reason. It is
   * a status on a row nobody is paid from. A store that cannot take the write
   * at all, such as a database whose migrations are behind the code, is said
   * once rather than once per lead: see writeLeadUpdates.
   */
  const landed =
    created === toWrite.length
      ? updates
      : leadUpdates({
          conversions: [...existing, ...toWrite.slice(0, created)],
          applications,
          submissions,
        });
  const leads = await writeLeadUpdates(landed, (update) =>
    store.updateSubmission(update.id, { status: update.status, card: update.card }),
  );
  failures.push(...leads.failures);

  /*
   * Slack last of all, and only about what actually landed: the approvals
   * written by this run, in the order they were written, then one summary.
   * It cannot throw (see lib/slack) and it cannot change what was recorded —
   * by this point everything is on file either way. A refusal is reported
   * beside the run's own failures rather than instead of them.
   */
  const names = nameIndex(links);
  const clients = clientIndex(submissions);
  const slackProblem = await announceSync(
    toWrite.slice(0, created).map((row) => ({
      person: names.get(row.usr) ?? row.usr,
      card: row.card,
      client: clients.get(row.leadRef) === UNKNOWN_CLIENT ? '' : (clients.get(row.leadRef) ?? ''),
      approvedOn: row.approvedOn,
      source: 'sync' as const,
    })),
    leads.written.registered,
  );

  return NextResponse.json({
    applied: true,
    ...summary,
    created,
    replaced,
    failures,
    /** '' when Slack is off or every message landed. */
    slackProblem,
    leadsMarked: leads.written.registered,
    leadsApplied: leads.written.applied,
    cardsRecorded: leads.written.card,
  });
}
