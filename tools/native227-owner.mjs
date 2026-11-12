import assert from 'node:assert/strict';
import {win32} from 'node:path';
const canonical=path=>win32.resolve(path).replaceAll('\\','/').toLowerCase();
export function creationMilliseconds(value){
 const legacy=String(value).match(/^\/Date\((\d+)\)\/$/);
 const result=legacy?Number(legacy[1]):Date.parse(value);
 assert.ok(Number.isFinite(result)&&result>0,'invalid process creation time');return result;
}
export function verifyNativeOwner({owner,lines,process:info,binary}){
 const pid=Number(lines[0]);assert.ok(Number.isSafeInteger(pid)&&pid>0,'invalid postmaster PID');
 assert.equal(Number(info.ProcessId),pid,'process PID mismatch');
 assert.equal(canonical(lines[1]),canonical(owner.data),'PID file data mismatch');
 assert.equal(Number(lines[3]),owner.port,'PID file port mismatch');
 assert.equal(canonical(info.ExecutablePath),canonical(binary),'postmaster binary mismatch');
 // pg_ctl emits exactly these three argv items for this runner. Compare resolved
 // argument values, never a path substring: slash, case and spaces are serialized
 // differently by Windows/CIM, while a different directory must still refuse.
 const args=[...info.CommandLine.matchAll(/"([^"]*)"|(\S+)/g)].map(m=>m[1]??m[2]);
 assert.equal(args.length,3,'unexpected postmaster arguments');
 assert.equal(canonical(args[0]),canonical(binary),'command binary mismatch');
 assert.equal(args[1],'-D','postmaster data argument missing');
 assert.equal(canonical(args[2]),canonical(owner.data),'postmaster data directory mismatch');
 const created=creationMilliseconds(info.CreationDate);
 assert.ok(Math.abs(created/1000-Number(lines[2]))<2,'PID creation incarnation mismatch');
 assert.equal(owner.cluster,'dek227_'+owner.nonce.replaceAll('-',''),'owner nonce mismatch');
 return {pid,creation:info.CreationDate,executable:info.ExecutablePath,command:info.CommandLine};
}
