// Profile picture: pick, crop to a square (drag, zoom slider, arrow keys), resize
// to 256 px WebP in a canvas, upload to avatars/<user id>/<random>.webp, then
// update_profile(avatar_path). The old picture is removed once the new one is
// saved; a failed save removes the new upload so nothing is left behind.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { Avatar, Button, ConfirmDialog, Modal, toast } from '../../../ui/kit';
import { patchMyProfile, useMyId } from '../../admin/common/context';
import { XIcon } from '../../admin/common/icons';
import { asDekError, useAction } from '../../admin/common/load';
import { FormError } from '../../admin/common/ui';
import { DekError } from '../../../api/errors';
import {
  centered, checkPicture, loadPicture, MAX_ZOOM, MIN_ZOOM, panBy, removeAvatarObject, renderAvatar, sourceRect, uploadAvatar,
  zoomTo, coverScale, type CropState, type LoadedPicture,
} from '../crop';

export function AvatarEditor({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<LoadedPicture | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const myId = useMyId();
  const remove = useAction(() => api.updateProfile({ avatar_path: null }));

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const problem = checkPicture(file);
    if (problem) {
      setPickError(problem);
      return;
    }
    setPickError(null);
    setOpening(true);
    try {
      setPicture(await loadPicture(file));
    } catch (e) {
      setPickError(asDekError(e).hint);
    } finally {
      setOpening(false);
    }
  };

  const onRemove = async () => {
    const old = profile.avatar_path;
    const r = await remove.run();
    if (!r.ok) return;
    patchMyProfile(r.value);
    if (myId) void removeAvatarObject(myId, old);
    setConfirmRemove(false);
    toast({ kind: 'success', title: 'Picture removed' });
  };

  return (
    <div className="set-avatar">
      <Avatar name={profile.display_name} path={profile.avatar_path} seed={profile.id} size={72} />
      <div className="set-avatar__side">
        <div className="set-avatar__buttons">
          <Button icon="image" onClick={() => fileRef.current?.click()} loading={opening}>{profile.avatar_path ? 'Change picture' : 'Add a picture'}</Button>
          {profile.avatar_path ? <Button variant="ghost" onClick={() => setConfirmRemove(true)}>Remove</Button> : null}
        </div>
        <p className="ap-hint">JPEG, PNG, WebP or GIF up to 20 MB. You can crop it next.</p>
        {pickError ? <p className="ap-error-text" role="alert">{pickError}</p> : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/*"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose a profile picture"
          data-testid="avatar-file"
          onChange={(e) => { void onFile(e.target.files?.[0]); }}
        />
      </div>
      {picture && myId ? (
        <CropDialog
          picture={picture}
          userId={myId}
          oldPath={profile.avatar_path}
          onClose={() => { picture.release(); setPicture(null); }}
        />
      ) : null}
      {confirmRemove ? (
        <ConfirmDialog
          open
          title="Remove your picture?"
          body={<div className="ap-form"><p>People see your initials instead.</p><FormError error={remove.error} onRetry={onRemove} /></div>}
          confirmLabel="Remove picture"
          busy={remove.busy}
          onConfirm={onRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </div>
  );
}

type Phase = 'idle' | 'preparing' | 'uploading' | 'saving';

const PHASE_LABEL: Record<Phase, string> = { idle: 'Save picture', preparing: 'Preparing', uploading: 'Uploading', saving: 'Saving' };

function CropDialog({ picture, userId, oldPath, onClose }: { picture: LoadedPicture; userId: string; oldPath: string | null; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(280);
  const [st, setSt] = useState<CropState>(() => centered(picture.width, picture.height, 280));
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<DekError | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const { width: w, height: h } = picture;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const size = Math.round(el.getBoundingClientRect().width);
    if (size > 0 && size !== view) {
      setView(size);
      setSt(centered(w, h, size));
    }
  }, [view, w, h]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSt((prev) => zoomTo(w, h, view, prev, prev.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [w, h, view]);

  const s = coverScale(w, h, view) * st.zoom;
  const busy = phase !== 'idle';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setSt((prev) => panBy(w, h, view, prev, dx, dy));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      setSt((prev) => panBy(w, h, view, prev, mv[0], mv[1]));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setSt((prev) => zoomTo(w, h, view, prev, prev.zoom + 0.2));
    } else if (e.key === '-') {
      e.preventDefault();
      setSt((prev) => zoomTo(w, h, view, prev, prev.zoom - 0.2));
    }
  };

  const save = async () => {
    setError(null);
    let uploaded: string | null = null;
    try {
      setPhase('preparing');
      const rendered = await renderAvatar(picture.image, sourceRect(w, h, view, st));
      setPhase('uploading');
      uploaded = await uploadAvatar(userId, rendered);
      setPhase('saving');
      const profile = await api.updateProfile({ avatar_path: uploaded });
      patchMyProfile(profile);
      void removeAvatarObject(userId, oldPath);
      toast({ kind: 'success', title: 'Picture saved' });
      setPhase('idle');
      onClose();
    } catch (e) {
      if (uploaded) void removeAvatarObject(userId, uploaded);
      setError(asDekError(e));
      setPhase('idle');
    }
  };

  return (
    <Modal open size="sm" title="Crop your picture" onClose={onClose} dismissable={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>{PHASE_LABEL[phase]}</Button>
        </>
      )}>
      <div className="set-crop">
        <div
          ref={boxRef}
          className="set-crop__box"
          role="img"
          aria-label="Picture to crop. Drag or use the arrow keys to move it, plus and minus to zoom."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <img
            src={picture.url}
            alt=""
            draggable={false}
            className="set-crop__img"
            style={{ width: w * s, height: h * s, transform: `translate(${st.x}px, ${st.y}px)` }}
          />
          <span className="set-crop__ring" aria-hidden="true" />
        </div>
        <div className="set-crop__zoom">
          <XIcon name="zoomOut" size={18} />
          <label className="sr-only" htmlFor="set-crop-zoom">Zoom</label>
          <input
            id="set-crop-zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={st.zoom}
            disabled={busy}
            onChange={(e) => setSt((prev) => zoomTo(w, h, view, prev, Number(e.target.value)))}
          />
          <XIcon name="zoomIn" size={18} />
        </div>
        <p className="ap-hint">The square is your picture. It is saved at 256 by 256 pixels.</p>
        <FormError error={error} onRetry={save} />
      </div>
    </Modal>
  );
}
