// Shared helpers for the Dek mobile build scripts. Secrets come from the repo's
// .env.local through tools/lib/env.mjs and are passed to child processes through
// their environment only: never on a command line, never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as repoEnv, ROOT } from '../../../tools/lib/env.mjs';

export { ROOT };
export const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ANDROID = join(MOBILE, 'android');
export const SECRETS_DIR = process.env.DEK_SECRETS_DIR || 'E:\\secrets\\dek';
export const KEYSTORE_PATH = process.env.DEK_ANDROID_KEYSTORE_PATH || join(SECRETS_DIR, 'upload-keystore.jks');
export const KEY_ALIAS = process.env.DEK_ANDROID_KEY_ALIAS || 'dek-upload';

const DEFAULTS = {
  JAVA_HOME: 'C:\\Users\\abhay\\tools\\jdk-21.0.12.1+1',
  ANDROID_HOME: 'E:\\android-sdk',
  GRADLE_USER_HOME: 'E:\\gradle-home',
};

// Capacitor 8 needs JDK 21. The machine-wide JAVA_HOME may point at another JDK
// (here: 17), so DEK_JAVA_HOME wins, then the known JDK 21, then JAVA_HOME, and
// whichever is picked must really be 21.
function isJdk21(home) {
  try {
    return /JAVA_VERSION="21[".]/.test(readFileSync(join(home, 'release'), 'utf8'));
  } catch {
    return false;
  }
}

export function toolEnv() {
  const e = repoEnv();
  const javaHome = [e.DEK_JAVA_HOME, DEFAULTS.JAVA_HOME, e.JAVA_HOME].find((h) => h && isJdk21(h));
  if (!javaHome) throw new Error('JDK 21 not found: set DEK_JAVA_HOME to a JDK 21 home');
  const sdk = e.ANDROID_HOME || e.ANDROID_SDK_ROOT || DEFAULTS.ANDROID_HOME;
  if (!existsSync(join(sdk, 'platforms'))) throw new Error(`Android SDK not found at ${sdk}; set ANDROID_HOME`);
  // Windows keeps the search path under "Path"; writing a second "PATH" key would
  // leave the child with two and an arbitrary winner.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    GRADLE_USER_HOME: e.GRADLE_USER_HOME || DEFAULTS.GRADLE_USER_HOME,
    // This network has no working IPv6 route; the JVM tries IPv6 first and the
    // Gradle wrapper and Maven downloads time out without this.
    GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Djava.net.preferIPv4Stack=true`.trim(),
    [pathKey]: `${join(javaHome, 'bin')}${sep}${process.env[pathKey] ?? ''}`,
  };
}

export function keytool() {
  return join(toolEnv().JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
}

export function secret(name) {
  return repoEnv()[name] || '';
}

// Free physical memory in MB (Win32_OperatingSystem.FreePhysicalMemory, as the
// build rules ask), falling back to os.freemem elsewhere.
export async function freeMemoryMb() {
  if (process.platform !== 'win32') {
    const os = await import('node:os');
    return Math.round(os.freemem() / 1048576);
  }
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory',
  ], { encoding: 'utf8' });
  return Math.round(Number(out.trim()) / 1024);
}

export async function waitForMemory(minMb, maxWaitMs = 20 * 60 * 1000) {
  const started = Date.now();
  for (;;) {
    const free = await freeMemoryMb();
    if (free >= minMb) {
      console.log(`[mem] ${free} MB free (need ${minMb}), starting`);
      return free;
    }
    if (Date.now() - started > maxWaitMs) {
      throw new Error(`[mem] only ${free} MB free after waiting ${Math.round(maxWaitMs / 60000)} min; not starting Gradle`);
    }
    console.log(`[mem] ${free} MB free, waiting for ${minMb} MB`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
