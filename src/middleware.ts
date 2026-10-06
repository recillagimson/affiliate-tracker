import { NextResponse, type NextRequest } from 'next/server';
import {
  authConfigured,
  basicAuthEnabled,
  envCredentialsValid,
  readSessionToken,
  SESSION_COOKIE,
} from '@/lib/auth';
import { rateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/request';

/**
 * Sign-in over the admin surface.
 *
 * The dashboard lists lead names, emails and phone numbers, so anything that
 * reads or writes them is gated the moment sign-in is configured. Public routes
 * — the landing pages, the submission endpoint and the visit beacon — are never
 * gated, or the whole point of the tool would break.
 *
 * This layer answers exactly one question: *is this request signed in?* It does
 * not decide what the signer may then see or do. That is deliberate. Roles and
 * per-affiliate scoping are settled server-side in lib/viewer.ts against the
 * users table, because only the database knows whether an account was disabled
 * or demoted five minutes ago. Duplicating any of it here would create a second
 * opinion that can disagree with the first, and the failure mode of two
 * disagreeing authorisation checks is that the weaker one wins.
 *
 * Two credentials are accepted:
 *
 *   - the signed session cookie the sign-in form sets, which is what a person
 *     in a browser uses;
 *   - HTTP Basic for the environment admin, which is what this used to require
 *     and is kept so a `curl -u` or an existing script does not break.
 *
 * What is deliberately NOT sent is a `WWW-Authenticate` challenge. That header
 * is what makes a browser throw up its own credential box, and replacing that
 * box with a real page is the point of the sign-in form.
 *
 * With nothing configured to sign in with (local development) everything is open.
 */

/**
 * Basic credentials, if the header carries any. Environment account only, and
 * only when ALLOW_BASIC_AUTH=true.
 *
 * Throttled, because unlike the sign-in form there is nothing else here to slow
 * a guess down: no session to establish, no cookie, no form. Returns 'limited'
 * rather than false when the budget is gone so the caller can answer 429
 * instead of handing back a redirect an attacker would read as "wrong password,
 * try the next one".
 *
 * The counter is per Edge isolate rather than global, so this raises the cost of
 * a guessing run without capping it. The real protection is that Basic is off
 * unless a deployment turns it on.
 */
function checkBasicAuth(header: string | null, ip: string): 'ok' | 'no' | 'limited' {
  if (!basicAuthEnabled()) return 'no';
  if (!header?.startsWith('Basic ')) return 'no';

  const budget = rateLimit(`basic:${ip || 'shared'}`, { limit: 8, windowMs: 10 * 60_000 });
  if (!budget.ok) return 'limited';

  let decoded: string;
  try {
    // atob yields bytes, not characters. Decoding them as UTF-8 is what makes a
    // password containing any non-ASCII character work at all.
    const bytes = Uint8Array.from(atob(header.slice(6)), (char) => char.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return 'no';
  }

  const separator = decoded.indexOf(':');
  const user = separator === -1 ? '' : decoded.slice(0, separator);
  const pass = separator === -1 ? decoded : decoded.slice(separator + 1);
  return envCredentialsValid(user, pass) ? 'ok' : 'no';
}

export async function middleware(request: NextRequest) {
  if (!authConfigured()) {
    // Open in development so the app runs with zero configuration. In a
    // production build, refuse to serve the admin surface unpassworded unless
    // that is an explicit, deliberate choice — the alternative is publishing
    // every lead's name, email and phone number to anyone with the URL.
    if (process.env.NODE_ENV === 'production') {
      // ALLOW_OPEN_ADMIN exists for a throwaway demo against throwaway data.
      // It stops being an acceptable answer the moment a real store is
      // attached: at that point the rows behind these pages are somebody's
      // actual leads, and "I set a flag once" is not consent to publish them.
      // The flag is deliberately not enough on its own here.
      const liveStore = Boolean(
        process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.GOOGLE_SHEET_ID,
      );
      if (process.env.ALLOW_OPEN_ADMIN !== 'true' || liveStore) {
        return new NextResponse(
          liveStore
            ? 'Admin access is not configured, and this deployment has a real data store attached. ' +
              'Set SESSION_SECRET and ADMIN_PASSWORD before serving lead data.'
            : 'Admin access is not configured. Set SESSION_SECRET and ADMIN_PASSWORD, or set ALLOW_OPEN_ADMIN=true to run without them.',
          { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
      }
    }
    return NextResponse.next();
  }

  const session = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const basic = checkBasicAuth(request.headers.get('authorization'), clientIp(request));
  if (basic === 'ok') return NextResponse.next();
  if (basic === 'limited') {
    return NextResponse.json(
      { error: 'Too many attempts.' },
      { status: 429, headers: { 'retry-after': '600' } },
    );
  }

  // An API call gets an answer it can parse. Redirecting fetch() to an HTML
  // sign-in page would surface as a JSON parse error rather than "signed out".
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const signIn = new URL('/login', request.url);
  const from = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (from && from !== '/') signIn.searchParams.set('next', from);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Admin pages, link management and lead status changes only. /[slug],
  // /api/submissions and /api/visits are intentionally absent, and so are
  // /login and /api/login — gating the sign-in page behind sign-in is a loop
  // with no way out.
  matcher: [
    '/',
    '/links',
    '/links/:path*',
    // Starting and ending an impersonation. Listed for the throttle rather than
    // for the auth: the route checks the session itself, but checkBasicAuth here
    // is the ONLY thing rate-limiting Basic credentials, and a gated route left
    // out of this list is an unthrottled password oracle whenever
    // ALLOW_BASIC_AUTH is on.
    '/api/view-as',
    '/api/view-as/:path*',
    // Per-person earnings. Missing from this list, it would be a public page
    // listing what every affiliate is paid.
    '/affiliate',
    '/affiliate/:path*',
    // The CPA rate card. Everyone signed in may read it; nobody signed out
    // may, because it is the whole commercial arrangement in one table.
    '/cpa',
    '/cpa/:path*',
    '/api/cpa',
    '/api/cpa/:path*',
    // QMP reports. The page shows revenue and the route behind it spends the
    // account's API credentials, so both are gated exactly like the rest.
    '/reports',
    '/reports/:path*',
    '/api/qmp',
    '/api/qmp/:path*',
    // Account administration. The pages behind these create sign-ins, so an
    // unauthenticated request must not reach them even to be told no.
    '/users',
    '/users/:path*',
    '/api/users',
    '/api/users/:path*',
    // Onboarding. Everything behind these is somebody's name, address,
    // taxpayer number and bank account, so signed-out requests must not reach
    // them even to be told no. /welcome is gated for the opposite reason as
    // well: it is a form that writes to an account, so it needs to know which.
    '/welcome',
    '/welcome/:path*',
    '/api/onboarding',
    '/api/onboarding/:path*',
    // Somebody's own paperwork: their name, address and the last four digits of
    // a taxpayer number. Gated exactly like /welcome, and for the same reason.
    '/profile',
    '/profile/:path*',
    // Money. The schedule is everybody's pay on one page and the payslip is
    // somebody's own, so neither may be reached without a session deciding
    // which of those two things the reader is allowed to be looking at. The
    // receipt route is here as well: it hands back a bank document.
    '/payouts',
    '/payouts/:path*',
    '/payslips',
    '/payslips/:path*',
    '/api/payouts',
    '/api/payouts/:path*',
    '/api/payslips',
    '/api/payslips/:path*',
    // Support tickets. A conversation between one affiliate and the admins,
    // with screenshots, so a signed-out request must not reach the pages, the
    // route behind them or the image route, even to be told no.
    '/support',
    '/support/:path*',
    '/api/support',
    '/api/support/:path*',
    // Settings. A campaign decides where a link sends people, so the page and
    // the route behind it are gated like account administration is.
    '/settings',
    '/settings/:path*',
    // The commission percentage and the rate-card floor. Gated like account
    // administration, because the first of them decides what everybody is paid.
    '/api/settings',
    '/api/settings/:path*',
    '/api/campaigns',
    '/api/campaigns/:path*',
    '/api/links',
    '/api/links/:path*',
    '/api/leads',
    '/api/leads/:path*',
    '/api/conversions',
    '/api/conversions/:path*',
  ],
};
