import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { PersonRole } from '@/lib/roles';
import { statusForError } from '@/lib/store';
import { fieldErrors, userPatchSchema } from '@/lib/validate';
import {
  countAdmins,
  deleteUser,
  findUserById,
  isEnvAdminId,
  resetUserPassword,
  setUserActive,
  setUserRole,
  usersEnabled,
} from '@/lib/users';
import { forbidden, unauthorized, viewerFromRequest } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * The guards that stop an admin locking everybody out.
 *
 * Two separate hazards, and they need different answers:
 *
 *   - Disabling or deleting *yourself* takes effect on your very next request,
 *     so you would be signed out mid-action with no way back except the
 *     environment account. Refused outright.
 *   - Removing the *last* admin leaves an app that nobody can administer.
 *     Refused too, even when ADMIN_USER/ADMIN_PASSWORD is configured and could
 *     rescue it: relying on a break-glass credential to undo a normal button
 *     press is not a design, it is a hope.
 */
async function blockedReason(
  action: 'reset-password' | 'enable' | 'disable' | 'set-role',
  targetId: string,
  target: { role: string; active: boolean },
  viewerId: string,
  newRole?: PersonRole,
): Promise<string | null> {
  const isSelf = targetId === viewerId;

  if (isSelf && action === 'disable') {
    return 'You cannot disable your own account. Ask another admin.';
  }

  // The same hazard as disabling yourself: an admin who makes themselves an
  // affiliate loses this page on their next request.
  if (isSelf && action === 'set-role') {
    return 'You cannot change your own role. Ask another admin.';
  }

  if (action === 'set-role' && newRole !== 'admin' && target.role === 'admin' && target.active) {
    const admins = await countAdmins();
    if (admins <= 1) {
      return 'That is the last active admin. Make somebody else an admin first, then change this one.';
    }
  }

  // Enabling never reduces the number of admins, and resetting a password
  // leaves the account intact, so only disable has to count.
  if (action === 'disable' && target.role === 'admin' && target.active) {
    const admins = await countAdmins();
    if (admins <= 1) {
      return 'That is the last active admin. Create another admin first, then disable this one.';
    }
  }

  return null;
}

export async function PATCH(request: Request, { params }: Context) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can change accounts.');
  if (!usersEnabled()) return forbidden('Accounts need a database.');

  const { id } = await params;
  if (isEnvAdminId(id)) {
    return forbidden(
      'The built-in admin lives in the environment, not the database. Change ADMIN_PASSWORD to alter it.',
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  let patch;
  try {
    patch = userPatchSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'That is not something we can do to an account.', fields: fieldErrors(error) },
        { status: 422 },
      );
    }
    throw error;
  }

  try {
    const target = await findUserById(id);
    if (!target) {
      return NextResponse.json({ error: 'That account no longer exists.' }, { status: 404 });
    }

    const blocked = await blockedReason(
      patch.action,
      id,
      target,
      viewer.id,
      patch.action === 'set-role' ? patch.role : undefined,
    );
    if (blocked) return forbidden(blocked);

    if (patch.action === 'set-role') {
      const user = await setUserRole(id, patch.role);
      return NextResponse.json({ user, role: patch.role });
    }

    if (patch.action === 'reset-password') {
      const { user, password } = await resetUserPassword(id);
      // Shown once. Resetting also retires every session that account had, so
      // whoever was signed in as them is now signed out.
      return NextResponse.json({ user, password });
    }

    const user = await setUserActive(id, patch.action === 'enable');
    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update the account' },
      { status: statusForError(error) },
    );
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();
  if (viewer.role !== 'admin') return forbidden('Only an admin can delete accounts.');
  if (!usersEnabled()) return forbidden('Accounts need a database.');

  const { id } = await params;
  if (isEnvAdminId(id)) {
    return forbidden('The built-in admin lives in the environment and cannot be deleted here.');
  }
  if (id === viewer.id) {
    return forbidden('You cannot delete your own account. Ask another admin.');
  }

  try {
    const target = await findUserById(id);
    if (!target) {
      return NextResponse.json({ error: 'That account no longer exists.' }, { status: 404 });
    }

    if (target.role === 'admin' && target.active) {
      const admins = await countAdmins();
      if (admins <= 1) {
        return forbidden(
          'That is the last active admin. Create another admin first, then delete this one.',
        );
      }
    }

    await deleteUser(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete the account' },
      { status: statusForError(error) },
    );
  }
}
