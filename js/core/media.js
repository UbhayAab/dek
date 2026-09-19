// Media: upload through the mint-upload edge function, inline render, and an
// in-app viewer. The hard rule for this product: tapping media NEVER hands off to
// another app or another tab. Everything renders in-page.
import { SUPABASE_URL, PUBLISHABLE, MAX_UPLOAD_BYTES } from '../config.js';
import { sb, accessToken } from '../sb.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, el, fmtSize } from '../util.js';
import { icon } from '../icons.js';
import { toast, escPush } from '../ui.js';

// Persistent per-key expiry stored alongside the URL in IndexedDB.
// This is the single source of truth for "does this cached URL still work?".
// Falls back to URL_TTL_MS soft-limit only if the DB row is missing expiry.
const urlCache = new Map();
let audioRefreshInstalled = false;

async function sha256hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function probeDims(file) {
  const t = file.type || '';
  if (t.startsWith('image/')) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight, ms: null }); URL.revokeObjectURL(u); };
      img.onerror = () => { res(null); URL.revokeObjectURL(u); };
      img.src = u;
    });
  }
  if (t.startsWith('video/')) {
    return new Promise((res) => {
      const u = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        res({ w: v.videoWidth, h: v.videoHeight, ms: Math.round((v.duration || 0) * 1000) });
        URL.revokeObjectURL(u);
      };
      v.onerror = () => { res(null); URL.revokeObjectURL(u); };
      v.src = u;
    });
  }
  return Promise.resolve(null);
}

// A 2-4MB phone photo as a chat attachment was the storage ceiling's fastest
// route to a dead product: at 200 users the 1GB free bucket filled in three
// days. Downscale in the browser before anything else runs - 1600px long edge
// at q0.82 is indistinguishable in a message and lands at 150-300KB, an 8-15x
// cut. Small images, non-images and anything that fails to decode pass through
// untouched; a failed optimisation must never block an upload.
const IMAGE_DOWNSCALE_MIN = 400 * 1024;
const IMAGE_MAX_EDGE = 1600;
// The inline box is capped at 340 CSS px; a 700px thumb stays retina-sharp at
// 2x while cutting the bytes a scrolled-in message actually downloads by ~3.5x.
// Carried separately (data-thumb) so the lightbox and Save keep the full image.
const THUMB_MAX_EDGE = 700;

export async function makeThumb(file) {
  if (!/^image\//.test(file.type) || file.type === 'image/gif') return null;
  try {
    const bmp = await createImageBitmap(file);
    const longest = Math.max(bmp.width, bmp.height);
    if (longest <= THUMB_MAX_EDGE) { bmp.close?.(); return null; }
    const scale = THUMB_MAX_EDGE / longest;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.75));
    if (!blob || blob.size >= file.size) return null;
    return blob;
  } catch {
    return null;
  }
}

async function downscaleImage(file) {
  if (!/^image\//.test(file.type) || file.type === 'image/gif' || file.size < IMAGE_DOWNSCALE_MIN) return file;
  try {
    const bmp = await createImageBitmap(file);
    const longest = Math.max(bmp.width, bmp.height);
    if (longest <= IMAGE_MAX_EDGE) { bmp.close?.(); return file; }
    const scale = IMAGE_MAX_EDGE / longest;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.82));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || 'image').replace(/\.jpe?g$/i, type === 'image/png' ? '.png' : '.jpg');
    return new File([blob], name, { type, lastModified: Date.now() });
  } catch {
    return file;
  }
}

