// What a support ticket says outside the app: the email an affiliate gets
// when an admin writes to them, and the line the admins' Slack channel gets
// when an affiliate does.
//
// Both carry text a person typed, into a surface with its own markup. So the
// thing pinned hardest is that what they typed arrives as what they typed: no
// HTML from a message body, and no Slack mention or disguised link from a
// subject.
//
//   npx tsx scripts/support-notify-checks.ts

import { supportReplyEmail } from '../src/lib/emails/support-reply';
import { supportMessage } from '../src/lib/slack-messages';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

console.log('- the email -');
const email = supportReplyEmail({
  to: 'maria@example.com',
  name: 'Maria Santos',
  origin: 'https://ledger.example.com/',
  subject: 'Where is my payout?',
  body: 'It went out on Friday.\nIt should land by Tuesday.',
  ticketPath: '/support/12',
  opened: false,
});
check('it goes to them', email.to === 'maria@example.com');
check('the subject names the ticket', email.subject === 'Reply to your support ticket: Where is my payout?');
check('it greets them by first name', email.text.startsWith('Hi Maria,'));
check('the reply is in it', email.text.includes('It went out on Friday.\nIt should land by Tuesday.'));
check('the link has one slash, not two', email.text.includes('https://ledger.example.com/support/12'));
check('the HTML has the link too', (email.html ?? '').includes('href="https://ledger.example.com/support/12"'));
check('line breaks survive into the HTML', (email.html ?? '').includes('It went out on Friday.<br>It should land by Tuesday.'));
const started = supportReplyEmail({
  to: 'maria@example.com',
  name: '',
  origin: 'https://ledger.example.com',
  subject: 'Your W-9',
  body: 'Could you send a clearer copy?',
  ticketPath: '/support/13',
  opened: true,
});
check('a ticket an admin opened says so', started.subject === 'New message from LaunchStone support: Your W-9');
check('nobody is greeted as nothing', started.text.startsWith('Hi there,'));
const hostile = supportReplyEmail({
  to: 'maria@example.com',
  name: '<b>Maria</b>',
  origin: 'https://ledger.example.com',
  subject: '<script>alert(1)</script>',
  body: '<img src=x onerror=alert(1)> & "quotes"',
  ticketPath: '/support/14',
  opened: false,
});
check('a tag in the body is escaped', !(hostile.html ?? '').includes('<img') && (hostile.html ?? '').includes('&lt;img'));
check('a tag in the subject is escaped', !(hostile.html ?? '').includes('<script>'));
check('a tag in the name is escaped', !(hostile.html ?? '').includes('<b>Maria</b>'));
check('an ampersand is escaped once', (hostile.html ?? '').includes('&amp; &quot;quotes&quot;'));
for (const message of [email, started]) {
  check('no dash in the text', !/[\u2013\u2014]/.test(message.text + message.subject));
  check('no dash in the HTML', !/[\u2013\u2014]/.test(message.html ?? ''));
}

console.log('- the Slack line -');
const slack = supportMessage({
  person: 'maria',
  subject: 'Where is my payout?',
  category: 'payout',
  kind: 'opened',
  url: 'https://ledger.example.com/support/12',
});
check(
  'a new ticket, in the channel\'s shape',
  slack ===
    '*LEDGER - SUPPORT TICKET*\n' +
      '*New ticket from:* maria\n' +
      '*Subject:* Where is my payout? (Payout issue)\n' +
      'https://ledger.example.com/support/12',
  slack,
);
const again = supportMessage({ person: 'maria (via Gimson)', subject: 'Thanks', category: 'question', kind: 'replied', url: 'https://x/support/1' });
check('a reply says it is one', again.includes('*New reply from:* maria (via Gimson)'));
// Review focus 2.
const loud = supportMessage({ person: 'maria', subject: '<!channel> <http://evil.example|click here> & *bold*', category: 'bug', kind: 'opened', url: 'https://x/support/2' });
check('a mention in a subject is not a mention', !loud.includes('<!channel>') && loud.includes('&lt;!channel&gt;'));
check('a link in a subject is not a link', !loud.includes('<http://evil.example|click here>'));
check('an ampersand is escaped', loud.includes('&amp;'));
check('a blank person is not a blank line', supportMessage({ person: '  ', subject: 'x', category: 'bug', kind: 'opened', url: 'https://x' }).includes('*New ticket from:* Unknown'));
check('no dash', !/[\u2013\u2014]/.test(slack + again));

console.log(`\nsupport-notify: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
