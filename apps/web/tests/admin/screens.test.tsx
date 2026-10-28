// Component states that matter most: the denied admin view, invite validation and
// the link, the typed DELETE confirmation with the last-owner refusal, and the
// phone settings menu. The api module is mocked; the store is the real one.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DekError } from '../../src/api/errors';
import type { Channel, MeResult, OrgSummary, Server } from '../../src/api/types';

vi.mock('../../src/api/rpc', () => ({
  api: {
    me: vi.fn(),
    listJoinRequests: vi.fn(async () => ({ items: [] })),
    listReports: vi.fn(async () => ({ items: [], total: 0 })),
    listOrgMembers: vi.fn(async () => ({ items: [], total: 0 })),
    listServers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    createInvite: vi.fn(),
    requestAccountDeletion: vi.fn(),
    leaveOrg: vi.fn(),
  },
}));

const { api } = await import('../../src/api/rpc');
const { resetState, setState } = await import('../../src/store');
const { AdminScreen } = await import('../../src/features/admin');
const { InviteDialog } = await import('../../src/features/admin/sections/InviteDialog');
const { AccountSection } = await import('../../src/features/settings/sections/Account');
const { SettingsScreen } = await import('../../src/features/settings');
const { InstallSection } = await import('../../src/features/settings/sections/Install');

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

function org(role: OrgSummary['my_role']): OrgSummary {
  return { id: ORG, slug: 'dek-qa', name: 'Dek QA', short_name: null, brand_color: '#0F766E', logo_path: null, my_role: role, unread_channels: 0, mention_count: 0 };
}

function signIn(role: OrgSummary['my_role']) {
  const me: MeResult = {
    user_id: ME,
    email: 'qa@dek-test.invalid',
    profile: { id: ME, display_name: 'Asha Owner', handle: null, avatar_path: null, title: null, timezone: null, status_text: null, status_emoji: null, status_until: null, last_active_at: null, deleted: false },
    orgs: [org(role)],
    prefs: { default_level: 'mentions', dm_level: 'all', thread_replies: true, quiet_start: null, quiet_end: null, quiet_tz: 'Asia/Kolkata', preview: 'full' },
    is_platform_admin: false,
  };
  setState((s) => ({ session: { ...s.session, status: 'signed_in', userId: ME, email: me.email }, me, orgs: me.orgs }));
}

let phone = false;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  phone = false;
  resetState();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin screen', () => {
  test('a member gets a friendly denied state and no admin calls', async () => {
    signIn('member');
    render(<AdminScreen orgId={ORG} section="members" />);
    expect(await screen.findByText('Admin is for organization admins')).toBeTruthy();
    expect(screen.getByText(/You are a member of Dek QA/)).toBeTruthy();
    expect(api.listJoinRequests).not.toHaveBeenCalled();
    expect(api.listReports).not.toHaveBeenCalled();
  });

  test('a guest is told the same, as a guest', async () => {
    signIn('guest');
    render(<AdminScreen orgId={ORG} section="overview" />);
    expect(await screen.findByText(/You are a guest of Dek QA/)).toBeTruthy();
  });

  test('an owner sees the overview with counts loading from the server', async () => {
    signIn('owner');
    render(<AdminScreen orgId={ORG} section="overview" />);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeTruthy();
    await waitFor(() => expect(api.listJoinRequests).toHaveBeenCalledWith(ORG, 'pending'));
  });
});

