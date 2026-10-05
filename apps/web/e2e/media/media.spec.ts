// DEK10, DEK11, DEKA11 end to end against the real project: real begin_upload,
// real Storage, the deployed media-finalize, real signed URLs, two people.
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, audit, emailOf, person, shotPath, showChannel, world } from './support';

interface Images { jpeg: string; png: string }

// A noisy 2400 x 1600 JPEG (well over 400 KB, so it gets downscaled) and an
// 800 x 600 PNG, drawn in the browser.
async function makeImages(page: Page): Promise<Images> {
  return page.evaluate(async () => {
    const draw = (w: number, h: number, noise: boolean) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0f766e');
      g.addColorStop(1, '#f59e0b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      if (noise) {
        const img = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (Math.random() * 70) | 0;
          img.data[i] = Math.min(255, img.data[i]! + n);
          img.data[i + 1] = Math.min(255, img.data[i + 1]! + n);
          img.data[i + 2] = Math.min(255, img.data[i + 2]! + n);
        }
        ctx.putImageData(img, 0, 0);
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(h / 7)}px sans-serif`;
      ctx.fillText('Dek QA', w * 0.08, h * 0.55);
      return c;
    };
    const b64 = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<string>((resolve) => {
      c.toBlob(async (blob) => {
        const buf = new Uint8Array(await (blob as Blob).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 1) s += String.fromCharCode(buf[i]!);
        resolve(btoa(s));
      }, type, q);
    });
    return { jpeg: await b64(draw(2400, 1600, true), 'image/jpeg', 0.95), png: await b64(draw(800, 600, false), 'image/png') };
  });
}

// A Windows program: MZ, then the PE header where e_lfanew points.
function windowsProgram(): Buffer {
  const b = Buffer.alloc(4096);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.write('This program cannot be run in DOS mode.', 0x4e, 'latin1');
  return b;
}

const fileInput = (page: Page) => page.locator('input[type="file"][data-upload-key]');

test.describe.configure({ mode: 'serial' });

test('alice uploads a generated JPEG and PNG into #general; bob sees them render through signed URLs', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.general });
  const images = await makeImages(alice.page);
  expect(Buffer.from(images.jpeg, 'base64').length).toBeGreaterThan(400 * 1024);

  await fileInput(alice.page).setInputFiles([
    { name: 'site-visit.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(images.jpeg, 'base64') },
    { name: 'floor-plan.png', mimeType: 'image/png', buffer: Buffer.from(images.png, 'base64') },
  ]);
  // progress shows while the bytes go up
  await expect(alice.page.locator('.dm-upload')).toHaveCount(2);
  await expect(alice.page.locator('.dm-upload[data-status="ready"]')).toHaveCount(2, { timeout: 90_000 });

  const stamp = `Photos from the site visit ${Date.now()}`;
  await alice.page.locator('#hx-draft').fill(stamp);
  await alice.page.getByRole('button', { name: 'Send' }).click();
  await expect(alice.page.locator('.dm-uploads')).toHaveCount(0);   // cleared only after the server accepted
  await expect(alice.page.locator('#hx-draft')).toHaveValue('');

  // What the server recorded: the photo downscaled to a 1600 px long edge, thumbnails for both.
  const sent = await alice.page.evaluate(async ([channel, body]) => {
    const m = (window as unknown as { __media: { api: { listMessages(c: string, b: null, l: number): Promise<{ messages: { body: string; id: string; attachments: { file_name: string; width: number; height: number; mime_type: string; path: string; thumb_path: string | null; size_bytes: number; status: string }[] }[] }> } } }).__media;
    const page = await m.api.listMessages(channel as string, null, 20);
    return page.messages.find((x) => x.body === body) ?? null;
  }, [w.general, stamp]);
  expect(sent).not.toBeNull();
  const jpeg = sent!.attachments.find((a) => a.file_name === 'site-visit.jpg')!;
  const png = sent!.attachments.find((a) => a.file_name === 'floor-plan.png')!;
  expect(jpeg.status).toBe('ready');
  expect(Math.max(jpeg.width, jpeg.height)).toBe(1600);
  expect(jpeg.size_bytes).toBeLessThan(Buffer.from(images.jpeg, 'base64').length);
  expect(jpeg.thumb_path).toMatch(/\/thumb\.webp$/);
  expect([png.width, png.height]).toEqual([800, 600]);
  expect(png.thumb_path).toMatch(/\/thumb\.webp$/);

  // Bob, on another device, opens #general and sees both photos.
  const bob = await person(browser, 'bob', { channel: w.general });
  const signing: string[] = [];
  bob.page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/functions/v1/media-sign')) signing.push(`${r.method()} media-sign`);
    if (r.method() === 'POST' && u.includes('/storage/v1/object/sign/')) signing.push('POST storage sign');
  });
  const row = bob.page.locator(`[data-message-id="${sent!.id}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  for (const name of ['site-visit.jpg', 'floor-plan.png']) {
    const img = row.getByRole('img', { name });
    await expect(img).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/media\/.+thumb\.webp\?token=/);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  }
  expect(await bob.page.content()).not.toContain('/object/public/media');
  // every link came from media-sign; ready media is never signed through Storage
  expect(signing).toContain('POST media-sign');
  expect(signing).not.toContain('POST storage sign');
  // the other tenant asking for the same files gets nothing (DEK11, DEKA05)
  const eve = await person(browser, 'eve');
  const eveGot = await eve.page.evaluate(async (paths) => {
    const m = (window as unknown as { __media: { raw: { mintSignedUrls(p: string[]): Promise<{ url: string | null }[]> } } }).__media;
    return (await m.raw.mintSignedUrls(paths)).map((x) => x.url);
  }, [jpeg.path, jpeg.thumb_path as string]);
  expect(eveGot).toEqual([null, null]);
  await eve.context.close();

  // the lightbox loads the full size; arrows move; Escape closes
  await row.getByRole('button', { name: 'Open site-visit.jpg' }).click();
  const box = bob.page.locator('dialog.dm-lightbox');
  await expect(box).toBeVisible();
  await expect(box.locator('img.dm-lightbox__img.is-ready')).toBeVisible({ timeout: 30_000 });
  await expect(box.locator('img.dm-lightbox__img.is-ready')).toHaveAttribute('src', /site-visit\.jpg\?token=/);
  await bob.page.screenshot({ path: shotPath('lightbox-1280x800') });
  expect(await audit(bob.page, 'dialog.dm-lightbox', 24)).toEqual([]);
  // The two files finish in either order, so either can be photo 1: the arrow
  // moves to the other one (and wraps around), whichever this is.
  const count = box.locator('.dm-lightbox__count');
  const before = (await count.textContent()) ?? '';
  const other = before.startsWith('1 /') ? '2 / 2' : '1 / 2';
  await bob.page.keyboard.press('ArrowRight');
  await expect(count).toHaveText(other);
  await expect(box.locator('img.dm-lightbox__img.is-ready')).toHaveAttribute('src', /floor-plan\.png\?token=/, { timeout: 30_000 });
  await bob.page.keyboard.press('ArrowLeft');
  await expect(count).toHaveText(before);
  await bob.page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: shotPath('attachment-grid-1280x800') });
  expect(await audit(bob.page, '.dm-atts', 24)).toEqual([]);

  // the same on a phone, with touch: 44 px targets, no sideways scrolling
  const phone = await person(browser, 'bob', { channel: w.general, phone: true });
  const prow = phone.page.locator(`[data-message-id="${sent!.id}"]`);
  await expect(prow.getByRole('img', { name: 'floor-plan.png' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => prow.getByRole('img', { name: 'floor-plan.png' }).evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await prow.scrollIntoViewIfNeeded();
  await phone.page.screenshot({ path: shotPath('attachment-grid-390x844') });
  expect(await audit(phone.page, '.dm-atts', 44)).toEqual([]);
  await prow.getByRole('button', { name: 'Open floor-plan.png' }).click();
  const pbox = phone.page.locator('dialog.dm-lightbox');
  await expect(pbox.locator('img.dm-lightbox__img.is-ready')).toBeVisible({ timeout: 30_000 });
  await phone.page.screenshot({ path: shotPath('lightbox-390x844') });
  expect(await audit(phone.page, 'dialog.dm-lightbox', 44)).toEqual([]);

  await Promise.all([alice.context.close(), bob.context.close(), phone.context.close()]);
});

test('a disguised program is refused with a clear message, the draft stays, a failed upload offers Retry (DEKA11)', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.general, phone: true });
  // unique per run: #general keeps the messages of earlier runs
  const draft = `Here is the invoice, and the photo from Friday. ${Date.now()}`;
  await alice.page.locator('#hx-draft').fill(draft);

  // 1. A program with an honest name: refused before any byte is read.
  await fileInput(alice.page).setInputFiles([{ name: 'invoice.pdf.exe', mimeType: 'application/x-msdownload', buffer: windowsProgram() }]);
  const exe = alice.page.locator('.dm-upload', { hasText: 'invoice.pdf.exe' });
  await expect(exe).toHaveAttribute('data-status', 'failed');
  await expect(exe.getByRole('alert')).toHaveText(/invoice\.pdf\.exe is a program, script or web page/);
  await expect(exe.getByRole('button', { name: /^Retry/ })).toHaveCount(0);

  // 2. A program renamed holiday.jpg: refused by its bytes.
  await fileInput(alice.page).setInputFiles([{ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: windowsProgram() }]);
  const disguised = alice.page.locator('.dm-upload', { hasText: 'holiday.jpg' });
  await expect(disguised).toHaveAttribute('data-status', 'failed');
  await expect(disguised.getByRole('alert')).toHaveText('holiday.jpg is really a Windows program disguised as a photo. Dek does not accept programs.');
  await expect(alice.page.locator('#hx-draft')).toHaveValue(draft);
  await alice.page.screenshot({ path: shotPath('upload-refused-390x844') });
  expect(await audit(alice.page, '.dm-uploads', 44)).toEqual([]);

  // 3. The connection drops during an upload: Retry, and it goes through.
  let blocked = 0;
  await alice.page.route('**/storage/v1/object/media/**', async (route) => {
    if (route.request().method() === 'POST' && blocked < 2) {
      blocked += 1;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });
  const images = await makeImages(alice.page);
  await fileInput(alice.page).setInputFiles([{ name: 'whiteboard.png', mimeType: 'image/png', buffer: Buffer.from(images.png, 'base64') }]);
  const wb = alice.page.locator('.dm-upload', { hasText: 'whiteboard.png' });
  await expect(wb).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
  await expect(wb.getByRole('alert')).toHaveText(/connection dropped/);
  await expect(alice.page.locator('#hx-draft')).toHaveValue(draft);
  expect(blocked).toBe(2);   // the first try and one quiet retry
  await wb.getByRole('button', { name: 'Retry whiteboard.png' }).click();
  await expect(wb).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await alice.page.unroute('**/storage/v1/object/media/**');

  // Remove the refused files, send the rest: the draft goes out with the photo.
  await exe.getByRole('button', { name: 'Remove invoice.pdf.exe' }).click();
  await disguised.getByRole('button', { name: 'Remove holiday.jpg' }).click();
  await alice.page.getByRole('button', { name: 'Send' }).click();
  await expect(alice.page.locator('#hx-draft')).toHaveValue('');
  const lone = alice.page.locator('.hx-msg', { hasText: draft }).getByRole('img', { name: 'whiteboard.png' });
  await expect(lone).toBeVisible({ timeout: 30_000 });
  // a lone photo keeps its own shape (800 x 600) inside the reserved box
  const boxSize = await lone.evaluate((el) => {
    const r = (el.parentElement as HTMLElement).getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(boxSize.w).toBeGreaterThan(200);
  expect(Math.abs(boxSize.w / boxSize.h - 800 / 600)).toBeLessThan(0.02);
  await alice.context.close();
});

test('a client that skips the browser checks is still refused by media-finalize, and the object is never served (DEKA11)', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.general });
  const program = windowsProgram().toString('base64');
  const r = await alice.page.evaluate(async ([channel, b64]) => {
    const m = (window as unknown as {
      __media: {
        api: { beginUpload(c: string, n: string, mime: string, size: number): Promise<{ attachment_id: string; path: string }>; sendMessage(a: unknown): Promise<unknown> };
        raw: { putObject(p: string, b: Blob, t: string, o: { token: string }): Promise<void>; finalizeUpload(id: string, meta: unknown): Promise<{ status: string; reason: string | null; message?: string | null }>; accessToken(): Promise<string>; mintSignedUrls(p: string[]): Promise<{ url: string | null }[]> };
        supabase(): { storage: { from(b: string): { createSignedUrl(p: string, s: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> } } };
      };
    }).__media;
    const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
    const ticket = await m.api.beginUpload(channel as string, 'sneaky.jpg', 'image/jpeg', bytes.length);
    await m.raw.putObject(ticket.path, new Blob([bytes], { type: 'image/jpeg' }), 'image/jpeg', { token: await m.raw.accessToken() });
    const verdict = await m.raw.finalizeUpload(ticket.attachment_id, { width: null, height: null, duration_ms: null });
    const viaFunction = (await m.raw.mintSignedUrls([ticket.path]))[0]?.url ?? null;
    const signed = await m.supabase().storage.from('media').createSignedUrl(ticket.path, 60);
    let sendError: string | null = null;
    try {
      await m.api.sendMessage({ channel, clientId: crypto.randomUUID(), body: 'sneaky', attachmentIds: [ticket.attachment_id] });
    } catch (e) {
      sendError = (e as { code?: string }).code ?? 'error';
    }
    return { verdict, viaFunction, signedUrl: signed.data?.signedUrl ?? null, signedError: signed.error?.message ?? null, sendError };
  }, [w.general, program]);
  expect(r.verdict.status).toBe('rejected');
  expect(r.verdict.reason).toBe('executable');
  expect(r.verdict.message).toMatch(/program/i);
  expect(r.viaFunction).toBeNull();   // media-sign will not link a rejected file
  expect(r.signedUrl).toBeNull();      // and Storage itself refuses it too
  expect(r.signedError).not.toBeNull();
  expect(r.sendError).toBe('invalid_input');
  await alice.context.close();
});

