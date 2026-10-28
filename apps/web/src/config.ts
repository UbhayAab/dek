// Build-time configuration. Only public values live here: the publishable key is
// designed to ship in browsers; the api schema's own checks protect data.
const env = import.meta.env;

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined) ?? 'https://nxljuctnauhgzekvmftp.supabase.co',
  supabaseKey: (env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? 'sb_publishable_3nEbaDSWo0j3kFCl52-vhg_aRQZTndH',
  // The VAPID public key MUST pair with the private key push-dispatch signs with.
  // One source only (build env); notification health compares it with the
  // subscription's applicationServerKey and re-subscribes on mismatch.
  vapidPublicKey: (env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? 'BMOAGjdDdmNngOJeTZvTnap0xG7U_QpGdo19fnvcPWXFQygmPW484rruKsGETRW77ad-D2RwoeYUtE3EdNNXJHs',
  appEnv: (env.VITE_APP_ENV as string | undefined) ?? 'development',
  buildId: (env.VITE_BUILD_ID as string | undefined) ?? 'dev',
  // Legacy project ref: a session stored by the legacy app under this ref is
  // exchanged once for a new one (migrated refresh tokens), so nobody signs in again.
  legacyProjectRef: 'ybddogqphinruyunnuwx',
  // Links people share (invites, messages) always point at the public web app: a native
  // shell's own origin is not reachable from another phone.
  publicOrigin: (env.VITE_PUBLIC_ORIGIN as string | undefined) ?? 'https://dek-7o4.pages.dev',
} as const;

export const limits = {
  bodyMax: 8000,
  pageSize: 50,
  groupDmMax: 9,
  uploadMaxBytes: 25 * 1024 * 1024,
  videoMaxBytes: 100 * 1024 * 1024,
  typingThrottleMs: 3000,
  typingExpiryMs: 6000,
  activeWindowMs: 10 * 60 * 1000,
} as const;