describe('invite dialog', () => {
  const server: Server = { id: '33333333-3333-4333-8333-333333333333', org_id: ORG, name: 'Medical Partnerships', description: null, icon_emoji: null, position: 0, join_policy: 'invite', archived: false, my_role: 'admin', member_count: 4, access: 'member' };
  const settings = { edit_window_minutes: null, allow_guests: true, member_can_create_channels: true, member_can_invite: false, default_invite_hours: 168 };

  test('Ask to join keeps invite links available and clearly requires approval for them', async () => {
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.createInvite).mockResolvedValue({ id: 'qa-invite', code: 'qa-example-link', expires_at: '2026-10-30T12:00:00Z', url_path: '/invite/qa-example-link' });
    render(<InviteDialog orgId={ORG} orgName="Dek QA" settings={settings} servers={[{ ...server, join_policy: 'approval' }]}
      initialServerId={server.id} onClose={() => undefined} onCreated={() => undefined} />);
    const approval = screen.getByRole('switch', { name: 'An admin approves each person' });
    expect(approval.getAttribute('aria-checked')).toBe('true');
    expect((approval as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Required while this server uses Ask to join/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link' })); });
    expect(await screen.findByText(/Anyone with this link can ask to join/)).toBeTruthy();
  });

  test('validates the use limit and email, then shows the public link the server made', async () => {
    vi.mocked(api.listChannels).mockResolvedValue([] as Channel[]);
    vi.mocked(api.createInvite).mockResolvedValue({ id: 'inv', code: 'AbCdEfGhIjKlMnOpQrStUv', expires_at: '2026-10-10T12:00:00Z', url_path: '/invite/AbCdEfGhIjKlMnOpQrStUv' });
    const onCreated = vi.fn();
    render(<InviteDialog orgId={ORG} orgName="Dek QA" settings={settings} servers={[server]} onClose={() => undefined} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Use limit (optional)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Only for this email (optional)'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText(/whole number from 1 to 10000/)).toBeTruthy();
    expect(screen.getByText(/Enter an email address/)).toBeTruthy();
    expect(api.createInvite).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Use limit (optional)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Only for this email (optional)'), { target: { value: 'new.person@example.org' } });
    fireEvent.change(screen.getByLabelText('Team server (optional)'), { target: { value: server.id } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link' })); });

    expect(api.createInvite).toHaveBeenCalledWith({
      org: ORG, server: server.id, channelIds: [], role: 'member', email: 'new.person@example.org',
      expiresHours: 168, maxUses: 5, requiresApproval: false,
    });
    expect(await screen.findByText('Invite link ready')).toBeTruthy();
    const link = screen.getByLabelText('Invite link') as HTMLInputElement;
    expect(link.value).toBe('https://dek-7o4.pages.dev/invite/AbCdEfGhIjKlMnOpQrStUv');
    expect(onCreated).toHaveBeenCalled();
  });

  test('a refusal keeps the form and offers a retry when retrying can help', async () => {
    vi.mocked(api.listChannels).mockResolvedValue([] as Channel[]);
    vi.mocked(api.createInvite).mockRejectedValueOnce(new DekError('network'));
    render(<InviteDialog orgId={ORG} orgName="Dek QA" settings={settings} servers={[server]} onClose={() => undefined} onCreated={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Use limit (optional)'), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create link' })); });
    expect(await screen.findByText(/offline or the connection dropped/)).toBeTruthy();
    expect((screen.getByLabelText('Use limit (optional)') as HTMLInputElement).value).toBe('3');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('account deletion', () => {
  test('needs DELETE typed, and explains the last-owner refusal', async () => {
    signIn('owner');
    vi.mocked(api.requestAccountDeletion).mockRejectedValue(new DekError('conflict', 'You are the last owner of Dek QA. Make someone else an owner first.'));
    render(<AccountSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    const confirm = await screen.findByRole('button', { name: 'Delete account' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(await screen.findByText(/You are the last owner of Dek QA/)).toBeTruthy();
    expect(api.requestAccountDeletion).toHaveBeenCalledTimes(1);
  });

  test('explains what is deleted and what the organization keeps', () => {
    signIn('member');
    render(<AccountSection />);
    expect(screen.getByText(/Kept by the organizations:/)).toBeTruthy();
    expect(screen.getAllByText(/Deleted user/).length).toBeGreaterThan(0);
  });
});

describe('settings on a phone', () => {
  test('/settings is a menu; a section is a layer with a back button', async () => {
    phone = true;
    signIn('member');
    window.history.replaceState(null, '', '/settings');
    const { unmount } = render(<SettingsScreen section="profile" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Notifications/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Profile' })).toBeNull();
    unmount();
    window.history.replaceState(null, '', '/settings/profile');
    render(<SettingsScreen section="profile" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Profile and status' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBeTruthy();
  });
});

describe('install', () => {
  test('always shows the iPhone Home Screen steps, never "not supported"', () => {
    signIn('member');
    render(<InstallSection />);
    expect(screen.getByRole('heading', { name: 'On an iPhone or iPad' })).toBeTruthy();
    expect(screen.getByText('Add to Home Screen')).toBeTruthy();
    expect(screen.queryByText(/not supported/i)).toBeNull();
  });
});

describe('signing out with unsent messages', () => {
  test('explains it and offers to sign out anyway, which forces it', async () => {
    const { registerActions } = await import('../../src/store');
    const signOut = vi.fn()
      .mockRejectedValueOnce(new DekError('conflict', '1 message has not been sent yet. Signing out deletes it from this device.'))
      .mockResolvedValueOnce(undefined);
    registerActions({ signOut });
    signIn('member');
    render(<AccountSection />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
    expect(await screen.findByText('You have unsent messages.')).toBeTruthy();
    expect(screen.getByText(/1 message has not been sent yet/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' })); });
    expect(signOut).toHaveBeenLastCalledWith({ force: true });
    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
