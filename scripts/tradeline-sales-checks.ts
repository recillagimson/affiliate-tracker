// What an affiliate has made from tradelines: their income and what is still
// owed to them.
//
// There is no tradelines checkout yet, so nothing has been sold and there is
// nothing to add up. What is pinned is that the summary says exactly that, for
// everybody, rather than a number somebody might take for money: nought earned,
// nought pending, no checkouts. When the checkout is built this is the one
// function that changes, and these are the checks that will have to change
// with it.
//
//   npx tsx scripts/tradeline-sales-checks.ts

import { NO_TRADELINE_SALES, tradelineSummaryFor } from '../src/lib/tradeline-sales';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

async function main() {
  console.log('- before there is a checkout -');
  const summary = await tradelineSummaryFor('TL-48213');
  check('nobody has an income', summary.income === 0, summary);
  check('nobody is owed anything', summary.pendingPayout === 0, summary);
  check('nobody has a checkout', summary.checkouts === 0, summary);
  const none = await tradelineSummaryFor('');
  check('somebody with no reference number reads the same', none.income === 0 && none.pendingPayout === 0 && none.checkouts === 0);
  check('that is what no sales looks like', NO_TRADELINE_SALES.income === 0 && NO_TRADELINE_SALES.pendingPayout === 0 && NO_TRADELINE_SALES.checkouts === 0);
  check('each asker gets their own, so one cannot change another', summary !== none && summary !== NO_TRADELINE_SALES);

  console.log(`\ntradeline-sales: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
