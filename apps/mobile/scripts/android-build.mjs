#!/usr/bin/env node
// Builds Dek for Android, reproducibly, from a clean checkout.
//
//   node scripts/android-build.mjs debug     app-debug.apk (debug key, for testing)
//   node scripts/android-build.mjs release   app-release.aab for Play plus a signed
//                                            app-release.apk for device tests
//   node scripts/android-build.mjs all       both of the above in one Gradle run
// Options:
//   --skip-web    reuse the last web bundle instead of building it again
//   --skip-sync   skip `cap sync android` (only when nothing web or plugin changed)
//
// Web bundle: when apps/web/src/main.tsx calls initNative() the canonical web
// build (apps/web/dist) is used. Until then the bundle is built by
// scripts/vite.native.config.mjs into dist-native with that call added at build
// time, so an app built today already has secure storage, push, links and back.
//
// Release signing: DEK_ANDROID_KEYSTORE_PASSWORD from .env.local is handed to
// Gradle through the environment; the keystore stays in E:\secrets\dek.
// Firebase: google-services.json is copied in from DEK_GOOGLE_SERVICES_JSON or the
// secrets folder when it exists; without it the build is push-less, not broken.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ANDROID, KEYSTORE_PATH, MOBILE, ROOT, SECRETS_DIR, secret, toolEnv, waitForMemory } from './lib.mjs';

const MIN_FREE_MB = 3 * 1024;
const WEB = join(ROOT, 'apps', 'web');

// Windows runs .bat and .cmd files only through cmd.exe; call it explicitly
// instead of shell:true (no argument is user input here).
function run(cmd, args, opts) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const win = process.platform === 'win32';
  const r = win
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { stdio: 'inherit', ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed with exit code ${r.status}`);
}

function sizeOf(path) {
  if (!existsSync(path)) return null;
  const bytes = statSync(path).size;
  return { path, bytes, mb: Math.round((bytes / 1048576) * 100) / 100,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export function mainCallsInitNative() {
  return /from ['"]\.\/native['"]/.test(readFileSync(join(WEB, 'src', 'main.tsx'), 'utf8'));
}

// Returns the directory cap sync copies into the app, relative to apps/mobile.
function webBundle(skip, env) {
  if (mainCallsInitNative()) {
    if (!skip) run('npm', ['--workspace', 'apps/web', 'run', 'build'], { cwd: ROOT, env });
    return '../web/dist';
  }
  console.log('\n[web] apps/web/src/main.tsx does not call initNative() yet: building the native bundle with it added (scripts/vite.native.config.mjs)');
  if (!skip) run('npx', ['vite', 'build', '--config', join(MOBILE, 'scripts', 'vite.native.config.mjs')], { cwd: WEB, env });
  return 'dist-native';
}

function placeFirebaseConfig() {
  const target = join(ANDROID, 'app', 'google-services.json');
  const source = process.env.DEK_GOOGLE_SERVICES_JSON || join(SECRETS_DIR, 'google-services.json');
  if (existsSync(source)) {
    copyFileSync(source, target);
    console.log('[push] google-services.json copied in: FCM push configured on this build');
    return { configured: true, copied: true };
  }
  if (existsSync(target)) {
    console.log('[push] using android/app/google-services.json already in place');
    return { configured: true, copied: false };
  }
  console.log('[push] no google-services.json: this build reports "Push not configured on this build"');
  return { configured: false, copied: false };
}

async function main() {
  const mode = process.argv[2];
  if (!['debug', 'release', 'all'].includes(mode)) {
    console.error('usage: node scripts/android-build.mjs debug|release|all [--skip-web] [--skip-sync]');
    process.exit(2);
  }
  const flags = new Set(process.argv.slice(3));
  const env = toolEnv();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  env.VITE_BUILD_ID = `${commit.slice(0, 7)}${sourceDirty ? '-dirty' : ''}-android-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
  env.VITE_APP_ENV = 'production';

  const webDir = webBundle(flags.has('--skip-web'), env);
  if (!existsSync(join(MOBILE, webDir, 'index.html'))) throw new Error(`${webDir}/index.html is missing: build the web bundle first`);
  if (!flags.has('--skip-sync')) {
    run('npx', ['cap', 'sync', 'android'], { cwd: MOBILE, env: { ...env, DEK_WEB_DIR: webDir } });
  }
  const signs = mode !== 'debug';
  const tasks = [...(mode !== 'release' ? ['assembleDebug'] : []), ...(signs ? ['bundleRelease', 'assembleRelease'] : [])];
  const gradleEnv = { ...env };
  if (signs) {
    const pw = secret('DEK_ANDROID_KEYSTORE_PASSWORD');
    if (!pw) throw new Error('DEK_ANDROID_KEYSTORE_PASSWORD is missing from .env.local (run node scripts/make-upload-keystore.mjs)');
    if (!existsSync(KEYSTORE_PATH)) throw new Error(`upload keystore not found at ${KEYSTORE_PATH}`);
    gradleEnv.DEK_ANDROID_KEYSTORE_PASSWORD = pw;
    gradleEnv.DEK_ANDROID_KEYSTORE_PATH = KEYSTORE_PATH;
  }

  // Copied only after every precondition passed, so a failed check never leaves
  // provider configuration in the tree.
  const push = placeFirebaseConfig();
  try {
    await waitForMemory(MIN_FREE_MB);
    run(join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
      [...tasks, '--no-daemon', '--console=plain', '--max-workers=2'], { cwd: ANDROID, env: gradleEnv });
  } finally {
    // Provider config copied from the secrets folder never stays in the tree.
    if (push.copied && !process.env.DEK_KEEP_GOOGLE_SERVICES) rmSync(join(ANDROID, 'app', 'google-services.json'), { force: true });
  }

  const out = join(ANDROID, 'app', 'build', 'outputs');
  const artifacts = [
    ...(mode !== 'release' ? [sizeOf(join(out, 'apk', 'debug', 'app-debug.apk'))] : []),
    ...(signs ? [sizeOf(join(out, 'bundle', 'release', 'app-release.aab')), sizeOf(join(out, 'apk', 'release', 'app-release.apk'))] : []),
  ];
  const manifest = { mode, commit, sourceDirty, webRebuilt: !flags.has('--skip-web'), assetsSynced: !flags.has('--skip-sync'),
    buildId: flags.has('--skip-web') || flags.has('--skip-sync') ? 'reused-assets-see-package' : env.VITE_BUILD_ID,
    builtAt: new Date().toISOString(), webDir, pushConfigured: push.configured, artifacts };
  writeFileSync(join(out, 'dek-build-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(`\n[android-build] ${e.message}`);
  process.exit(1);
});
