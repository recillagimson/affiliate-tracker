import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isLeadId, newLeadId } from '@/lib/lead-id';
import { manualApprovalNotes } from '@/lib/manual-approval';
import { approvedLeadIds, mergeCards } from '@/lib/qmp-sync';
import { announceApproval } from '@/lib/slack';
import { getStore, statusForError } from '@/lib/store';
import { fieldErrors, manualApprovalSchema } from '@/lib/validate';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

/**
 * Approve a lead by hand: record the approval, at the card's rate, against the
 * link the lead came through, and mark the lead approved with that card.
 *
 * The lead supplies the slug and usr, so the money lands with the person whose
 * link it was. The approval's notes carry the card and the lead the way a
 * synced one does, plus a manual marker, so the lead reads approved from it and
 * the report sync can swap it for QMP's own once that arrives.
 *
 * Admin only, for the reason /api/leads/[id] is: this writes money.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can approve a lead.');

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  let input;
  try {
    input = manualApprovalSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? 'Check the approval', fields: fieldErrors(error) },
        { status: 422 },
      );
    }
    throw error;
  }

  const store = getStore();
  try {
    const [submissions, conversions] = await Promise.all([store.listSubmissions(), store.listConversions()]);
    const lead = submissions.find((row) => row.id === id);
    if (!lead) return NextResponse.json({ error: 'That lead no longer exists.' }, { status: 404 });

    // The notes name the lead by its reference. A lead captured before
    // references existed has a uuid, which the tag cannot carry, so the
    // approval would name nobody and the lead would never read approved.
    if (!isLeadId(lead.id)) {
      return NextResponse.json(
        { error: 'This lead has no reference to tie an approval to. Use Record an approval instead.' },
        { status: 422 },
      );
    }

    // One click that lands twice, or two admins at once, is one approval.
    if (approvedLeadIds(conversions).has(lead.id)) {
      return NextResponse.json({ error: 'This lead already has an approval.' }, { status: 409 });
    }

    const conversion = await store.addConversion({
      slug: lead.slug,
      usr: lead.usr,
      approvedOn: input.approvedOn,
      amount: input.amount,
      notes: manualApprovalNotes(input.card, lead.id, newLeadId()),
    });

    /*
     * The lead after the money, as the sync does it. The approval already
     * makes the lead read approved and shows its card; writing both onto the
     * lead is so the sheet's columns say the same. If it fails, nobody is paid
     * wrong, so it is not an error for the request.
     */
    try {
      await store.updateSubmission(lead.id, {
        status: 'registered',
        card: mergeCards(lead.card, [input.card]),
      });
    } catch {
      // Left for the next sync, which writes it from the approval.
    }

    /*
     * After the money and after the lead, for the reason given in lib/slack:
     * nothing about announcing an approval may put recording one at risk.
     * The card is the one just picked, and the client is the lead itself,
     * which is the whole point of approving from this list.
     */
    await announceApproval({
      person: lead.assignee,
      card: input.card,
      client: lead.fullName || lead.email,
      approvedOn: input.approvedOn,
      source: 'manual',
    });

    return NextResponse.json({ conversion }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not approve that lead' },
      { status: statusForError(error) },
    );
  }
}
