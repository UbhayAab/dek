// Identity: auth users (same ids and password hashes), identities, live sessions
// and refresh tokens, profiles, notification preferences, organizations, org
// members (Ubhay as owner), platform admins.
import { ORGS, OWNER_EMAIL_SHA256, HANDLE_RE, LIMITS, AVATAR_BUCKET, AVATAR_MIME } from './config.mjs';
import { sha256, clipOrNull, baseName, safeFileName, extOf, baseMime, tsKey, contrastWithWhite } from './util.mjs';

// Pending one-time tokens belong to links that point at the legacy project; they are
// blanked (GoTrue needs '' rather than NULL in these columns).
const TOKEN_COLUMNS = ['confirmation_token', 'recovery_token', 'email_change_token_new',
  'email_change_token_current', 'phone_change_token', 'reauthentication_token'];

export function transformIdentity(ctx) {
  const { d, plan } = ctx;
  let blanked = 0;
  let pendingEmailChanges = 0;
  for (const u of d.users) {
    const a = { ...u.auth };
    for (const k of TOKEN_COLUMNS) {
      if (a[k]) blanked += 1;
      a[k] = '';
    }
    if (a.email_change) pendingEmailChanges += 1;
    a.email_change = '';
    plan.rows.auth_users.push(a);
    plan.owned.auth_user.push(a.id);
  }
  for (const r of d.identities) { plan.rows.identities.push(r.row); plan.owned.identity.push(r.row.id); }
  for (const r of d.sessions) { plan.rows.sessions.push(r.row); plan.owned.session.push(r.row.id); }
  for (const r of d.refreshTokens) {
    plan.rows.refresh_tokens.push(r.row);
    plan.owned.refresh_token.push(sha256(String(r.row.token)));
  }
  for (const r of d.amrClaims) {
    plan.rows.amr_claims.push(r.row);
    plan.owned.amr_claim.push(`${r.row.session_id}:${r.row.authentication_method}`);
  }
  plan.stats.users = {
    migrated: d.users.length,
    real_org_members: d.users.filter((u) => u.real_member).length,
    no_org_accounts: d.users.filter((u) => !u.real_member).length,
    excluded: Object.fromEntries(d.excludedUsers.map((r) => [r.reason, r.n])),
    identities: d.identities.length,
    password_hashes: d.users.filter((u) => u.auth.encrypted_password).length,
    sessions_copied: d.sessions.length,
    refresh_tokens_copied: d.refreshTokens.length,
    amr_claims_copied: d.amrClaims.length,
    sessions_skipped_expired: d.sessionCounts.expired,
    sessions_skipped_without_live_token: d.sessionCounts.without_live_token,
    pending_tokens_blanked: blanked,
    pending_email_changes_cancelled: pendingEmailChanges,
  };
  profiles(ctx);
  prefs(ctx);
  orgs(ctx);
}

function profiles(ctx) {
  const { d, plan } = ctx;
  const handles = new Set();
  let handleNull = 0;
  let avatars = 0;
  for (const u of d.users) {
    const p = u.profile || {};
    const id = u.auth.id;
    const local = String(u.auth.email || '').split('@')[0];
    let handle = p.username ? String(p.username).toLowerCase() : null;
    if (handle && (!HANDLE_RE.test(handle) || handles.has(handle))) handle = null;
    if (handle) handles.add(handle); else handleNull += 1;
    let avatarPath = null;
    const obj = p.avatar_key ? ctx.objects.get(p.avatar_key) : null;
    if (obj && AVATAR_MIME.includes(baseMime(obj.mimetype))) {
      avatarPath = `${id}/${safeFileName(baseName(p.avatar_key), extOf(p.avatar_key))}`;
      plan.objects.push({ kind: 'avatar', bucket: AVATAR_BUCKET, path: avatarPath, legacyKey: p.avatar_key,
        contentType: baseMime(obj.mimetype), size: Number(obj.size), legacySha: null });
      avatars += 1;
    } else if (p.avatar_key) {
      plan.warnings.push(`avatar of user ${id} not copied (object missing or type not allowed)`);
    }
    plan.rows.profiles.push({
      id,
      display_name: clipOrNull(p.display_name, LIMITS.displayName) || clipOrNull(local, LIMITS.displayName) || 'Member',
      handle,
      avatar_path: avatarPath,
      title: clipOrNull(p.title, LIMITS.title),
      timezone: clipOrNull(p.timezone, 64) || 'Asia/Kolkata',
      status_text: clipOrNull(p.status_text, LIMITS.statusText),
      status_emoji: clipOrNull(p.status_emoji, LIMITS.emoji),
      status_until: p.status_expires_at || null,
      last_active_at: u.auth.last_sign_in_at || null,
      created_at: p.created_at || u.auth.created_at,
      updated_at: p.updated_at || p.created_at || u.auth.created_at,
      deleted_at: null,
      legacy_id: id,
    });
    plan.owned.profile.push(id);
  }
  plan.stats.profiles = { handles: handles.size, handles_null: handleNull, avatars };
}

