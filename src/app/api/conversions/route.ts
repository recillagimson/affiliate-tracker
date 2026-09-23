import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { announceApproval } from '@/lib/slack';
import { getStore, statusForError } from '@/lib/store';
import { conversionInputSchema, fieldErrors } from '@/lib/validate';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

/**
 * Approved applications and what they paid. Admin only: this route decides who
 * is owed how much, so it is checked here as well as in the middleware.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can record an approval.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  let input;
  try {
    input = conversionInputSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Please check the highlighted fields.', fields: fieldErrors(error) },
        { status: 422 },
      );
    }
    throw error;
  }

  try {
    const store = getStore();
    const conversion = await store.addConversion(input);

    /*
     * Announced after it is written, and never in front of it: a channel that
     * missed a message is a nuisance, an approval refused because Slack was
     * slow is money nobody recorded. announceApproval swallows its own
     * failures, so this cannot throw.
     *
     * The person and the card come from the link the approval was filed
     * against, the same way every screen reads them, so Slack cannot name a
     * card the dashboard does not.
     */
    const links = await store.listLinks().catch(() => []);
    const link = links.find((row) => row.slug === conversion.slug && row.usr === conversion.usr);
    await announceApproval({
      person: link?.assignee ?? '',
      card: link?.campaign ?? '',
      client: '',
      approvedOn: conversion.approvedOn,
      source: 'manual',
    });

    return NextResponse.json({ conversion }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to record the approval' },
      { status: statusForError(error) },
    );
  }
}
