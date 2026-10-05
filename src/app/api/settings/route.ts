import { NextResponse } from 'next/server';
import { requireApiAdmin } from '@/lib/api-auth';
import {
  DEFAULT_SHARE,
  defaultSettings,
  floorFrom,
  isCardKey,
  normaliseShares,
  rateFromPercent,
  shareProblems,
  withCardStatus,
  type Settings,
} from '@/lib/settings';
import { getStore, statusForError } from '@/lib/store';

/**
 * The two shared settings: what an affiliate keeps, and how little a card may
 * pay before it stops being listed.
 *
 * Admin only, and the commission is why. It decides what every person on the
 * team is paid for every approval, which makes it the single most consequential
 * value in this application.
 *
 * Three separate actions rather than one "save the settings" body, and that is
 * deliberate. A whole-object save means a form that has been open in a tab
 * since this morning can put back a rate history that has since been added to,
 * and the thing it would quietly undo is a commission change. Each action here
 * reads the current settings, does one thing to them, and writes them back.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can change the settings.');
  if ('response' in gate) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const store = getStore();
  let current: Settings;
  try {
    current = await store.readSettings();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read the settings.' },
      { status: statusForError(error) },
    );
  }

  const action = String(body.action ?? '');
  let next: Settings;

  if (action === 'add-share') {
    const change = { percent: Number(body.percent), from: String(body.from ?? '') };
    const problems = shareProblems(change, current.shares);
    if (Object.keys(problems).length > 0) {
      return NextResponse.json(
        { error: 'Please check the highlighted fields.', fields: problems },
        { status: 422 },
      );
    }
    next = {
      ...current,
      shares: normaliseShares([...current.shares, { from: change.from, rate: rateFromPercent(change.percent)! }]),
    };
  } else if (action === 'remove-share') {
    const from = String(body.from ?? '');
    /*
     * Only a rate that has not started yet, and never the opening one.
     *
     * Removing a rate that is already in force would reprice every approval it
     * covers, which is the exact thing the dating exists to prevent. A rate set
     * for next month and typed wrong is a different matter: nothing has been
     * approved under it, so there is nothing to restate.
     */
    const today = new Date().toISOString().slice(0, 10);
    if (!from) {
      return NextResponse.json(
        { error: 'The opening rate cannot be removed. Every approval needs a rate to be read at.' },
        { status: 422 },
      );
    }
    if (from <= today) {
      return NextResponse.json(
        {
          error: 'That rate is already in force.',
          hint:
            'Removing it would change what approvals already recorded under it are worth. Set a ' +
            'new rate from a future date instead.',
        },
        { status: 422 },
      );
    }
    next = { ...current, shares: normaliseShares(current.shares.filter((entry) => entry.from !== from)) };
  } else if (action === 'floor') {
    next = { ...current, cpaFloor: floorFrom(body.floor as string | number | null) };
  } else if (action === 'card-status') {
    // Marking one card on the rate card Inactive, or active again.
    if (!isCardKey(body.card)) {
      return NextResponse.json({ error: 'Which card?' }, { status: 422 });
    }
    next = { ...current, inactiveCards: withCardStatus(current.inactiveCards, body.card, body.inactive === true) };
  } else {
    return NextResponse.json(
      { error: 'No such setting.', hint: 'Expected add-share, remove-share, floor or card-status.' },
      { status: 400 },
    );
  }

  next = { ...next, updatedAt: new Date().toISOString(), updatedBy: gate.viewer.username };

  try {
    await store.writeSettings(next);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not save the settings.' },
      { status: statusForError(error) },
    );
  }

  return NextResponse.json({ ok: true, settings: next });
}

/** What is in force now, for a page that wants to read it without a store. */
export async function GET(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can read the settings.');
  if ('response' in gate) return gate.response;
  try {
    return NextResponse.json({ settings: await getStore().readSettings() });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Could not read the settings.',
        settings: { ...defaultSettings(), shares: [{ from: '', rate: DEFAULT_SHARE }] },
      },
      { status: statusForError(error) },
    );
  }
}
