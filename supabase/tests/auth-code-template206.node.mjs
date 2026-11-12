import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {proposal, expectedTarget, planCreation, planRetirement} from '../../tools/templates/auth-code206.mjs';

// Reconstruct the original public template content without loading any private
// sender metadata. This is a byte/preflight fixture, not the native renderer.
const original = {
  slug: 'dek-otp', type: 'TRANSACTIONAL', managedBy: null,
  subject: proposal.target.subject.replaceAll('{{APP_NAME}}', 'Dek'),
  htmlBody: proposal.target.htmlBody.replaceAll('{{APP_NAME}}', 'Dek').replaceAll('{{APP_INITIAL}}', 'D'),
  fromEmail: 'sender@template206.fixture', fromName: 'Foundation fixture', critical: null,
};
const hash = text => createHash('sha256').update(text).digest('hex');

test('additive template reconstructs exact original Dek subject/body preimages', () => {
  assert.equal(hash(original.subject), proposal.source.subjectSha256);
  assert.equal(hash(original.htmlBody), proposal.source.htmlBodySha256);
  assert.equal(proposal.target.slug, 'dek-otp-shared206');
  assert.equal(proposal.target.fromName, 'Arc');
  assert.equal((proposal.target.htmlBody.match(/\{\{APP_NAME\}\}/g) || []).length, 5);
  assert.equal((proposal.target.htmlBody.match(/\{\{APP_INITIAL\}\}/g) || []).length, 1);
  assert(!proposal.target.htmlBody.includes('Dek'));
  assert(!proposal.target.subject.includes('Dek'));
});
test('creation privately inherits sender/critical, with fixed envelope name and protected ownership', () => {
  const before = structuredClone(original);
  const result = planCreation(original, null);
  assert.equal(result.action, 'create');
  assert.equal(result.values.fromEmail, original.fromEmail);
  assert.equal(result.values.fromName, 'Arc');
  assert.equal(result.values.critical, null);
  assert.equal(result.values.managedBy, null);
  assert.deepEqual(original, before);
  assert.deepEqual(planCreation(original, {...result.values, id: 4069}), {action: 'unchanged'});
});
for (const change of [{subject:'drift'}, {htmlBody:'drift'}, {managedBy:'external'}, {type:'BULK'}, {fromEmail:''}])
  test('creation refuses source drift ' + Object.keys(change)[0], () => assert.throws(() => planCreation({...original, ...change}, null)));
test('creation refuses target edits, sender drift and unrelated target; never updates implicitly', () => {
  const target = expectedTarget(original);
  for (const change of [{subject:'drift'}, {fromName:'Caller'}, {fromEmail:'changed@template206.fixture'}, {managedBy:'external'}, {slug:'other'}])
    assert.throws(() => planCreation(original, {...target, ...change}), /differs/);
});
test('retirement requires exact creation incarnation, rollback and complete zero census', () => {
  const target = {...expectedTarget(original), id:4069};
  const receipt = {created:true, targetId:target.id};
  assert.deepEqual(planRetirement(original,target,receipt,[0,0,0],true), {action:'retire',targetId:target.id});
  assert.deepEqual(planRetirement(original,target,receipt,[0,1,0],true), {action:'retain-unused'});
  for (const [r,counts,rolled] of [[{},[0],true],[{...receipt,created:false},[0],true],[{...receipt,targetId:4070},[0],true],[{...receipt,targetId:'4069'},[0],true],[receipt,[],true],[receipt,[undefined],true],[receipt,[0],false]])
    assert.throws(() => planRetirement(original,target,r,counts,rolled));
  assert.throws(() => planRetirement(original,{...target,subject:'changed'},receipt,[0],true));
});
