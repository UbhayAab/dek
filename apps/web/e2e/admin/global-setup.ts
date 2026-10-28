// Signs the QA users in once (storage states for the browser contexts, so a run
// does not hit the auth rate limit), and brings the fixture world to its baseline:
// the fixture member Fiona is an active plain member of Dek QA with a clean
// profile, and the test channel exists in Medical Partnerships without Alice.
import { mkdirSync } from 'node:fs';
import type { Channel, MeResult, Server } from '../../src/api/types';
import {
  AUTH_DIR, CHANNEL_BASELINE, E2E_CHANNEL, FIXTURE_NAME, ORG_SEEDED, ORG_TEST_SHORT_NAME, QA, authFile, ensureUser, rpc, signIn,
  storageState, writeJson, WORLD_FILE, type OrgBaseline, type QaUser, type Signed, type World,
} from './support/qa';

export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  await ensureUser(QA.fixture, FIXTURE_NAME);

  const users = {} as Record<QaUser, Signed>;
  for (const u of Object.keys(QA) as QaUser[]) users[u] = await signIn(QA[u]);
  const owner = users.owner.client;

  const me = await rpc<MeResult>(owner, 'me');
  const org = me.orgs.find((o) => o.slug === 'dek-qa');
  if (!org) throw new Error('The Dek QA organization is missing: run node tools/seed-qa.mjs');
  const servers = await rpc<Server[]>(owner, 'list_servers', { p_org: org.id });
  const med = servers.find((s) => s.name === 'Medical Partnerships' && !s.archived);
  const tech = servers.find((s) => s.name === 'Tech' && !s.archived);
  if (!med || !tech) throw new Error('The QA team servers are missing: run node tools/seed-qa.mjs');

  // Fiona: an active member of Dek QA (joined once through a real invite).
  const fixtureId = users.fixture.userId;
  await rpc(owner, 'suspend_org_member', { p_org: org.id, p_user: fixtureId, p_suspended: false, p_reason: null }).catch(() => undefined);
  const fme = await rpc<MeResult>(users.fixture.client, 'me');
  if (!fme.orgs.some((o) => o.id === org.id)) {
    const inv = await rpc<{ id: string; code: string }>(owner, 'create_invite', {
      p_org: org.id, p_server: null, p_channel_ids: [], p_role: 'member', p_email: null,
      p_expires_hours: 1, p_max_uses: 1, p_requires_approval: false,
    });
    try {
      await rpc(users.fixture.client, 'accept_invite', { p_code: inv.code });
    } finally {
      await rpc(owner, 'revoke_invite', { p_invite: inv.id });
    }
  }
  await rpc(owner, 'set_org_role', { p_org: org.id, p_user: fixtureId, p_role: 'member' });
  await rpc(users.fixture.client, 'update_profile', { p_patch: { display_name: FIXTURE_NAME, title: null, timezone: 'Asia/Kolkata', avatar_path: null } });
  await rpc(users.fixture.client, 'set_status', { p_text: null, p_emoji: null, p_until: null });
  await rpc(users.fixture.client, 'set_notification_prefs', {
    p_patch: { default_level: 'mentions', dm_level: 'all', thread_replies: true, quiet_start: null, quiet_end: null, quiet_tz: 'Asia/Kolkata', preview: 'full' },
  });

  // The test channel: public, in Medical Partnerships, owned by the QA owner.
  const chans = await rpc<Channel[]>(owner, 'list_channels', { p_server: med.id });
  let e2e = chans.find((c) => c.name === E2E_CHANNEL && !c.archived) ?? null;
  const archived = chans.find((c) => c.name === E2E_CHANNEL && c.archived) ?? null;
  if (!e2e && archived) e2e = await rpc<Channel>(owner, 'archive_channel', { p_channel: archived.id, p_archived: false });
  if (!e2e) {
    e2e = await rpc<Channel>(owner, 'create_channel', {
      p_server: med.id, p_name: E2E_CHANNEL, p_kind: 'text', p_visibility: 'public', p_topic: CHANNEL_BASELINE.topic,
      p_description: null, p_posting_policy: 'everyone', p_member_ids: [], p_auto_join: false, p_category: null,
    });
  }
  await rpc(owner, 'update_channel', { p_channel: e2e.id, p_patch: { ...CHANNEL_BASELINE, name: E2E_CHANNEL } });
  await rpc(owner, 'remove_channel_member', { p_channel: e2e.id, p_user: users.alice.userId }).catch(() => undefined);

  const general = chans.find((c) => c.name === 'general' && !c.archived);
  if (!general) throw new Error('Medical Partnerships has no #general');
  // grants is private and the owner is not in it: only the admin listing shows it
  const managed = await rpc<Channel[]>(owner, 'list_channels', { p_server: med.id, p_manage: true });
  const grants = managed.find((c) => c.name === 'grants' && !c.archived);
  if (!grants) throw new Error('Medical Partnerships has no #grants');

  // The organization as it is now, unless a crashed run left the test's own values.
  const boot = await rpc<{ org: { name: string; short_name: string | null; brand_color: string; settings: Record<string, unknown> } }>(owner, 'bootstrap', { p_org: org.id });
  const orgBaseline: OrgBaseline = boot.org.short_name === ORG_TEST_SHORT_NAME
    ? ORG_SEEDED
    : { name: boot.org.name, short_name: boot.org.short_name, brand_color: boot.org.brand_color, settings: boot.org.settings };
  if (boot.org.short_name === ORG_TEST_SHORT_NAME) {
    await rpc(owner, 'update_org', { p_org: org.id, p_patch: { ...ORG_SEEDED, short_name: ORG_SEEDED.short_name } });
  }

  for (const u of Object.keys(QA) as QaUser[]) writeJson(authFile(u), storageState(users[u].storageValue));
  const world: World = {
    orgId: org.id,
    orgName: org.name,
    orgBaseline,
    medId: med.id,
    techId: tech.id,
    generalId: general.id,
    grantsId: grants.id,
    e2eChannelId: e2e.id,
    ids: Object.fromEntries((Object.keys(QA) as QaUser[]).map((u) => [u, users[u].userId])) as Record<QaUser, string>,
  };
  writeJson(WORLD_FILE, world);
}
