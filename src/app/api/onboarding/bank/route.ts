import { NextResponse } from 'next/server';
import { actorFor, invalid, jsonBody, nextPath, noteSubmission, storeResponse, str } from '@/lib/onboarding-api';
import { bankProblems, keepsAccountNumber } from '@/lib/onboarding';
import { readBank, saveBank } from '@/lib/onboarding-store';
import { secretsConfigured } from '@/lib/secret-box';

export const dynamic = 'force-dynamic';

/**
 * Step 4: the ACH destination.
 *
 * Upserts, so this is also "change my bank" — people move banks, and the
 * alternative is an admin editing a row by hand.
 */
export async function POST(request: Request) {
  const gate = await actorFor(request, 'bank');
  if ('response' in gate) return gate.response;
  const { viewer, state, approval, bypass } = gate;

  if (!secretsConfigured()) {
    return NextResponse.json(
      {
        error:
          'This deployment cannot accept bank details yet: ONBOARDING_SECRET_KEY is not set. ' +
          'Tell your admin. Nothing you typed has been stored.',
      },
      { status: 503 },
    );
  }

  const body = await jsonBody(request);
  if (body && typeof body === 'object' && 'response' in body) {
    return (body as { response: NextResponse }).response;
  }

  const input = {
    accountName: str(body, 'accountName'),
    bankName: str(body, 'bankName'),
    routingNumber: str(body, 'routingNumber'),
    accountNumber: str(body, 'accountNumber'),
  };

  // Same rule as the W-9: whether there is something to keep is the database's
  // answer, not the browser's. Read even when the step is not done: a row saved
  // before routing numbers were asked for leaves the step open, and its owner
  // should not have to retype the account number just to add one.
  let accountOnFile = false;
  try {
    accountOnFile = Boolean(await readBank(viewer.id));
  } catch (error) {
    return storeResponse(error);
  }

  const problems = bankProblems(input, { accountOnFile });
  if (Object.keys(problems).length > 0) return invalid(problems);

  try {
    await saveBank(viewer.id, {
      ...input,
      accountNumber: keepsAccountNumber(input, { accountOnFile }) ? '' : input.accountNumber,
    });
  } catch (error) {
    return storeResponse(error);
  }

  await noteSubmission(viewer.id, state, 'bank');

  return NextResponse.json({ ok: true, next: nextPath(state, 'bank', approval, bypass) });
}
