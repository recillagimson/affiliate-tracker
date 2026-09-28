import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { accessRole } from '@/lib/roles';
import { statusForError } from '@/lib/store';
import { bulkRoleSchema, fieldErrors } from '@/lib/validate';
import { countAdmins, isEnvAdminId, listUsers, setUserRole, usersEnabled } from '@/lib/users';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Set one role on several people at once, from the People list.
 *
 * The guards are the single-account ones from /api/users/[id], applied to the
 * batch as a whole:
 *
 *   - your own account is skipped, not changed: an admin who ticks "select
 *     all" should not demote themselves by accident, and should not have the
 *     whole batch refused for it either
 *   - a batch that would leave no active admin is refused outright, before
 *     anything is written, because counting after each write would let the
 *     first half of a batch through and stop the second
 *
 * Written one at a time, and a failure part way says who was changed and who
 * was not rather than pretending the batch was all or nothing.
 */
export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can change roles.');
  if (!usersEnabled()) return forbidden('Accounts need a database.');

  let input;
  try {
    input = bulkRoleSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Pick a role and at least one person.', fields: fieldErrors(error) },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  try {
    const accounts = new Map((await listUsers()).map((user) => [user.id, user]));
    const skipped: { name: string; reason: string }[] = [];
    const targets = [];
    for (const id of new Set(input.ids)) {
      const account = accounts.get(id);
      if (!account || isEnvAdminId(id)) {
        skipped.push({ name: id, reason: 'no longer exists' });
      } else if (id === viewer.id) {
        skipped.push({ name: account.username, reason: 'your own account' });
      } else {
        targets.push(account);
      }
    }

    if (accessRole(input.role) !== 'admin') {
      const demoted = targets.filter((account) => account.role === 'admin' && account.active).length;
      if (demoted > 0 && (await countAdmins()) - demoted < 1) {
        return forbidden('That would leave no active admin. Keep at least one admin out of this change.');
      }
    }

    let updated = 0;
    for (const account of targets) {
      try {
        await setUserRole(account.id, input.role);
        updated += 1;
      } catch (error) {
        skipped.push({
          name: account.username,
          reason: error instanceof Error ? error.message : 'did not save',
        });
      }
    }

    return NextResponse.json({ updated, skipped });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not change the roles' },
      { status: statusForError(error) },
    );
  }
}
