// Off-scope legacy data (tasks, polls, events, forms, canvases, away days,
// nicknames, drafts, workspace roles, saved-item states, profile fields the new
// profile does not keep) exported as JSON outside every repository and deploy root
// (Desktop/claude/dek-legacy-archive). It holds personal data: the writer refuses a
// folder inside a git work tree, the folder also ignores itself in git, and nothing
// from it is printed.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { ARCHIVE_DIR } from './config.mjs';
import { sha256 } from './util.mjs';

// Personal data must never land inside a git work tree (a commit or a deploy that
// copies the folder would publish it).
export function assertOutsideRepos(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) throw new Error(`archive folder is inside the git work tree ${d}; choose a folder outside every repository`);
    if (dirname(d) === d) return;
  }
}

const NOTES = {
  tasks: 'Task rows of the two real orgs (the message text stays in Dek). For the Arc owner.',
  polls: 'Polls (retired in Dek).', poll_votes: 'Poll votes.',
  events: 'Events (retired in Dek).', event_rsvps: 'Event RSVPs.',
  form_defs: 'Form definitions; the one live form message reads "Form: <title> (form retired)" in Dek.',
  form_submissions: 'Form answers.', form_templates: 'Org form templates.',
  canvases: 'Canvases (retired).', canvas_blocks: 'Canvas content.',
  away_days: 'Away days / leave records. For the Arc owner.', leave_policies: 'Leave policies. For the Arc owner.',
  roles: 'Workspace roles with permission bitmasks (server roles were derived from them).',
  member_roles: 'Who held which workspace role.',
  scheduled_messages: 'Scheduled messages (none pending at export).',
  drafts: 'Unsent composer drafts of migrated users.', user_nicknames: 'Private nicknames people gave others.',
  saved_items: 'Saved items with their legacy Later-board state and reminders (Dek keeps the bookmark only).',
  profiles_extra: 'Profile fields the new profile does not hold (pronouns, bio, phone, department, location, start date, manager).',
};

export function writeArchive(archive, snapshot) {
  assertOutsideRepos(ARCHIVE_DIR);
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  // Ignore everything here, including this file, so it can never be committed.
  const ignore = join(ARCHIVE_DIR, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const manifest = { exported_at: new Date().toISOString(), legacy_snapshot_at: snapshot?.at || null,
    contains_personal_data: true, files: {} };
  for (const [name, rows] of Object.entries(archive)) {
    const text = `${JSON.stringify(rows, null, 1)}\n`;
    writeFileSync(join(ARCHIVE_DIR, `${name}.json`), text);
    manifest.files[`${name}.json`] = { rows: rows.length, sha256: sha256(text), note: NOTES[name] || null };
  }
  writeFileSync(join(ARCHIVE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, v.rows]));
}
