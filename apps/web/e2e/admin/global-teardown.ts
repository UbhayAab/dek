// Leaves the QA world as the run found it, even after a failed test: revokes every
// invite the run created, puts the fixture member back to an active plain member,
// resets the test channel, deletes throwaway accounts, and deletes the stored
// sessions (they hold access tokens).
import { existsSync, rmSync } from 'node:fs';
import {
  AUTH_DIR, CHANNEL_BASELINE, E2E_CHANNEL, LEDGER_FILE, QA, deleteAuthUser, readLedger, readWorld, rpc, signIn, WORLD_FILE,
} from './support/qa';

export default async function globalTeardown(): Promise<void> {
  const problems: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
    }
  };
  try {
    if (existsSync(WORLD_FILE)) {
      const world = readWorld();
      const ledger = readLedger();
      const owner = await signIn(QA.owner);
      for (const id of ledger.invites) await attempt(`revoke invite ${id}`, () => rpc(owner.client, 'revoke_invite', { p_invite: id }));
      await attempt('restore fixture access', () => rpc(owner.client, 'suspend_org_member', { p_org: world.orgId, p_user: world.ids.fixture, p_suspended: false, p_reason: null }));
      await attempt('restore fixture role', () => rpc(owner.client, 'set_org_role', { p_org: world.orgId, p_user: world.ids.fixture, p_role: 'member' }));
      await attempt('unarchive test channel', () => rpc(owner.client, 'archive_channel', { p_channel: world.e2eChannelId, p_archived: false }));
      await attempt('reset test channel', () => rpc(owner.client, 'update_channel', { p_channel: world.e2eChannelId, p_patch: { ...CHANNEL_BASELINE, name: E2E_CHANNEL } }));
      await attempt('take Alice out of the test channel', () => rpc(owner.client, 'remove_channel_member', { p_channel: world.e2eChannelId, p_user: world.ids.alice }).catch((e: { code?: string }) => {
        if (e.code !== 'not_found') throw e;
      }));
      await attempt('Tech back to invite only', () => rpc(owner.client, 'update_server', { p_server: world.techId, p_patch: { join_policy: 'invite' } }));
      await attempt('take the fixture out of Tech', () => rpc(owner.client, 'remove_server_member', { p_server: world.techId, p_user: world.ids.fixture }).catch((e: { code?: string }) => {
        if (e.code !== 'not_found') throw e;
      }));
      for (const id of ledger.users) await attempt(`delete throwaway account ${id}`, () => deleteAuthUser(id));
    }
  } finally {
    rmSync(AUTH_DIR, { recursive: true, force: true });
    rmSync(LEDGER_FILE, { force: true });
  }
  if (problems.length) console.warn(`[admin e2e teardown] ${problems.length} cleanup step(s) failed:\n  ${problems.join('\n  ')}`);
}
