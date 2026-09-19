// Build-time config. Only client-safe values live here: the project URL and the
// publishable (anon) key. The secret key never reaches the browser.
export const SUPABASE_URL = 'https://ybddogqphinruyunnuwx.supabase.co';
export const PUBLISHABLE = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';

// The open-demo Space token used to be exported from here. It was a LIVE
// invite credential for a real Space with 1770 members, served to every visitor
// in a file with no auth on it, and nothing in the client ever imported it - the
// behaviour it once enabled was removed in "No more blank screen: an account
// with no team gets a real screen with a join box instead of being dumped into
// the 1770-member demo Space".
//
// Deleting the export is only half of it. The value is in git history and in
// every cached copy of this file that was ever served, so the token itself has
// to be revoked server-side. Rotating it would not help for the same reason.

// Email codes support new and existing users. Verification establishes an
// identity; joining a Space still requires its normal invitation/access flow.
// Anonymous sign-in stays disabled. The backend must also allow email signup.
export const CODE_SIGNIN = true;
// OTP codes ride the organisation's own mailer (JCF-Mailer) via the mail-otp
// edge function. Flip off to fall back to Supabase's rate-limited built-in.
export const MAIL_OTP = true;
export const GUEST_SIGNIN = false;

// ------------------------------------------------------------------ embedding
// Dashboards allowed to run Dek as a panel inside themselves. An embed names
// its own origin in the iframe src and js/embed.js refuses to start unless that
// value appears here, so this list is the whole answer to "who may drive this
// panel and receive its messages".
//
// A leading '*.' matches subdomains of that host on the same scheme and port,
// and nothing else. There is deliberately no bare '*': "any page may embed us"
// is not a state anybody should be able to reach by editing one character.
//
// This is an allowlist, not a secret, which is why it can live in the client.
// It is also only half the defence. A browser will still LOAD the app in a frame
// on any page; what this stops is Dek talking to it or accepting credentials
// from it. Serving `Content-Security-Policy: frame-ancestors <the same list>`
// from wherever this is hosted is what stops the frame being drawn at all, and
// it is the one that also stops clickjacking. That is why the app is on
// Cloudflare Pages and not GitHub Pages, which cannot set headers at all - see
// `_headers` at the repo root and DEPLOY.md. On a host that cannot send them,
// this list is the only enforcement there is.
export const EMBED_ORIGINS = [
  // Add your dashboards here, e.g.
  // 'https://dash.yourcompany.com',
  // 'https://*.yourcompany.com',
];

// The demo host page, and ONLY when Dek is itself being served from a
// development machine. Shipped unconditionally these two entries mean that on
// the deployed app any page a person's own computer serves on port 8098 - a
// stray project, an npm start somebody forgot - can drive their panel and be
// handed their credentials. originAllowed also exempts localhost from the https
// requirement, so it would not even need a certificate. The gate is on where
// Dek is running, not on where the frame claims to be, because the frame is the
// thing being checked.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (DEV) EMBED_ORIGINS.push('http://localhost:8098', 'http://127.0.0.1:8098');

// Where the browser spends a one-time handoff ticket for a real session. An Edge
// Function, because minting a session needs the service role key and that must
// never come near a browser.
//
// This is the REDEEM half and it is safe to be public: a ticket is single use,
// lives sixty seconds, and is bound to the origin it was issued for. The MINT
// half is the same function at /mint, is called only by a dashboard's backend,
// and is authenticated by an HMAC over the assertion.
//
// Blank until `supabase functions deploy Dek-handoff --no-verify-jwt` has been
// run. With no endpoint the handoff path is unavailable and a host has to pass a
// session it minted itself, which works and is worse - see EMBED.md.
export const EMBED_EXCHANGE_URL = SUPABASE_URL + '/functions/v1/Dek-handoff';

export const APP_NAME = 'Dek';
export const APP_VENDOR = '';
export const VERSION = '0.3.0';

// ------------------------------------------------------------------ DPDP notice
// Shown at signup to satisfy s.6(1) of the DPDP Act: users must be informed
// of what personal data is processed, why, and their rights. This text is
// rendered in the auth UI before the OTP/email step.
export const NOTICE_AT_SIGNUP =
  'We collect your email and display name to provision your account and enable ' +
  'messaging with teammates. You may withdraw consent and request deletion of ' +
  'your personal data at any time by contacting support or using the account ' +
  'deletion tool. Our retention policy limits how long your data is kept ' +
  'after account closure.';

// Permission bitfield, mirrored from the database (private.has_perm).
export const PERM = {
  SEND: 1n,
  MANAGE_MESSAGES: 2n,
  MANAGE_CHANNELS: 4n,
  MANAGE_ROLES: 8n,
  KICK: 16n,
  BAN: 32n,
  MANAGE_WORKSPACE: 64n,
  CREATE_INVITE: 128n,
  MENTION_EVERYONE: 256n,
  MODERATE: 512n,
  MANAGE_THREADS: 1024n,
  ADMINISTRATOR: 1n << 40n,
};

// Quick-react bar: the six shown on message hover without opening the picker.
export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

// 50 MB, because that is the hard ceiling on the Supabase free plan: "For Free
// projects, the limit can't exceed 50 MB." This said 100 MB, so somebody picking
// a 90 MB video got the whole optimistic experience - the file read into memory,
// hashed with sha256, dimensions probed - and then a server refusal at the end,
// with the client having promised in its own error message that 100 MB was fine.
//
// Raise it here AND in the bucket's own limit if the project ever moves off the
// free plan; the two have to agree or one of them is lying to somebody.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MESSAGE_PAGE = 50;
