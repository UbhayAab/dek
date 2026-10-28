// Every fixed decision of the legacy migration in one place. The binding source is
// docs/migration/LEGACY-MAP.md section 0 and the migration brief; anything resolved
// from live data is recorded in docs/migration/PLAN-RUN.md by `--plan`.
import { join } from 'node:path';
import { ROOT } from '../../lib/env.mjs';

export const LEGACY_REF = 'ybddogqphinruyunnuwx';

// The two real organizations. Same ids in the new project; legacy_id = id.
// Brand colors pass 4.5:1 against white text (checked at runtime by contrast()).
export const ORGS = [
  { id: '019f993c-604d-7129-af26-e406dd9da295', slug: 'jarurat-care', name: 'Jarurat Care',
    short_name: 'JCF', brand_color: '#0F766E' },
  { id: '019f993c-6130-7f49-8406-bc9424bb0248', slug: 'safalta-setu', name: 'Safalta Setu',
    short_name: 'Safalta Setu', brand_color: '#7C3AED' },
];
export const ORG_IDS = ORGS.map((o) => o.id);

// Accounts on these domains are fixtures from the legacy test suites.
export const TEST_DOMAINS = ['hearth.test', 'dek.app', 'dek-backend.test', 'apps.invalid'];

// Ubhay's accounts, in order of preference, as sha256 of the lowercased address so
// no address is written into this public repository.
export const OWNER_EMAIL_SHA256 = [
  '7180e0b04926030fd96d3821a6722a72f787beda3700ff3bf43960e5bea7e563',
  '39fbd52171c584018f0f6d1bbb94f40cddf32565a8425c23edee2113a47c1a3d',
];

// Namespace for deterministic ids (uuid v5) of rows that have no legacy uuid of
// their own: a second reference to one stored file, an attachment without a row.
export const ID_NAMESPACE = 'fa7ada46-c9d2-4262-9b01-874a53974e97';

// Legacy invites without an expiry never expired. dek.invites.expires_at is NOT
// NULL, so "never" is stored as this far-future instant (one UPDATE can bound it).
export const NO_EXPIRY = '2100-01-01T00:00:00+00:00';

// Legacy permission bits (dek-backend/supabase/migrations/0003_authz_rls.sql).
export const PERM_MANAGE_MESSAGES = 1n << 1n;
export const PERM_ADMINISTRATOR = 1n << 40n;

export const LIMITS = { body: 8000, name: 80, topic: 250, description: 1000, category: 40,
  title: 80, displayName: 80, fileName: 200, statusText: 100, emoji: 64, label: 80, platform: 40 };

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

// Outside every repository and deploy root: dek-legacy's deploy publishes every
// top-level folder that git does not ignore, so an archive inside it would go live.
export const ARCHIVE_DIR = process.env.DEK_ARCHIVE_DIR
  || join(ROOT, '..', 'dek-legacy-archive', '_archive_2026-10-03');
export const LEGACY_ENV_FILE = process.env.DEK_LEGACY_ENV_FILE
  || join(ROOT, '..', 'dek-backend', '.env.local');
export const DOCS_DIR = join(ROOT, 'docs', 'migration');

// Advisory lock so two runs never overlap on the target.
export const RUN_LOCK = 7314099;

export const LEGACY_BUCKET = 'attachments';
export const MEDIA_BUCKET = 'media';
export const AVATAR_BUCKET = 'avatars';
export const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
