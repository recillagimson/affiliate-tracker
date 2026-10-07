import { NextResponse } from 'next/server';
import { requireApiAdmin } from '@/lib/api-auth';
import { asBody, readRowId, storeFailure, type Refusal } from '@/lib/payout-api';
import {
  isIssuerKey,
  MAX_PASTE_ROWS,
  readTradelineInput,
  type TradelineInput,
} from '@/lib/tradelines';
import {
  addTradelines,
  deleteTradeline,
  replaceTradelines,
  updateTradeline,
} from '@/lib/tradelines-store';

/**
 * Keeping the tradelines table: admins only, every action.
 *
 * Four actions on one POST. `add` puts one tradeline in an issuer's table,
 * `update` changes one, `delete` removes one, and `import` takes a list that
 * the page read out of a pasted spreadsheet and either adds it to an issuer's
 * table or replaces that table with it.
 *
 * The page has already read and checked a paste before it sends anything, so
 * the admin can see what will happen first. None of that is trusted here:
 * every row is read again with the same function (lib/tradelines.ts), and a
 * list with one row that does not pass is refused whole, naming the row,
 * rather than saved without it.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can change the tradelines table.');
  if ('response' in gate) return gate.response;
  const by = gate.viewer.username;

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return refuse({ status: 400, error: 'Expected a JSON body.' });
  }

  try {
    if (body.action === 'delete') {
      const id = readRowId(body.id);
      if (!id) return refuse({ status: 400, error: 'Which tradeline?' });
      // Already gone is the outcome that was asked for.
      await deleteTradeline(id);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'update') {
      const id = readRowId(body.id);
      if (!id) return refuse({ status: 400, error: 'Which tradeline?' });
      const read = readTradelineInput(body, today());
      if (!read.ok) return refuse({ status: 400, error: 'Please fix the highlighted fields.', fields: read.fields });
      await updateTradeline(id, read.value, by);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'add' || body.action === 'import') {
      if (!isIssuerKey(body.issuer)) return refuse({ status: 400, error: 'Which issuer is this for?' });

      if (body.action === 'add') {
        const read = readTradelineInput(body, today());
        if (!read.ok) return refuse({ status: 400, error: 'Please fix the highlighted fields.', fields: read.fields });
        await addTradelines(body.issuer, [read.value], by);
        return NextResponse.json({ ok: true, count: 1 }, { status: 201 });
      }

      const mode = body.mode === 'replace' ? 'replace' : body.mode === 'add' ? 'add' : null;
      if (!mode) return refuse({ status: 400, error: 'Add these rows, or replace the table with them?' });
      const list = Array.isArray(body.rows) ? body.rows : null;
      if (!list || list.length === 0) return refuse({ status: 400, error: 'There are no rows to save.' });
      if (list.length > MAX_PASTE_ROWS) {
        return refuse({ status: 400, error: `Only ${MAX_PASTE_ROWS} rows can be saved at a time.` });
      }
      const rows: TradelineInput[] = [];
      for (let index = 0; index < list.length; index++) {
        const read = readTradelineInput(list[index], today());
        if (!read.ok) {
          return refuse({
            status: 400,
            error: `Row ${index + 1} could not be saved: ${Object.values(read.fields)[0]}`,
            hint: 'Nothing was saved. Fix that row and try again.',
          });
        }
        rows.push(read.value);
      }
      const count = mode === 'replace' ? await replaceTradelines(body.issuer, rows, by) : await addTradelines(body.issuer, rows, by);
      return NextResponse.json({ ok: true, count }, { status: 201 });
    }

    return refuse({ status: 400, error: 'No such action.', hint: 'Expected add, update, delete or import.' });
  } catch (error) {
    const refusal = storeFailure(error, 'That did not save.', { showUnknown: true });
    if (refusal.status >= 500) console.error('tradelines', error);
    return refuse(refusal);
  }
}
