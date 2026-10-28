// Where the emoji picker appears: a floating panel next to its button on desktop
// (portalled, so a list's scroll box cannot clip it), a bottom sheet on touch.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../ui/kit';
import { useCoarsePointer } from '../shell/layout';
import { useMeId } from '../shell/hooks';
import { EmojiPicker } from './emoji';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (ch: string) => void;
  anchor: HTMLElement | null;
  title?: string;
}

export function EmojiPopover({ open, onClose, onPick, anchor, title = 'Add reaction' }: Props) {
  const coarse = useCoarsePointer();
  const meId = useMeId();
  if (!open) return null;
  const pick = (ch: string) => {
    onPick(ch);
    onClose();
  };
  if (coarse) {
    return (
      <Modal open onClose={onClose} title={title} size="sm">
        <EmojiPicker userId={meId} onPick={pick} autoFocus={false} />
      </Modal>
    );
  }
  // autoFocus: the panel is portalled to the end of the page, so without it a keyboard
  // user could never reach the picker.
  return createPortal(
    <Floating anchor={anchor} onClose={onClose} label={title}>
      <EmojiPicker userId={meId} onPick={pick} autoFocus />
    </Floating>,
    document.body,
  );
}

const PANEL_W = 340;
const MARGIN = 8;

function Floating({ anchor, onClose, label, children }: { anchor: HTMLElement | null; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const r = anchor?.getBoundingClientRect() ?? { top: window.innerHeight / 2, bottom: window.innerHeight / 2, left: window.innerWidth / 2, right: window.innerWidth / 2 };
    const h = panel.offsetHeight;
    const w = Math.min(PANEL_W, window.innerWidth - MARGIN * 2);
    const below = r.bottom + MARGIN;
    const top = below + h <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, r.top - MARGIN - h);
    const left = Math.min(Math.max(MARGIN, r.right - w), window.innerWidth - w - MARGIN);
    setPos({ top, left });
  }, [anchor]);

  // Callers pass an inline onClose: reading it through a ref keeps this effect (and its
  // cleanup, which moves focus to the anchor) from re-running on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      // Focus returns to the button that opened the picker.
      if (anchor && document.contains(anchor)) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  return (
    <div
      ref={ref}
      className="dk-floating"
      role="dialog"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(PANEL_W, window.innerWidth - MARGIN * 2), visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  );
}
