import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('../../src/features/calls', () => ({ CallButton: () => null }));
vi.mock('../../src/features/conversation/panels', () => ({ useLeaveChannel: () => ({ ask: vi.fn(), dialog: null }) }));
import { ConversationHeader } from '../../src/features/conversation/ConversationHeader';
import { navigate, parse } from '../../src/app/router';
import { ORG, USER, CHAN, server, channel } from './collaboration-fixture';
const props = { channel, orgId: ORG, who: { meId: USER, orgRole: 'member' as const, server }, phone: false, pane: null };
beforeEach(() => navigate({ name: 'channel', orgId: ORG, channelId: CHAN, messageId: null, threadId: USER, threadMessageId: CHAN }));
afterEach(cleanup);

describe('contextual conversation search', () => {
  it('opens a scoped search and preserves the original thread/reply return target', () => {
    render(<ConversationHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    const r = parse(window.location.href);
    expect(r.name).toBe('search');
    if (r.name !== 'search') throw new Error('Expected search');
    expect(r.scope?.in).toBe(CHAN);
    expect(r.scope?.back).toBe(`/o/${ORG}/c/${CHAN}/t/${USER}/m/${CHAN}`);
  });
  it('has a phone menu entry and keyboard shortcut', () => {
    render(<ConversationHeader {...props} phone />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation options' }));
    expect(screen.getByRole('menuitem', { name: 'Search this conversation' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(parse(window.location.href).name).toBe('search');
  });
  it('leaves editor, dialog and modified shortcuts to their normal handlers', () => {
    const view = render(<><ConversationHeader {...props} /><textarea aria-label="Draft" /><div role="dialog" /></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Draft' }), { key: 'f', ctrlKey: true });
    expect(parse(window.location.href).name).toBe('channel');
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(parse(window.location.href).name).toBe('channel');
    view.rerender(<><ConversationHeader {...props} /><textarea aria-label="Draft" /></>);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true });
    expect(parse(window.location.href).name).toBe('channel');
  });
  it('preserves native modal dialogs when the focused target is a button', () => {
    render(<><ConversationHeader {...props} /><dialog open><button>Modal action</button></dialog></>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Modal action' }), { key: 'f', ctrlKey: true });
    expect(parse(window.location.href).name).toBe('channel');
  });
});
