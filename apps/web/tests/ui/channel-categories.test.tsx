import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { resetState, setState } from '../../src/store';
import { ChannelTree } from '../../src/features/shell/ChannelTree';
import { categoryPreferenceId, collapsedSections, setCollapsed } from '../../src/features/shell/ui-store';
import { ORG, USER, CHAN, SERVER, server, channel } from './collaboration-fixture';

const props = { orgId: ORG, activeChannelId: null, onOpen: vi.fn(), variant: 'sidebar' as const };
beforeEach(() => {
  window.localStorage.clear(); resetState();
  setState({ session: { status: 'signed_in', userId: USER, email: null, setup: null }, servers: { [SERVER]: server }, channels: { [CHAN]: channel } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('channel category disclosure', () => {
  it('uses a labelled native button and retains a controlled hidden list and unread cues', () => {
    render(<ChannelTree {...props} />);
    const toggle = screen.getByRole('button', { name: 'Projects' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list.tagName).toBe('UL');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(list.hasAttribute('hidden')).toBe(true);
    expect(within(toggle).getByText('1 unread')).toBeTruthy();
    expect(toggle.textContent).toContain('1');
    expect(screen.queryByRole('link', { name: /coordination/ })).toBeNull();
    fireEvent.click(toggle);
    expect(list.hasAttribute('hidden')).toBe(false);
  });

  it('persists only the authenticated user/org/server/category preference and shows current location', () => {
    const view = render(<ChannelTree {...props} activeChannelId={CHAN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByText('Current: #coordination')).toBeTruthy();
    expect(collapsedSections(USER)[categoryPreferenceId(ORG, SERVER, 'Projects')]).toBe(true);
    view.unmount();
    render(<ChannelTree {...props} variant="home" />);
    expect(screen.getByRole('button', { name: /Projects/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps same-name categories independent across servers and users', () => {
    const other = { ...server, id: '0b000000-0000-4000-8000-000000000002', name: 'Other team' };
    const otherChannel = { ...channel, id: '0c000000-0000-4000-8000-000000000002', server_id: other.id, name: 'other-project' };
    setState({ servers: { [SERVER]: server, [other.id]: other }, channels: { [CHAN]: channel, [otherChannel.id]: otherChannel } });
    render(<ChannelTree {...props} />);
    const toggles = screen.getAllByRole('button', { name: 'Projects' });
    fireEvent.click(toggles[0]!);
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
    setState({ session: { status: 'signed_in', userId: 'different-user', email: null, setup: null } });
    return vi.waitFor(() => expect(screen.getAllByRole('button', { name: 'Projects' }).every(b => b.getAttribute('aria-expanded') === 'true')).toBe(true));
  });

  it('keeps the same category independent in another organization and resets renamed categories', () => {
    setCollapsed(USER, categoryPreferenceId('other-org', SERVER, 'Projects'), true);
    const view = render(<ChannelTree {...props} />);
    expect(screen.getByRole('button', { name: 'Projects' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    setState({ channels: { [CHAN]: { ...channel, category: 'Renamed' } } });
    return vi.waitFor(() => expect(screen.getByRole('button', { name: 'Renamed' }).getAttribute('aria-expanded')).toBe('true')).then(() => view.unmount());
  });

  it('works without local storage and never makes uncategorized or inaccessible channels into category entries', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    setState({ channels: { [CHAN]: channel, loose: { ...channel, id: 'loose', name: 'loose', category: null }, hidden: { ...channel, id: 'hidden', category: 'Hidden', member: false } } });
    render(<ChannelTree {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByRole('button', { name: /Projects/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull();
    expect(screen.getByText('loose')).toBeTruthy();
  });
});
