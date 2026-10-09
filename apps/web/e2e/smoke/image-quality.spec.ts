// Fixboard #29: exercise the deployed composer, viewer and download as two QA
// members. A byte comparison catches both resizing and invisible re-encoding.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { qaRpc, signIn } from '../ui/session';

interface Attachment {
  file_name: string; width: number; height: number; size_bytes: number;
  thumb_path: string | null;
}
interface Message { id: string; body: string; attachments: Attachment[] }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('posted pictures retain original pixels and exact download bytes', async ({ page, context, browser }, info) => {
  test.setTimeout(180_000);
  const me = await qaRpc<{ orgs: { id: string; name: string }[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!.id;
  const servers = await qaRpc<{ id: string; name: string }[]>('alice', 'list_servers', { p_org: org });
  const server = servers.find((s) => s.name === 'Medical Partnerships')!.id;
  const channels = await qaRpc<{ id: string; name: string }[]>('alice', 'list_channels', { p_server: server });
  const channel = channels.find((c) => c.name === 'general')!.id;
  const route = `/o/${org}/c/${channel}`;
  const stamp = `smoke-quality-${info.project.name}-${Date.now()}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = resolve('test-results/quality-proof');
  // Use the Fixboard checkout's existing ignored proof folder when requested.
  const out = process.env.DEK_QUALITY_SHOTS ?? shots;
  mkdirSync(out, { recursive: true });
  const prefix = process.env.DEK_QUALITY_BASELINE ? '29-before' : '29';
  let sent: Message | undefined;
  let bobContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await signIn(context, 'alice');
    await page.goto(route);
    await expect(page.locator('.dk-composer__input').first()).toBeVisible({ timeout: 45_000 });
    const fixtures = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 2400; c.height = 1600;
      const ctx = c.getContext('2d')!;
      const pixels = ctx.createImageData(c.width, c.height);
      let seed = 29;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const n = seed >>> 26;
        pixels.data[i] = 8 + n;
        pixels.data[i + 1] = 90 + n;
        pixels.data[i + 2] = 105 + n;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 150px sans-serif';
      ctx.fillText('Original quality', 130, 550);
      ctx.font = '64px sans-serif';
      ctx.fillText('Dek design check', 130, 720);
      ctx.font = '28px sans-serif';
      ctx.fillText('Fine lettering stays in the original file.', 130, 850);
      ctx.fillText('Synthetic artwork - no personal data', 130, 910);
      const result = [];
      for (const [ext, type] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
        const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), type, 0.96));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        result.push({ name: `dek-design-original.${ext}`, mimeType: type, base64: btoa(binary) });
      }
      return result;
    });
    const files = fixtures.map(({ base64, ...f }) => ({ ...f, buffer: Buffer.from(base64, 'base64') }));
    for (const f of files) expect(f.buffer.length).toBeGreaterThan(400 * 1024);
    await page.locator('input[type="file"][data-upload-key]').first().setInputFiles(files);
    await expect(page.locator('.dm-upload[data-status="ready"]')).toHaveCount(3, { timeout: 90_000 });
    if (!process.env.DEK_QUALITY_BASELINE) {
      await expect(page.locator('.dm-upload__status')).toHaveText([
        /original quality/, /original quality/, /original quality/,
      ]);
    }
    await page.locator('.dm-uploads').screenshot({ path: resolve(out, `${prefix}-uploads-${info.project.name}.png`) });
    await page.locator('.dk-composer__input').first().fill(stamp);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText(stamp, { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const messages = await qaRpc<{ messages: Message[] }>('alice', 'list_messages', { p_channel: channel, p_limit: 50 });
      sent = messages.messages.find((m) => m.body === stamp);
      return !!sent;
    }, { timeout: 30_000 }).toBe(true);
    const state = await qaRpc<{ channels: { id: string; last_seq: number }[] }>('bob', 'bootstrap', { p_org: org });
    const seq = state.channels.find((c) => c.id === channel)?.last_seq ?? 0;
    if (seq) await qaRpc('bob', 'mark_read', { p_channel: channel, p_seq: seq });
    bobContext = await browser.newContext({ ...info.project.use });
    await signIn(bobContext, 'bob');
    const bob = await bobContext.newPage();
    bob.on('pageerror', (e) => errors.push(e.message));
    await bob.goto(`${route}?m=${sent!.id}`);
    const row = bob.locator(`[data-message-id="${sent!.id}"]`);
    await expect(row).toBeVisible({ timeout: 45_000 });
    for (const f of files) {
      const att = sent!.attachments.find((a) => a.file_name === f.name)!;
      expect(att).toBeDefined();
      expect.soft([att.width, att.height], f.name).toEqual([2400, 1600]);
      expect.soft(att.size_bytes, f.name).toBe(f.buffer.length);
      expect(att.thumb_path).toMatch(/\/thumb\.webp$/);
      await row.getByRole('button', { name: `Open ${f.name}`, exact: true }).click();
      const dialog = bob.locator('dialog.dm-lightbox');
      const full = dialog.locator('img.dm-lightbox__img.is-full.is-ready');
      await expect(full).toBeVisible({ timeout: 30_000 });
      const dimensions = await full.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]);
      expect.soft(dimensions, `viewer ${f.name}`).toEqual([2400, 1600]);
      const preview = dialog.locator('img.is-thumb');
      expect(await preview.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
      if (f.mimeType === 'image/png') {
        await dialog.screenshot({ path: resolve(out, `${prefix}-viewer-${info.project.name}.png`) });
      }
      const downloading = bob.waitForEvent('download');
      await dialog.getByRole('link', { name: `Download ${f.name}`, exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(f.name);
      const path = await download.path();
      const received = readFileSync(path!);
      const same = hash(received) === hash(f.buffer);
      console.log(`[${info.project.name}] ${f.mimeType}: source=${f.buffer.length}, stored=${att.size_bytes}, viewer=${dimensions.join('x')}, SHA256-identical=${same}`);
      expect.soft(hash(received), `download ${f.name}`).toBe(hash(f.buffer));
      await bob.getByRole('button', { name: 'Close photo viewer' }).click();
    }
    expect(errors).toEqual([]);
  } finally {
    if (!sent) {
      const messages = await qaRpc<{ messages: Message[] }>('alice', 'list_messages', { p_channel: channel, p_limit: 50 });
      sent = messages.messages.find((m) => m.body === stamp);
    }
    if (sent) await qaRpc('alice', 'delete_message', { p_message: sent.id });
    await bobContext?.close();
  }
});
