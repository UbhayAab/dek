// The push banner (DEK16, DEKA08, DEKA09): an iPhone Safari tab gets the Home
// Screen steps, never "unsupported"; a denied permission never calls the browser
// prompt again, only shows where to allow it; the ask happens only from a click.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationPrompt } from '../../src/features/notifications';
import { resetState, setState } from '../../src/store/state';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

const requestPermission = vi.fn(async () => 'default' as NotificationPermission);

function browser(ua: string, permission: NotificationPermission | null, push: boolean): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  if (push) {
    Object.defineProperty(window.navigator, 'serviceWorker', { value: { getRegistration: async () => undefined }, configurable: true });
    (window as unknown as { PushManager?: unknown }).PushManager = function PushManager() {};
  } else {
    delete (window as unknown as { PushManager?: unknown }).PushManager;
  }
  if (permission) {
    (globalThis as unknown as { Notification: unknown }).Notification = { permission, requestPermission };
  } else {
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
  }
}

beforeEach(() => {
  resetState();
  setState({ session: { status: 'signed_in', userId: '0a0a0a0a-0000-4000-8000-000000000001', email: 'a@x.invalid', setup: null } });
  localStorage.clear();
  requestPermission.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('NotificationPrompt', () => {
  it('iPhone Safari tab: Home Screen steps, not "unsupported" (DEKA08)', () => {
    browser(IPHONE_SAFARI, null, false);
    render(<NotificationPrompt />);
    expect(screen.getByText('Get notifications on this iPhone')).toBeTruthy();
    expect(screen.queryByText(/unsupported|cannot/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    expect(screen.getByText(/iOS 16.4 or later/)).toBeTruthy();
  });

  it('denied: shows how to allow and never calls the browser prompt again (DEKA09)', () => {
    browser(ANDROID_CHROME, 'denied', true);
    render(<NotificationPrompt />);
    expect(screen.getByText('Notifications are blocked for Dek in this browser.')).toBeTruthy();
    expect(screen.getByText(/Unread counts still work inside Dek/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'How to allow' }));
    expect(screen.getByText(/Site settings/)).toBeTruthy();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks only from a click, and "Not now" hides every copy', async () => {
    browser(ANDROID_CHROME, 'default', true);
    render(<><NotificationPrompt /><NotificationPrompt /></>);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Turn on notifications' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn on notifications' })[0]!);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    // "Not now" is disabled while the browser's own prompt is open
    await vi.waitFor(() => expect((screen.getAllByRole('button', { name: 'Not now' })[0] as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getAllByText('Notifications were not turned on.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Not now' })[0]!);
    expect(screen.queryAllByRole('button', { name: 'Turn on notifications' })).toHaveLength(0);
  });

  it('renders nothing when signed out', () => {
    browser(ANDROID_CHROME, 'default', true);
    setState({ session: { status: 'signed_out', userId: null, email: null, setup: null } });
    const { container } = render(<NotificationPrompt />);
    expect(container.innerHTML).toBe('');
  });
});
