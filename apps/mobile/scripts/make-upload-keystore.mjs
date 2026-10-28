#!/usr/bin/env node
// Creates the Android UPLOAD keystore once (APP06) and prints only its public
// certificate fingerprints. The password is random, goes to the repo .env.local
// (gitignored) as DEK_ANDROID_KEYSTORE_PASSWORD and is never printed or passed on a
// command line (keytool reads it from the environment with -storepass:env).
//
// Refuses to run when the keystore already exists: replacing an upload key means a
// Play Console upload key reset, never a silent overwrite.
//
// Usage: node scripts/make-upload-keystore.mjs          create, then print fingerprints
//        node scripts/make-upload-keystore.mjs --print  print fingerprints only
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KEYSTORE_PATH, KEY_ALIAS, ROOT, keytool, secret, toolEnv } from './lib.mjs';

const PW_VAR = 'DEK_ANDROID_KEYSTORE_PASSWORD';
const ENV_FILE = join(ROOT, '.env.local');

function fingerprints(password) {
  const out = execFileSync(keytool(), [
    '-list', '-v', '-keystore', KEYSTORE_PATH, '-alias', KEY_ALIAS, '-storepass:env', 'DEK_KS_PW',
  ], { encoding: 'utf8', env: { ...toolEnv(), DEK_KS_PW: password } });
  const pick = (label) => (out.match(new RegExp(`${label}:\\s*([0-9A-F:]+)`)) || [])[1] || null;
  return {
    sha256: pick('SHA256'),
    sha1: pick('SHA1'),
    owner: (out.match(/Owner:\s*(.+)/) || [])[1]?.trim() ?? null,
    validUntil: (out.match(/until:\s*(.+)/) || [])[1]?.trim() ?? null,
  };
}

function main() {
  const printOnly = process.argv.includes('--print');
  if (printOnly || existsSync(KEYSTORE_PATH)) {
    if (!printOnly) console.log(`Keystore already exists at ${KEYSTORE_PATH}; not replacing it.`);
    const pw = secret(PW_VAR);
    if (!pw) throw new Error(`${PW_VAR} is missing from .env.local`);
    console.log(JSON.stringify(fingerprints(pw), null, 2));
    return;
  }
  if (secret(PW_VAR)) {
    throw new Error(`${PW_VAR} is already set but no keystore exists at ${KEYSTORE_PATH}; restore the keystore from its backup instead of creating a new one.`);
  }

  mkdirSync(dirname(KEYSTORE_PATH), { recursive: true });
  const password = randomBytes(24).toString('base64url');
  execFileSync(keytool(), [
    '-genkeypair',
    '-keystore', KEYSTORE_PATH,
    '-storetype', 'PKCS12',
    '-alias', KEY_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-validity', '10950',
    '-dname', 'CN=Dek Android upload key, OU=Dek, O=Dek, C=IN',
    '-storepass:env', 'DEK_KS_PW',
    '-keypass:env', 'DEK_KS_PW',
  ], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...toolEnv(), DEK_KS_PW: password } });

  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const lead = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(ENV_FILE,
    `${lead}# Android upload keystore ${KEYSTORE_PATH} (alias ${KEY_ALIAS}), created ${new Date().toISOString().slice(0, 10)}\n` +
    `${PW_VAR}=${password}\n`);

  console.log(`Created ${KEYSTORE_PATH} (alias ${KEY_ALIAS}); password stored in .env.local as ${PW_VAR}.`);
  console.log(JSON.stringify(fingerprints(password), null, 2));
}

main();
