import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getStore, statusForError } from '@/lib/store';
import { fieldErrors, submissionPatchSchema } from '@/lib/validate';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

/**
 * Admin-side updates to a captured lead — currently just its status.
 *
 * Deliberately NOT under /api/submissions: that path is the public capture
 * endpoint and is excluded from the auth matcher on purpose. Hanging an
 * authenticated route off it would mean either leaving this one open or gating
 * the form the whole tool depends on.
 *
 * Admin only. An affiliate can see their own leads but not change them, which
 * is the conservative reading of "sees only their own": marking a lead
 * registered moves a number the payout conversation is had over, so for now the
 * person paying signs it off. Letting affiliates set the status on their own
 * rows would mean loading the submission, comparing its `usr` with the viewer's
 * key, and refusing on mismatch — the check exists as `ownsKey` in lib/scope.ts,
 * so it is a short change if that turns out to be the workflow you want.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can change a lead.');

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  let patch;
  try {
    patch = submissionPatchSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          // The refusal for approved says where to go instead; anything else
          // is a word that is not a status at all.
          error:
            error.issues.find((issue) => issue.code === 'custom')?.message ??
            'That is not a status we recognise.',
          fields: fieldErrors(error),
        },
        { status: 422 },
      );
    }
    throw error;
  }

  try {
    const submission = await getStore().updateSubmission(id, patch);
    return NextResponse.json({ submission });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update the lead' },
      { status: statusForError(error) },
    );
  }
}