function prefs(ctx) {
  const { d, plan } = ctx;
  const np = new Map(d.notificationPrefs.map((r) => [r.user_id, r]));
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  let quiet = 0;
  for (const u of d.users) {
    const r = np.get(u.auth.id);
    const tz = clipOrNull(u.profile?.timezone, 64) || 'Asia/Kolkata';
    const has = r && r.quiet_start != null && r.quiet_end != null && r.quiet_start !== r.quiet_end;
    if (has) quiet += 1;
    plan.rows.notification_prefs.push({
      user_id: u.auth.id,
      quiet_start: has ? hh(r.quiet_start) : null,
      quiet_end: has ? hh(r.quiet_end) : null,
      quiet_tz: has ? tz : 'Asia/Kolkata',
      updated_at: r?.updated_at || null,
    });
  }
  plan.stats.notification_prefs = { legacy_rows: d.notificationPrefs.length, quiet_hours: quiet };
}

function orgs(ctx) {
  const { d, plan } = ctx;
  const legacyOrg = new Map(d.orgs.map((o) => [o.id, o]));
  const emailSha = new Map(d.users.map((u) => [u.auth.id, sha256(String(u.auth.email || '').toLowerCase())]));
  for (const o of ORGS) {
    const lo = legacyOrg.get(o.id);
    if (!lo) throw new Error(`legacy organization ${o.id} not found`);
    const ratio = contrastWithWhite(o.brand_color);
    if (ratio < 4.5) throw new Error(`brand color of ${o.slug} has contrast ${ratio.toFixed(2)} < 4.5`);
    // Legacy organizations have no creator column; the creator of the org's first
    // workspace (created in the same instant as the org) is its creator.
    const first = d.workspaces.filter((w) => w.org_id === o.id).sort((a, b) => (tsKey(a.created_at) < tsKey(b.created_at) ? -1 : 1))[0];
    const createdBy = first && ctx.migrated.has(first.created_by) ? first.created_by : null;
    plan.rows.orgs.push({ id: o.id, slug: o.slug, name: o.name, short_name: o.short_name,
      brand_color: o.brand_color, created_by: createdBy, created_at: lo.created_at, legacy_id: o.id });
    plan.decisions.push({ area: 'orgs', text: `${o.name}: slug ${o.slug}, short name ${o.short_name}, brand ${o.brand_color} (contrast with white ${ratio.toFixed(2)}:1), created_by ${createdBy || 'null'} (creator of its first workspace).` });

    const members = d.orgMembers.filter((m) => m.org_id === o.id && ctx.migrated.has(m.user_id));
    let owner = null;
    for (const h of OWNER_EMAIL_SHA256) {
      owner = members.find((m) => emailSha.get(m.user_id) === h);
      if (owner) break;
    }
    if (!owner) plan.warnings.push(`no owner account is a member of ${o.name}: nobody made owner`);
    for (const m of members) {
      const role = owner && m.user_id === owner.user_id ? 'owner' : (m.org_role === 'admin' ? 'admin' : 'member');
      plan.rows.org_members.push({ org_id: o.id, user_id: m.user_id, role, status: 'active', joined_at: m.joined_at });
      plan.owned.org_member.push(`${o.id}:${m.user_id}`);
    }
    if (owner) {
      const which = OWNER_EMAIL_SHA256.indexOf(emailSha.get(owner.user_id)) === 0 ? 'primary' : 'secondary';
      plan.decisions.push({ area: 'roles', text: `${o.name}: owner is user ${owner.user_id} (Ubhay's ${which} account, legacy org role ${owner.org_role}).` });
    }
    const skipped = d.orgMembers.filter((m) => m.org_id === o.id && !ctx.migrated.has(m.user_id)).length;
    if (skipped) plan.warnings.push(`${skipped} legacy members of ${o.name} are not migrated users`);
  }
  for (const pa of d.platformAdmins) {
    if (ctx.migrated.has(pa.user_id)) {
      plan.rows.platform_admins.push({ user_id: pa.user_id, created_at: pa.created_at });
      plan.owned.platform_admin.push(pa.user_id);
    }
  }
  plan.stats.platform_admins = { legacy: d.platformAdmins.length, migrated: plan.rows.platform_admins.length };
}
