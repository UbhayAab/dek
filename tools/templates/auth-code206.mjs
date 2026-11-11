// Pure preflight only. No network, database, credentials or authorization.
// The normal Mailer Owner writer must apply the result transactionally while
// holding/rechecking the source and target preimages. Never log returned metadata.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';

export const proposal = JSON.parse(readFileSync(new URL('./auth-code206.json', import.meta.url), 'utf8'));
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const fields = ['slug', 'name', 'type', 'subject', 'htmlBody', 'fromName', 'fromEmail', 'critical', 'managedBy'];
const content = row => Object.fromEntries(fields.map(key => [key, row[key]]));

export function expectedTarget(source) {
  requireThat(source?.slug === proposal.source.slug, 'Source slug drift');
  requireThat(source.type === proposal.source.type && source.managedBy === proposal.source.managedClass, 'Source ownership/type drift');
  requireThat(typeof source.subject === 'string' && digest(source.subject) === proposal.source.subjectSha256, 'Source subject drift');
  requireThat(typeof source.htmlBody === 'string' && digest(source.htmlBody) === proposal.source.htmlBodySha256, 'Source body drift');
  requireThat(typeof source.fromEmail === 'string' && source.fromEmail.length > 0, 'Source sender missing');
  requireThat(source.critical === null || typeof source.critical === 'boolean', 'Source critical metadata missing');
  return {...proposal.target, fromEmail: source.fromEmail, critical: source.critical, managedBy: 'console'};
}

export function planCreation(source, target) {
  const expected = expectedTarget(source);
  if (target == null) return {action: 'create', values: expected};
  requireThat(isDeepStrictEqual(content(target), content(expected)), 'Existing target differs; explicit new review required');
  return {action: 'unchanged'};
}

// A missing or different target is not ours to remove. Receipts must come from
// the eventual locked Owner transaction, never a caller-supplied target ID.
export function planRetirement(source, target, receipt, references, callersRolledBack) {
  requireThat(callersRolledBack === true, 'Roll back Arc caller/function first');
  requireThat(receipt?.created === true && typeof receipt.targetId === 'string' && receipt.targetId.length > 0, 'Creation provenance missing');
  requireThat(target?.id === receipt.targetId, 'Target incarnation differs');
  const expected = expectedTarget(source);
  requireThat(isDeepStrictEqual(content(target), content(expected)), 'Target changed since creation');
  requireThat(Array.isArray(references) && references.length > 0 && references.every(n => Number.isSafeInteger(n) && n >= 0), 'Reference census missing');
  return references.some(n => n > 0) ? {action: 'retain-unused'} : {action: 'retire', targetId: target.id};
}
