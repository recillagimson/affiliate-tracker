/**
 * What Ledger says in Slack when an approval lands: the wording, what it
 * deliberately leaves out, and the cap that keeps a backlog sync from filling
 * a channel.
 *
 *   npx tsx scripts/slack-checks.ts
 */
import {
  approvalMessage,
  SLACK_MESSAGE_CAP,
  syncMessages,
  type ApprovalAnnouncement,
} from '../src/lib/slack-messages';
import { announce, slackConfigured } from '../src/lib/slack';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

const one: ApprovalAnnouncement = {
  person: 'Gimson Recilla',
  campaign: 'Best Cards',
  card: 'Chase Freedom Unlimited(R)',
  client: 'Jefferson Florez',
  approvedOn: '2026-09-23',
  source: 'manual',
};

console.log('— one approval —');
check(
  'the heading, the affiliate, the card line and the day',
  approvalMessage(one),
  '*LEDGER - AFFILIATE APPROVAL* 🎉\n' +
    '*Affiliate Name:* Gimson Recilla\n' +
    '*CARD:* Best Cards | Client Jefferson Florez · Chase Freedom Unlimited(R)\n' +
    '*Approved:* 23 Sept 2026',
);
check(
  'an imported one reads exactly the same: where it came from is not news to a channel',
  approvalMessage({ ...one, source: 'sync' }),
  approvalMessage(one),
);
check(
  'no client on record leaves the campaign and the card',
  approvalMessage({ ...one, client: '' }),
  '*LEDGER - AFFILIATE APPROVAL* 🎉\n' +
    '*Affiliate Name:* Gimson Recilla\n' +
    '*CARD:* Best Cards | Chase Freedom Unlimited(R)\n' +
    '*Approved:* 23 Sept 2026',
);
check(
  'no card on record leaves the campaign and the client',
  approvalMessage({ ...one, card: '' }),
  '*LEDGER - AFFILIATE APPROVAL* 🎉\n' +
    '*Affiliate Name:* Gimson Recilla\n' +
    '*CARD:* Best Cards | Client Jefferson Florez\n' +
    '*Approved:* 23 Sept 2026',
);
check(
  'nothing to put on the card line drops the line rather than printing a label with nothing after it',
  approvalMessage({ ...one, campaign: '', card: '', client: '' }),
  '*LEDGER - AFFILIATE APPROVAL* 🎉\n*Affiliate Name:* Gimson Recilla\n*Approved:* 23 Sept 2026',
);
check(
  'a key with nobody behind it is named, not left as a gap',
  approvalMessage({ ...one, person: '' }).split('\n')[1],
  '*Affiliate Name:* Unassigned',
);

console.log('\n— what it never says —');
const money = [approvalMessage(one), ...syncMessages([{ ...one, source: 'sync' }], 3)].join('\n');
check('no amount, no share, no percentage', /\$|payout|share|commission|%/i.test(money), false);

console.log('\n— a sync —');
const many = (count: number): ApprovalAnnouncement[] =>
  Array.from({ length: count }, (_, index) => ({
    ...one,
    source: 'sync' as const,
    person: `Person ${index + 1}`,
  }));

check('nothing imported says nothing at all', syncMessages([], 0), []);
check(
  'one import is its own message, then the summary',
  syncMessages(many(1), 2),
  [
    approvalMessage({ ...one, source: 'sync', person: 'Person 1' }),
    'QMP sync: 1 approval imported, 2 leads marked approved.',
  ],
);
check(
  'a lead count of none is left out of the summary',
  syncMessages(many(1), 0).at(-1),
  'QMP sync: 1 approval imported.',
);
check(
  'and the plural agrees',
  syncMessages(many(2), 1).at(-1),
  'QMP sync: 2 approvals imported, 1 lead marked approved.',
);

const capped = syncMessages(many(SLACK_MESSAGE_CAP + 12), 0);
check(
  'past the cap the rest are one line, not a message each',
  capped.length,
  SLACK_MESSAGE_CAP + 2,
);
check('the ones it does name are the first of them', capped[0]!.includes('Person 1'), true);
check('the line says how many were left out', capped.at(-2), '…and 12 more.');
check(
  'and the summary still counts every one',
  capped.at(-1),
  `QMP sync: ${SLACK_MESSAGE_CAP + 12} approvals imported.`,
);
check(
  'exactly at the cap nothing is left out',
  syncMessages(many(SLACK_MESSAGE_CAP), 0).some((line) => line.includes('more.')),
  false,
);

async function transportChecks() {
  console.log('\n— posting, and failing to post —');
  type FetchArgs = { url: string; body: string };
  const sent: FetchArgs[] = [];
  const realFetch = globalThis.fetch;
  function stubFetch(reply: () => Promise<Response> | Response) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body ?? '') });
      return reply();
    }) as typeof fetch;
  }
  const ok = () => new Response('ok', { status: 200 });

  process.env.SLACK_WEBHOOK_URL = '';
  check('no webhook means the feature is off', slackConfigured(), false);
  check('and nothing is posted', await announce(['anything']), '');
  check('not even a request is made', sent.length, 0);

  process.env.SLACK_WEBHOOK_URL = 'http://slack.example/hook';
  check('plain http to somewhere out there is refused: the URL is the credential', slackConfigured(), false);
  process.env.SLACK_WEBHOOK_URL = 'http://localhost:3399/hook';
  check('but a fake channel on this machine is allowed, for testing', slackConfigured(), true);
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.example/T/B/XXX';
  check('a webhook switches it on', slackConfigured(), true);
  stubFetch(ok);
  check('a run with nothing to say says nothing', await announce([]), '');
  check('messages go to the webhook, in order, one call each', await announce(['first', 'second']), '');
  check('both landed', sent.length, 2);
  check('at the webhook', sent[0]!.url, 'https://hooks.slack.example/T/B/XXX');
  check('first first', JSON.parse(sent[0]!.body), { text: 'first' });
  check('second second', JSON.parse(sent[1]!.body), { text: 'second' });

  sent.length = 0;
  stubFetch(() => new Response('no_service', { status: 404 }));
  const refused = await announce(['one', 'two']);
  check('a refusal comes back rather than being thrown', refused.includes('404'), true);
  check('and says what Slack said', refused.includes('no_service'), true);
  check('the rest are not sent into a wall', sent.length, 1);

  sent.length = 0;
  stubFetch(() => {
    throw new Error('network down');
  });
  const broken = await announce(['one']);
  check('a network failure is caught too', broken, 'network down');

  globalThis.fetch = realFetch;
  delete process.env.SLACK_WEBHOOK_URL;
}

void transportChecks().then(() => {
  console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
});
