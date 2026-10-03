import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Button, Modal, supportsModalDialog } from '../../src/ui/kit';

// iOS 15.0 to 15.3 have no HTMLDialogElement.showModal (nor close).
const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
const original = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
};

function removeNativeModal() {
  delete proto.showModal;
  delete proto.close;
}

function restoreNativeModal() {
  if (original.showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original.showModal);
  else delete proto.showModal;
  if (original.close) Object.defineProperty(HTMLDialogElement.prototype, 'close', original.close);
  else delete proto.close;
}

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => { onClose(); setOpen(false); };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      <Modal open={open} onClose={close} title="Rename"
        footer={<><Button onClick={close}>Cancel</Button><Button variant="primary">Save</Button></>}>
        <input aria-label="Name" />
      </Modal>
    </>
  );
}

function dialog(): HTMLDialogElement {
  return document.querySelector('dialog.dk-modal') as HTMLDialogElement;
}

describe('Modal without native dialog support', () => {
  beforeEach(removeNativeModal);
  afterEach(() => { cleanup(); restoreNativeModal(); });

  it('opens as an overlay, moves focus in, and Escape closes it and gives focus back', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    opener.focus();
    fireEvent.click(opener);

    const d = dialog();
    expect(supportsModalDialog(d)).toBe(false);
    expect(d.hasAttribute('open')).toBe(true);
    expect(d.classList.contains('dk-modal--fallback')).toBe(true);
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy();
    expect(d.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    fireEvent.click(screen.getByRole('textbox', { name: 'Name' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    render(<Harness onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const d = dialog();
    const inside = Array.from(d.querySelectorAll<HTMLElement>('button, input'));
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    // Focus that lands outside is brought back in.
    screen.getByRole('button', { name: 'Open it' }).focus();
    expect(d.contains(document.activeElement)).toBe(true);
  });
});

describe('Modal with native dialog support', () => {
  afterEach(() => { cleanup(); restoreNativeModal(); });

  it('uses showModal and close, with no fallback overlay', () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
    const close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, writable: true, value: showModal });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, writable: true, value: close });
    render(<Harness onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog().classList.contains('dk-modal--fallback')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
