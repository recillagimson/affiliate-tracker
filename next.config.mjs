/**
 * Response headers, and why each one is here.
 *
 * The admin surface renders lead names, emails and phone numbers, and its
 * controls delete links and approvals with a single click. Without
 * frame-ancestors that surface is embeddable, and an attacker page can float an
 * invisible iframe of /links under a decoy button: a signed-in admin clicks
 * once, the click lands inside the frame, and the app's own JavaScript fires
 * the request from its own origin. SameSite=Lax does not help there, because
 * nothing is cross-site once the click happens inside our own page.
 *
 * The CSP is written for how this app actually loads: no external scripts, no
 * external styles, no fonts or images from anywhere else. Next.js needs
 * 'unsafe-inline' for the style attributes and the bootstrap script it emits,
 * so this is not a nonce-grade policy — it is the tight end of what works
 * without rearchitecting rendering, and it still removes every remote origin as
 * a script source.
 */

/*
 * The one remote origin the browser is allowed to reach: this project's
 * Supabase Storage, and only the support-attachments bucket.
 *
 * Support tickets carry screenshots and screen recordings, which are too large
 * to pass through this app, so the browser uploads each one straight to a
 * private bucket through a signed URL, and views it through a signed link the
 * attachment route redirects to. Without these entries the policy below blocks
 * both: the upload as a connection, the viewing as an image or a video.
 *
 * Scoped by path as well as host. Uploading may reach only the signed-upload
 * path of that one bucket; viewing only its signed-download path. A browser
 * drops the path from the check once a request has been redirected, so for
 * the pictures and videos the host is what actually holds. Nothing here
 * widens where scripts may come from.
 *
 * Empty when SUPABASE_URL is unset or is not https, which leaves the policy
 * exactly as strict as it was.
 */
function supportStorage() {
  const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) return { upload: '', view: '' };
  return {
    upload: ` ${base}/storage/v1/object/upload/sign/support-attachments/`,
    view: ` ${base}/storage/v1/object/sign/support-attachments/`,
  };
}

const STORAGE = supportStorage();

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' and 'unsafe-eval' are what the framework's own inline
  // bootstrap and dev-mode refresh need. Everything remote is still refused.
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:" + STORAGE.view,
  // Screen recordings on a support ticket. Otherwise default-src decides, and
  // says no.
  "media-src 'self' blob:" + STORAGE.view,
  "font-src 'self' data:",
  // The browser talks to this app, with one exception: uploading a support
  // attachment straight to its bucket. The QMP and every other Supabase call
  // are made server-side.
  "connect-src 'self'" + STORAGE.upload,
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  // Belt and braces with frame-ancestors, for anything that still reads this.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // A lead's landing page URL carries the tracking key, and the admin URLs
  // carry it too. Sending a full referrer to the merchant would leak the path.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * The other half of the read cache, on the client.
   *
   * Every page here is force-dynamic, which by default means the router keeps
   * nothing: pressing Back re-renders the page on the server and waits for it.
   * These four pages read the same four tables, so that wait buys nothing at
   * all — the answer is the one you were just looking at.
   *
   * 30 seconds, the same number as TTL_MS in lib/store/cache.ts, so there is
   * one staleness story rather than two. It is safe to keep this in step with
   * the server cache because every mutation in the app calls router.refresh(),
   * which drops this cache and re-reads: your own changes are never stale, and
   * somebody else's are bounded by the same half minute either way.
   */
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  // googleapis is a heavy node-only dep; keep it out of the bundler's way.
  serverExternalPackages: ['googleapis'],
  // The blank W-9 is read from disk at request time and stamped with the
  // answers. It is not imported by anything, so nothing traces it into the
  // serverless bundle unless it is named here — and the first sign of that
  // being missed is a download that 500s in production and works locally.
  outputFileTracingIncludes: {
    // Every page of the blank form, not only the one with the boxes. Named as
    // a glob so adding a page to assets/ does not also mean remembering this.
    '/api/onboarding/**': ['./assets/w9-page*.jpg'],
  },
  // Not set as a default: every response should carry these, including the
  // public landing pages and the API routes.
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
