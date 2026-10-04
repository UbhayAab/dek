// The sidebar's "Install the Dek app" button (Fixboard #1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

const state = {
  platform: {},
  installed: false,
  canPrompt: false,
  showIosSteps: false,
  iosOtherBrowser: false,
  prompt: vi.fn(async () => 'accepted' as const),
};
let native = false;
const navigate = vi.fn();

vi.mock('../../src/push/install', () => ({ useInstallPrompt: () => state }));
vi.mock('../../src/native', () => ({ isNativeApp: () => native }));
vi.mock('../../src/app/router', () => ({ navigate: (...a: unknown[]) => navigate(...a) }));

const { InstallAppButton } = await import('../../src/features/shell/InstallAppButton');

beforeEach(() => {
  Object.assign(state, { installed: false, canPrompt: false, showIosSteps: false, iosOtherBrowser: false });
  state.prompt.mockClear();
  navigate.mockClear();
  native = false;
  window.localStorage.clear();
});
afterEach(cleanup);

describe('InstallAppButton', () => {
  it('stays away when the browser cannot install and it is not an iPhone', () => {
    const { container } = render(<InstallAppButton />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the browser install dialog where Chromium offers one', async () => {
    state.canPrompt = true;
    render(<InstallAppButton />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Install the Dek app/ })); });
    expect(state.prompt).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends iPhone Safari (and other iPhone browsers) to the Home Screen steps', () => {
    state.showIosSteps = true;
    render(<InstallAppButton />);
    fireEvent.click(screen.getByRole('button', { name: /Install the Dek app/ }));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings', section: 'install' });
    cleanup();
    Object.assign(state, { showIosSteps: false, iosOtherBrowser: true });
    render(<InstallAppButton />);
    expect(screen.getByText('Add Dek to your Home Screen')).toBeTruthy();
  });

  it('is never shown inside the installed app or the native shells', () => {
    state.canPrompt = true;
    state.installed = true;
    expect(render(<InstallAppButton />).container.innerHTML).toBe('');
    cleanup();
    state.installed = false;
    native = true;
    expect(render(<InstallAppButton />).container.innerHTML).toBe('');
  });

  it('"Not now" hides it on this device for 14 days', () => {
    state.canPrompt = true;
    render(<InstallAppButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: /Install the Dek app/ })).toBeNull();
    cleanup();
    expect(render(<InstallAppButton />).container.innerHTML).toBe('');
    cleanup();
    window.localStorage.setItem('dek.installDismissedAt', String(Date.now() - 15 * 24 * 60 * 60 * 1000));
    render(<InstallAppButton />);
    expect(screen.getByRole('button', { name: /Install the Dek app/ })).toBeTruthy();
  });

  it('every target is at least the tap size', () => {
    state.canPrompt = true;
    render(<InstallAppButton />);
    for (const b of screen.getAllByRole('button')) expect(b.className).toMatch(/dk-install__(go|close)/);
  });
});
