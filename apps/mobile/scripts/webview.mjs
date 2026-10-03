#!/usr/bin/env node
// Drives the Dek WebView on a connected device or emulator over the Chrome
// DevTools protocol, for repeatable device checks. Debug builds only (release
// builds do not expose WebView debugging).
//
//   node scripts/webview.mjs eval "<js expression>"    prints the JSON result
//   node scripts/webview.mjs signin <email>            password sign-in; the
//                                                      password comes from
//                                                      .env.local DEK_QA_PASSWORD
//                                                      and is never printed
//   node scripts/webview.mjs shot <file.png>           device screenshot
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secret, toolEnv } from './lib.mjs';

const PORT = 9333;
const PACKAGE = 'org.jaruratcare.dek';

function adb(args, opts = {}) {
  const exe = join(toolEnv().ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  return execFileSync(exe, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

async function target() {
  const pid = adb(['shell', 'pidof', PACKAGE]).toString().trim().split(/\s+/)[0];
  if (!pid) throw new Error(`${PACKAGE} is not running`);
  adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith('https://localhost'));
  if (!page) throw new Error('no Dek page in the WebView');
  return page.webSocketDebuggerUrl;
}

export async function evaluate(expression) {
  const ws = new WebSocket(await target());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('devtools socket failed'));
  });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('evaluate timed out')), 30_000);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return reply.result?.result?.value;
}

// React-controlled inputs need the native setter plus an input event.
function signInScript(email, password) {
  return `(async () => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const user = document.querySelector('input[autocomplete="username"]');
    const pass = document.querySelector('input[autocomplete="current-password"]');
    if (!user || !pass) return { ok: false, reason: 'password form not on screen' };
    set(user, ${JSON.stringify(email)});
    set(pass, ${JSON.stringify(password)});
    pass.form.requestSubmit();
    return { ok: true };
  })()`;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'eval') {
    console.log(JSON.stringify(await evaluate(arg), null, 2));
  } else if (cmd === 'signin') {
    const password = secret('DEK_QA_PASSWORD');
    if (!password) throw new Error('DEK_QA_PASSWORD missing from .env.local');
    console.log(JSON.stringify(await evaluate(signInScript(arg, password))));
  } else if (cmd === 'shot') {
    writeFileSync(arg, adb(['exec-out', 'screencap', '-p']));
    console.log(arg);
  } else {
    console.error('usage: webview.mjs eval <js> | signin <email> | shot <file>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[webview] ${e.message}`);
  process.exit(1);
});