test('inside the Android and iOS apps files open and save through the signed URL itself, never a blob', async ({ browser }) => {
  const w = await world();
  // alice shares a PDF
  const alice = await person(browser, 'alice', { channel: w.general });
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  await fileInput(alice.page).setInputFiles([{ name: 'Budget Q3.pdf', mimeType: 'application/pdf', buffer: pdfBytes }]);
  await expect(alice.page.locator('.dm-upload[data-status="ready"]')).toHaveCount(1, { timeout: 60_000 });
  const stamp = `Budget for review ${Date.now()}`;
  await alice.page.locator('#hx-draft').fill(stamp);
  await alice.page.getByRole('button', { name: 'Send' }).click();
  await expect(alice.page.locator('#hx-draft')).toHaveValue('');
  await alice.context.close();

  // bob opens Dek in the app: the shell's window.Capacitor is there before any script runs
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true, getPlatform: () => 'android', PluginHeaders: [], nativePromise: async () => undefined,
    };
  });
  const page = await context.newPage();
  await page.goto(`/e2e/media/harness.html?c=${w.general}`);
  await page.waitForFunction(() => !!(window as unknown as { __media?: unknown }).__media);
  await page.evaluate(async ([email, password]) => {
    await (window as unknown as { __media: { boot(e: string, p: string): Promise<unknown> } }).__media.boot(email as string, password as string);
  }, [emailOf('bob'), PASSWORD]);
  const row = page.locator('.hx-msg', { hasText: stamp });
  const open = row.getByRole('link', { name: 'Open Budget Q3.pdf in your browser' });
  const save = row.getByRole('link', { name: 'Download Budget Q3.pdf' });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await expect(open).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/media\/.+Budget_Q3\.pdf\?token=[^&]+$/);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(save).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/media\/.+Budget_Q3\.pdf\?token=.+&download=Budget%20Q3\.pdf$/);
  await expect(save).toHaveAttribute('target', '_blank');
  expect(await save.getAttribute('download')).toBeNull();
  expect(await page.content()).not.toContain('blob:');
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath('native-file-card-390x844') });
  expect(await audit(page, '.dm-atts', 44)).toEqual([]);

  // The tap is a top-level navigation to another origin, which the shell hands to
  // the system browser. Here Chromium plays that browser: the link answers with
  // the file as an attachment under its real name.
  const href = (await save.getAttribute('href')) as string;
  const requested: string[] = [];
  context.on('request', (r) => { if (r.url().includes('&download=')) requested.push(r.url()); });
  const [popup] = await Promise.all([context.waitForEvent('page'), save.click()]);
  await expect.poll(() => requested.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(requested[0]).toBe(href);
  await popup.close();
  // the app itself stayed where it was
  expect(new URL(page.url()).pathname).toBe('/e2e/media/harness.html');
  // what the system browser gets for that URL: the file, as an attachment, by name
  const res = await context.request.get(href);
  const disposition = res.headers()['content-disposition'] ?? '';
  console.log(`native save link: HTTP ${res.status()}, content-disposition: ${disposition}`);
  expect(res.status()).toBe(200);
  expect(disposition).toMatch(/^attachment/);
  expect(disposition).toMatch(/Budget(%20| )Q3\.pdf/);
  expect((await res.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await context.close();
});

test('switching channels keeps each composer\'s files apart', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.general });
  const images = await makeImages(alice.page);
  await fileInput(alice.page).setInputFiles([{ name: 'for-general.png', mimeType: 'image/png', buffer: Buffer.from(images.png, 'base64') }]);
  await expect(alice.page.locator('.dm-upload[data-status="ready"]')).toHaveCount(1, { timeout: 60_000 });
  await showChannel(alice.page, w.dm);
  await expect(alice.page.locator('.dm-upload')).toHaveCount(0);
  await showChannel(alice.page, w.general);
  await expect(alice.page.locator('.dm-upload', { hasText: 'for-general.png' })).toHaveAttribute('data-status', 'ready');
  await alice.page.locator('.dm-upload').getByRole('button', { name: 'Remove for-general.png' }).click();
  await alice.context.close();
});
