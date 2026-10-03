// iOS does not resize the layout viewport for the on-screen keyboard, so a bottom
// composer ends up behind it. visualViewport tells us how much is covered; that
// becomes --kb on the root element and the layout pads by it (LESSONS "iPhone").
// On Android (interactive-widget=resizes-content) the layout already shrinks and
// --kb stays 0.
export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const covered = innerHeight - vvHeight - vvOffsetTop;
  return covered > 40 ? Math.round(covered) : 0;
}

export function installKeyboardInset(root: HTMLElement = document.documentElement): () => void {
  const vv = typeof window === 'undefined' ? null : window.visualViewport;
  if (!vv) return () => undefined;
  let last = -1;
  let frame = 0;
  const update = () => {
    frame = 0;
    const kb = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    if (kb !== last) {
      last = kb;
      root.style.setProperty('--kb', `${kb}px`);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  update();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