export async function uploadFile(file, onProgress) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Too large (max ${fmtSize(MAX_UPLOAD_BYTES)})`);
  file = await downscaleImage(file);
  const buf = await file.arrayBuffer();
  const sha = await sha256hex(buf);
  const d = await probeDims(file);
  const mime = file.type || 'application/octet-stream';
  onProgress?.(0.2);

  const res = await fetch(SUPABASE_URL + '/functions/v1/mint-upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await accessToken()),
      apikey: PUBLISHABLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workspace_id: store.ws.id, mime, byte_size: file.size, sha256: sha }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'upload rejected');
  onProgress?.(0.4);

  // Content-addressed: an identical file already stored is reused, no re-upload.
  if (!j.deduped) {
    // cacheControl makes the storage object itself immutable-grade: the SW
    // attachment cache revalidates against it and a year matches the
    // content-addressed intent of the sha256 key. (mint-upload's addressing
    // is unconfirmed, so the SW still serves stale-while-revalidate.)
    const { error } = await sb.storage.from('attachments')
      .uploadToSignedUrl(j.object_key, j.token, file, { cacheControl: '31536000', contentType: mime });
    if (error) throw error;
    onProgress?.(0.9);
    await api.finalizeAttachment({
      objectKey: j.object_key, sha256: '\\x' + sha, mime, byteSize: file.size,
      width: d?.w ?? null, height: d?.h ?? null, durationMs: d?.ms ?? null, thumbhash: null,
    });
  }

  // Thumbnail: a second independent content-addressed upload through the same
  // mint pipeline. The attachment row's schema is not in this repo, so the
  // thumb key travels inside the message's jsonb attachments instead of
  // finalize_attachment - old clients ignore the unknown field. Any failure
  // here degrades to the full image and must never fail the upload itself.
  let thumbKey = null;
  try {
    const tb = await makeThumb(file);
    if (tb) {
      const tbuf = await tb.arrayBuffer();
      const tsha = await sha256hex(tbuf);
      const tres = await fetch(SUPABASE_URL + '/functions/v1/mint-upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + (await accessToken()),
          apikey: PUBLISHABLE,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspace_id: store.ws.id, mime: tb.type, byte_size: tb.size, sha256: tsha }),
      });
      const tj = await tres.json();
      if (tres.ok && tj.object_key) {
        if (!tj.deduped) {
          await sb.storage.from('attachments')
            .uploadToSignedUrl(tj.object_key, tj.token, tb, { cacheControl: '31536000', contentType: tb.type });
        }
        thumbKey = tj.object_key;
      }
    }
  } catch { thumbKey = null; }

  onProgress?.(1);
  return {
    object_key: j.object_key, thumb_key: thumbKey, mime, width: d?.w, height: d?.h,
    duration_ms: d?.ms, name: file.name, size: file.size,
  };
}

// L2 for minted URLs: IndexedDB, so scrolling back after a RELOAD reuses the
// still-valid signed URL instead of paying a fresh edge-function invocation per
// attachment. The in-memory Map stays the fast path; this is the cold path.
const URL_DB = 'dak.media';
const LEGACY_URL_DB = 'dek-backend.media';   // dropped once, below, after the first open
const URL_STORE = 'urls';
const URL_TTL_MS = 230000;   // soft under-the-mint-lifetime fallback; real expiry from edge fn

let legacyDbDropped = false;
function urlDb() {
  return new Promise((resolve) => {
    const rq = indexedDB.open(URL_DB, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(URL_STORE)) rq.result.createObjectStore(URL_STORE); };
    rq.onsuccess = () => {
      // The cache moved off the first product name; the old database holds
      // nothing but signed URLs that expire anyway. Fire-and-forget, once.
      if (!legacyDbDropped) {
        legacyDbDropped = true;
        try { indexedDB.deleteDatabase(LEGACY_URL_DB); } catch { /* best effort */ }
      }
      resolve(rq.result);
    };
    rq.onerror = () => resolve(null);
  });
}
async function urlIdbGet(key) {
  const db = await urlDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const rq = db.transaction(URL_STORE).objectStore(URL_STORE).get(key);
    rq.onsuccess = () => {
      const v = rq.result;
      if (!v) return resolve(null);
      // Use stored real expiry if present; otherwise fall back to soft TTL.
      const exp = v.exp != null ? v.exp : Date.now() + URL_TTL_MS;
      resolve(v.exp > Date.now() ? v.url : null);
    };
    rq.onerror = () => resolve(null);
  });
}
async function urlIdbSet(key, url, exp) {
  const db = await urlDb();
  if (!db) return;
  try { db.transaction(URL_STORE, 'readwrite').objectStore(URL_STORE).put({ url, exp: exp != null ? exp : Date.now() + URL_TTL_MS }, key); } catch {}
}

export async function mediaUrl(key) {
  if (urlCache.has(key)) return urlCache.get(key);
  const persisted = await urlIdbGet(key);
  if (persisted) {
    urlCache.set(key, persisted);
    setTimeout(() => urlCache.delete(key), URL_TTL_MS);
    return persisted;
  }
  const res = await fetch(SUPABASE_URL + '/functions/v1/mint-download', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await accessToken()),
      apikey: PUBLISHABLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ object_key: key }),
  });
  const j = await res.json().catch(() => ({}));
  // The deployed function answers { url } for a single key and { urls } for a
  // batch. Both are accepted here because the copy of that function checked into
  // supabase/functions/mint-download/index.ts is STALE - it returns { urls } for
  // both, and has no authorisation at all. Whoever redeploys from that file will
  // change this contract and open the bucket at the same time; accepting either
  // shape means at least the faces keep working when they do.
  const url = j.url || j.urls?.[key] || null;
  if (!res.ok || !url) return null;
  urlCache.set(key, url);
  // Store with real expiry from the edge function if provided.
  const exp = j.exp != null ? j.exp : Date.now() + URL_TTL_MS;
  urlIdbSet(key, url, exp);
  // Drop the cache entry well before the real expiry.
  setTimeout(() => urlCache.delete(key), URL_TTL_MS);
  return url;
}

export async function mediaUrls(keys) {
  if (!keys || keys.length === 0) return Promise.resolve([]);
  const persisted = {};
  const toFetch = new Set(keys);
  // L1 first: anything the memory map holds (including known-missing keys,
  // which the tail stores as null) never touches disk or wire.
  for (const key of keys) {
    if (urlCache.has(key)) {
      persisted[key] = urlCache.get(key);
      toFetch.delete(key);
    }
  }
  // L2 second, awaited per key: these gets used to be fire-and-forget, so
  // missing[] below was computed before any onsuccess ran and the read side
  // of this cache could never answer, making every batch call refetch all
  // keys even straight after a reload.
  const db = await urlDb();
  if (db && toFetch.size) {
    await Promise.all([...toFetch].map((key) => new Promise((res) => {
      let rq;
      try { rq = db.transaction(URL_STORE).objectStore(URL_STORE).get(key); } catch { return res(); }
      rq.onsuccess = () => {
        const v = rq.result;
        if (v && v.exp > Date.now()) {
          persisted[key] = v.url;
          toFetch.delete(key);
        }
        res();
      };
      rq.onerror = () => res();
    })));
  }
  const missing = [...toFetch];
  if (!missing.length) {
    const urls = keys.map((k) => persisted[k] || null);
    urls.forEach((u, i) => urlCache.set(keys[i], u));
    return Promise.resolve(urls);
  }
  const res = await fetch(SUPABASE_URL + '/functions/v1/mint-download', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + (await accessToken()),
      apikey: PUBLISHABLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ object_keys: missing }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.urls) return keys.map(() => null);
  for (const [key, url] of Object.entries(j.urls)) {
    const exp = j.exp != null ? j.exp : Date.now() + URL_TTL_MS;
    urlIdbSet(key, url, exp);
    urlCache.set(key, url);
  }
  const urls = keys.map((k) => persisted[k] || j.urls[k] || null);
  urls.forEach((u, i) => urlCache.set(keys[i], u));
  return Promise.resolve(urls);
}

// Markup only. Real sources are attached later by hydrateMedia so the layout box
// is reserved up front (no shift when the image arrives).
export function attsHtml(m) {
  const a = Array.isArray(m.attachments) ? m.attachments : [];
  if (!a.length) return '';
  return '<div class="atts">' + a.map((x) => {
    const mime = x.mime || '';
    // Coerced, not escaped, because both of these land INSIDE a style attribute
    // where esc() would not help anyway. Math.min already neutralised w by
    // forcing it through arithmetic; ratio went in raw, and an attachment's
    // width and height are written by whoever sent the message
    // (composer.js -> p_attachments), so a value carrying a double quote closed
    // the style attribute and opened an attribute of its own. On this origin
    // that is a read of the session out of localStorage, which is the whole
    // account - and inside a dashboard it is a read of the dashboard too.
    const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
    const ratio = num(x.width, 0) && num(x.height, 0)
      ? `${num(x.width, 4)}/${num(x.height, 3)}` : '4/3';
    const w = Math.min(340, num(x.width, 340));
    if (mime.startsWith('image/')) {
      return `<div class="att-img" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'image')}"${x.thumb_key ? ` data-thumb="${esc(x.thumb_key)}"` : ''}
        style="width:${w}px;aspect-ratio:${ratio}"><img loading="lazy" alt="${esc(x.name || 'image')}"></div>`;
    }
    if (mime.startsWith('video/')) {
      return `<div class="att-vid" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'video')}"
        style="width:${w}px;aspect-ratio:${ratio}"><video playsinline webkit-playsinline preload="metadata"
        controls disablepictureinpicture x-webkit-airplay="deny"></video></div>`;
    }
    if (mime.startsWith('audio/')) {
      // A voice note is not "an audio file called
      // voice-note-0m02s.webm". It is somebody talking, and the name is machine
      // spelling nobody asked to read - on a phone it truncated to
      // "voice-note-0m02s...." beside a squeezed player, which is what the
      // report was a picture of. features/voicenotes.js mints exactly this
      // shape, so the duration is already in the name and can be shown as a
      // duration instead.
      const vn = /^voice-note-(\d+)m(\d+)s\./.exec(x.name || '');
      if (vn) {
        const label = `${+vn[1]}:${String(+vn[2]).padStart(2, '0')}`;
        return `<div class="att-aud att-voice" data-key="${esc(x.object_key)}">
          <span class="att-aud-head"><span class="att-ico">${icon('mic')}</span>
            <b>Voice note</b><span class="muted">${esc(label)}</span></span>
          <audio controls preload="metadata"></audio></div>`;
      }
      return `<div class="att-aud" data-key="${esc(x.object_key)}">
        <span class="att-aud-head"><span class="att-ico">${icon('mic')}</span>
          <span class="att-aud-name">${esc(x.name || 'audio')}</span></span>
        <audio controls preload="metadata"></audio></div>`;
    }
    return `<div class="att-file" data-key="${esc(x.object_key)}" data-name="${esc(x.name || 'file')}">
      <span class="att-ico">${icon('doc')}</span><span>${esc(x.name || 'file')}</span>
      <span class="muted">${esc(fmtSize(x.size))}</span></div>`;
  }).join('') + '</div>';
}

export async function hydrateMedia(root) {
  const keys = new Set();
  const imgs = [...root.querySelectorAll('.att-img')];
  for (const box of imgs) {
    keys.add(box.dataset.key);
    // Thumbs ride the same batched mint-download call as every other key; the
    // inline img prefers one when present, while openViewer and Save below
    // keep reading data-key (the full image) exactly as before.
    if (box.dataset.thumb) keys.add(box.dataset.thumb);
  }
  const vids = [...root.querySelectorAll('.att-vid')];
  for (const box of vids) keys.add(box.dataset.key);
  const auds = [...root.querySelectorAll('.att-aud')];
  for (const box of auds) keys.add(box.dataset.key);
  const fcs = [...root.querySelectorAll('.att-file')];
  for (const fc of fcs) keys.add(fc.dataset.key);

  // Voice notes go stale: the signed URL minted at render time dies within
  // minutes, and pressing play an hour later did nothing - the single worst
  // voice-note bug in field testing. One delegated listener, installed once,
  // re-mints on demand and hands playback to the fresh URL.
  if (!audioRefreshInstalled) {
    audioRefreshInstalled = true;
    document.addEventListener('play', (e) => {
      const a = e.target;
      const box = a?.closest?.('.att-aud');
      if (!box?.dataset.key || !a.dataset.stale) return;
      a.dataset.stale = '';
      mediaUrl(box.dataset.key).then((url) => {
        if (!url) return;
        a.src = url;
        a.play().catch(() => {});
      }).catch(() => {});
    }, true);
    document.addEventListener('error', (e) => {
      const a = e.target;
      const box = a?.closest?.('.att-aud');
      if (!box?.dataset.key || a.tagName !== 'AUDIO') return;
      a.dataset.stale = '1';
      mediaUrl(box.dataset.key).then((url) => { if (url) { a.dataset.stale = ''; a.src = url; } }).catch(() => {});
    }, true);
  }

  const urlArray = await mediaUrls(Array.from(keys));
  const urlByKey = new Map(Array.from(keys).map((k, i) => [k, urlArray[i]]));

  for (const box of imgs) {
    const url = urlByKey.get(box.dataset.thumb) || urlByKey.get(box.dataset.key);
    if (!url) { box.classList.add('att-broken'); continue; }
    box.querySelector('img').src = url;
    box.onclick = () => openViewer(imgs.map((b) => ({
      key: b.dataset.key, name: b.dataset.name, kind: 'image',
    })), imgs.indexOf(box));
  }
  let i = 0;
  for (const box of vids) {
    const key = box.dataset.key;
    const url = urlByKey.get(key);
    if (url) box.querySelector('video').src = url;
  }
  i = 0;
  for (const box of auds) {
    const key = box.dataset.key;
    const url = urlByKey.get(key);
    if (url) {
      const a = box.querySelector('audio');
      a.src = url;
      // Minted URLs are short-lived; anything not played within minutes needs
      // the refresh path above.
      a.dataset.stale = '1';
    }
  }
  i = 0;
  for (const fc of fcs) {
    const key = fc.dataset.key;
    const url = urlByKey.get(key);
    fc.onclick = async () => {
      if (url) saveBlob(url, fc.dataset.name);
      else toast('Could not open that file', 'error');
    };
  }
}

// In-app viewer with pan/zoom and keyboard nav. No navigation, no new tab, no
// external app: the whole point of the product's media promise.
export async function openViewer(items, startIndex = 0) {
  let i = startIndex;
  const lb = el('div', 'lightbox');
  lb.innerHTML = `
    <div class="lb-stage"><img alt=""></div>
    <div class="lb-bar">
      <button class="ghost" data-a="zoomout">−</button>
      <button class="ghost" data-a="zoomin">+</button>
      <button class="ghost" data-a="save">Save</button>
      <button class="ghost" data-a="close">✕</button>
    </div>
    <button class="lb-nav lb-prev" data-a="prev">‹</button>
    <button class="lb-nav lb-next" data-a="next">›</button>
    <div class="lb-count"></div>`;
  const img = lb.querySelector('img');
  const stage = lb.querySelector('.lb-stage');
  let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;

  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  async function show() {
    const it = items[i];
    lb.querySelector('.lb-count').textContent = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    lb.querySelector('.lb-prev').style.display = items.length > 1 ? '' : 'none';
    lb.querySelector('.lb-next').style.display = items.length > 1 ? '' : 'none';
    reset();
    img.src = (await mediaUrl(it.key)) || '';
  }
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); escDispose(); };
  const onKey = (e) => {
    if (e.key === 'ArrowRight' && items.length > 1) { i = (i + 1) % items.length; show(); }
    else if (e.key === 'ArrowLeft' && items.length > 1) { i = (i - 1 + items.length) % items.length; show(); }
    else if (e.key === '+' || e.key === '=') { scale = Math.min(6, scale * 1.3); apply(); }
    else if (e.key === '-') { scale = Math.max(1, scale / 1.3); if (scale === 1) { tx = ty = 0; } apply(); }
  };
  document.addEventListener('keydown', onKey);
  // Escape belongs to the LIFO close stack now (ui.js): the lightbox was
  // invisible to the old CSS census, so the same press used to pop the panel
  // behind it - or post an embed close-request while somebody was merely
  // looking at an image.
  const escDispose = escPush(close);

  lb.onclick = (e) => {
    const a = e.target.dataset?.a;
    if (a === 'close' || e.target === lb || e.target === stage) return close();
    if (a === 'prev') { i = (i - 1 + items.length) % items.length; show(); }
    if (a === 'next') { i = (i + 1) % items.length; show(); }
    if (a === 'zoomin') { scale = Math.min(6, scale * 1.3); apply(); }
    if (a === 'zoomout') { scale = Math.max(1, scale / 1.3); if (scale === 1) { tx = ty = 0; } apply(); }
    if (a === 'save') mediaUrl(items[i].key).then((u) => u && saveBlob(u, items[i].name));
  };
  img.ondblclick = () => { scale = scale > 1 ? 1 : 2.5; tx = ty = 0; apply(); };
  img.onwheel = (e) => {
    e.preventDefault();
    scale = Math.max(1, Math.min(6, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    if (scale === 1) { tx = ty = 0; }
    apply();
  };
  img.onpointerdown = (e) => {
    if (scale <= 1) return;
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
    img.setPointerCapture(e.pointerId);
  };
  img.onpointermove = (e) => { if (dragging) { tx = e.clientX - sx; ty = e.clientY - sy; apply(); } };
  img.onpointerup = () => { dragging = false; };

  document.body.appendChild(lb);
  await show();
}

// Save without ever navigating away: fetch to a blob, then a synthetic download.
// On iOS where downloads are awkward, fall back to the native share sheet, which
// offers "Save Image" without leaving the app.
export async function saveBlob(url, name) {
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name || 'download', { type: blob.type });
    if (navigator.canShare?.({ files: [file] }) && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      await navigator.share({ files: [file] });
      return;
    }
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  } catch {
    toast('Save failed', 'error');
  }
}
