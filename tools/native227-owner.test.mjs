import {test}from'node:test';
import assert from'node:assert/strict';
import{verifyNativeOwner,creationMilliseconds}from'./native227-owner.mjs';
const input=()=>({owner:{data:'E:\\claude\\wt\\dek\\.local\\native\\run\\data',port:55397,
 nonce:'aab1f438-c663-4b43-9e59-068e3d3b8f52',cluster:'dek227_aab1f438c6634b439e59068e3d3b8f52'},
 lines:['50996','E:/claude/wt/dek/.local/native/run/data','1794495991','55397'],
 process:{ProcessId:50996,CreationDate:'/Date(1794495991925)/',ExecutablePath:'E:\\pgsql\\bin\\postgres.exe',
  CommandLine:'"E:/pgsql/bin/postgres.exe"  -D "E:/claude/wt/dek/.local/native/run/data"  '},binary:'E:/pgsql/bin/postgres.exe'});
test('observed PG17/CIM forward-slash command and backslash owner identify the same process',()=>{
 assert.equal(verifyNativeOwner(input()).pid,50996);
});
test('PowerShell5 and7 date serialization retain the same PID incarnation',()=>{
 assert.equal(creationMilliseconds('/Date(1794495991925)/'),creationMilliseconds('2026-11-12T20:36:31.925366+05:30'));
});
test('quoted spaces and case differences preserve exact argv ownership',()=>{
 const i=input();i.owner.data='E:\\Owned Task\\Native\\Data';i.lines[1]='e:/owned task/native/data';
 i.process.CommandLine='"e:/PGSQL/bin/POSTGRES.EXE" -D "E:/OWNED TASK/NATIVE/DATA"';assert.equal(verifyNativeOwner(i).pid,50996);
});
for(const [name,change]of[
 ['foreign PID',i=>i.process.ProcessId++],
 ['reused PID incarnation',i=>i.process.CreationDate='/Date(1794496991925)/'],
 ['foreign executable',i=>i.process.ExecutablePath='E:/other/postgres.exe'],
 ['foreign directory sharing an owned prefix',i=>i.process.CommandLine=i.process.CommandLine.replace('/run/data','/run/data-foreign')],
 ['foreign PID-file directory',i=>i.lines[1]='E:/other/data'],
 ['foreign listener port',i=>i.lines[3]='5432'],
 ['unexpected command argument',i=>i.process.CommandLine+=' -p 5432'],
 ['incorrect nonce binding',i=>i.owner.nonce='other'],
])test('refuses '+name,()=>{const i=input();change(i);assert.throws(()=>verifyNativeOwner(i));});
