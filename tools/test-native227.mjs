// Owned loopback PostgreSQL17 acceptance. Default mode is inert source inventory.
// No credential loading, remote target, model/provider call or production fallback.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {verifyNativeOwner} from './native227-owner.mjs';
const exec=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const bin='E:/claude/tooling/pg17-hope56-canary/portable/pgsql/bin';
const port=55397,minimum=4*1024**3,runtimeFloor=3.5*1024**3;
const sha=b=>createHash('sha256').update(b).digest('hex');
const text=path=>readFileSync(path,'utf8');
const files=readdirSync(join(root,'supabase/migrations')).filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort();
assert.equal(files.at(-1),'0931_join_request_notifications227.sql');
const sourcePaths=[...files.map(f=>join('supabase/migrations',f)),
 'supabase/tests/_harness.mjs','supabase/tests/plat-lib.mjs','supabase/tests/join-request-cases227.mjs',
 'tools/native227-host.sql','tools/native227-baseline.sql','tools/native227-owner.mjs','tools/native227-owner.test.mjs','tools/test-native227.mjs'];
const snapshot=()=>({schema:1,projectRoot:root,port,minimumFreeBytes:minimum,runtimeFloorBytes:runtimeFloor,
 binaries:['postgres.exe','pg_ctl.exe','initdb.exe'].map(name=>({path:join(bin,name),sha256:sha(readFileSync(join(bin,name)))})),
 sources:sourcePaths.map(path=>({path,sha256:sha(readFileSync(join(root,path)))}))});
const free=async()=>Number((await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',
 '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024'],{windowsHide:true,timeout:8000})).stdout.trim());
const bind=()=>new Promise((yes,no)=>{const server=createServer();server.once('error',no);
 server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(error=>error?no(error):yes()));});
const outputBase=join(root,'.local/fb227-g08/native');
if(process.argv[2]==='--freeze'){
 const bytes=JSON.stringify(snapshot(),null,2)+'\n',digest=sha(bytes);
 mkdirSync(outputBase,{recursive:true});const path=join(outputBase,`freeze-${digest}.json`);
 if(!existsSync(path))writeFileSync(path,bytes,{flag:'wx'});
 else assert.equal(sha(readFileSync(path)),digest);
 console.log(JSON.stringify({inert:true,freeze:path,sha256:digest,sourceFiles:sourcePaths.length}));process.exit(0);
}
if(process.argv[2]!=='--run'){
 console.log(JSON.stringify({inert:true,port,sourceFiles:sourcePaths.length,minimumFreeBytes:minimum,
 requiredClaims:['qa:fixboard-heavy-local',`port:${port}`],remoteConnectionsAllowed:false}));process.exit(0);
}
const freezePath=resolve(process.argv[3]??''),expected=process.argv[4];
assert.ok(freezePath.startsWith(outputBase+ '\\')||freezePath.startsWith(outputBase+'/'));
assert.equal(sha(readFileSync(freezePath)),expected,'exact freeze SHA required');
const frozen=JSON.parse(text(freezePath));assert.deepEqual(snapshot(),frozen,'source/binary changed');
const initialFree=await free();assert.ok(initialFree>=minimum,'4 GiB admission refused');
const claims=(await exec('node',['C:/Users/abhay/.claude/agent-chat/chat.mjs','claims'],{windowsHide:true,timeout:8000})).stdout;
for(const resource of ['qa:fixboard-heavy-local',`port:${port}`]){
 const line=claims.split(/\r?\n/).find(x=>x.startsWith(resource+' '));
 assert.ok(line&&/\sheld\s+codex-dek\s+until\s/.test(line),'active owned '+resource+' claim required');
}
await bind();
const nonce=randomUUID();const run=join(outputBase,new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+nonce.slice(0,8));
const data=join(run,'data');mkdirSync(run,{recursive:true});
const cluster='dek227_'+nonce.replaceAll('-','');
const receipt={schema:1,at:new Date().toISOString(),freezeSha256:expected,run,port,cluster,
 initialFreeBytes:initialFree,samples:[],migrations:[],hostAdaptations:[],baseline:null,cases:[],
 externalProviderCalls:0,remoteDatabaseConnections:0,stopped:false,portRebound:false};
writeFileSync(join(run,'OWNER.json'),JSON.stringify({nonce,cluster,data,port,freezeSha256:expected},null,2)+'\n',{flag:'wx'});
let client=null,monitor,monitorTask=null,busy=false,aborted=false;
const abort=signal=>{aborted=true;receipt.abortSignal=signal;client?.connection.stream.destroy();};
process.once('SIGINT',()=>abort('SIGINT'));process.once('SIGTERM',()=>abort('SIGTERM'));
const deadline=setTimeout(()=>abort('three-minute-runtime-ceiling'),180000);
const check=async()=>{
 assert.ok(!aborted,'owned run aborted');
 const bytes=await free();receipt.samples.push({at:new Date().toISOString(),freeBytes:bytes});
 assert.ok(bytes>=runtimeFloor,'3.5 GiB runtime floor crossed');
};
async function identity(){
 if(!existsSync(join(data,'postmaster.pid')))return null;
 const lines=text(join(data,'postmaster.pid')).trim().split(/\r?\n/);const pid=Number(lines[0]);
 assert.ok(Number.isSafeInteger(pid)&&pid>0);
 const p=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
  {windowsHide:true,timeout:8000})).stdout);
 assert.ok(p,'owned postmaster no longer exists');
 const owner=JSON.parse(text(join(run,'OWNER.json')));
 return verifyNativeOwner({owner,lines,process:p,binary:join(bin,'postgres.exe')});
}
async function migration(name){
 assert.deepEqual(snapshot(),frozen,'source changed during run');await check();
 let sql=text(join(root,'supabase/migrations',name));
 if(name==='0001_foundation.sql')for(const extension of ['pg_net','pg_cron with schema pg_catalog']){
  const line=`create extension if not exists ${extension};`;assert.equal(sql.split(line).length,2);
  sql=sql.replace(line,'-- Owned local host adapter replaces only: '+line);
  receipt.hostAdaptations.push({file:name,removedHostStatement:line});
 }
 await client.query('begin');try{
  await client.query(sql);await client.query('call dek_meta.lockdown()');
  await client.query('insert into dek_meta.migrations(filename,sha256) values($1,$2)',[name,sha(text(join(root,'supabase/migrations',name)).replaceAll('\r\n','\n'))]);
  await client.query('commit');
 }catch(error){await client.query('rollback');throw error;}
 receipt.migrations.push(name);
}
async function verifyBusinessBodies(){
 const expected=new Map();
 for(const name of receipt.migrations){
  const sql=text(join(root,'supabase/migrations',name)).replaceAll('\r\n','\n');
  for(const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:api|dek)\.\w+)\s*\([\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2\s*;/gi))expected.set(m[1].toLowerCase(),m[3].trim());
 }
 const names=['join_server','decide_join_request','decide_channel_request','request_channel_join','channel_approvers',
  'has_server_permission105','org_find_server','plat_route','plat_route_request','emit_many',
  'server_request_approvers227','on_join_request227','plat_route_server_request227'];
 const actual=(await client.query(`select n.nspname||'.'||p.proname as name,p.prosrc as body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('api','dek')
  and p.proname=any($1::text[]) order by name`,[names])).rows;
 for(const fn of actual)assert.equal(fn.body.replaceAll('\r\n','\n').trim(),expected.get(fn.name),'loaded business source differs: '+fn.name);
 assert.equal(actual.length,receipt.migrations.includes(files.at(-1))?13:10);
 receipt.businessBodies??=[];receipt.businessBodies.push({after:receipt.migrations.at(-1),verified:actual.length});
}
try{
 console.log(JSON.stringify({phase:'starting-owned-native',run,initialFreeBytes:initialFree}));
 await exec(join(bin,'initdb.exe'),['-D',data,'-U','postgres','--no-locale','--encoding=UTF8','--auth-local=trust','--auth-host=trust'],{windowsHide:true,timeout:30000});
 writeFileSync(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${port}\ncluster_name='${cluster}'\ntimezone='UTC'\nmax_connections=8\nshared_buffers='16MB'\nwork_mem='1MB'\nmaintenance_work_mem='16MB'\ntemp_buffers='2MB'\nmax_parallel_workers=0\nmax_worker_processes=0\nwal_level=minimal\nmax_wal_senders=0\nmax_replication_slots=0\nhuge_pages=off\n`,{flag:'a'});
 await check();
 await exec(join(bin,'pg_ctl.exe'),['-D',data,'-l',join(run,'postgres.log'),'-w','-t','30','start'],{windowsHide:true,timeout:35000});
 receipt.postmaster=await identity();assert.ok(receipt.postmaster);
 client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',ssl:false,
  application_name:cluster,connectionTimeoutMillis:3000,query_timeout:15000});
 client.on('error',error=>{aborted=true;receipt.connectionError={code:error.code,message:error.message};});
 await client.connect();
 const actual=(await client.query("select current_setting('cluster_name') cluster,host(inet_server_addr()) address,inet_server_port() port,current_database() database")).rows[0];
 assert.deepEqual(actual,{cluster,address:'127.0.0.1',port,database:'postgres'});
 await client.query("set statement_timeout='10s'");await client.query("set lock_timeout='500ms'");
 receipt.warnings=[];
 client.on('notice',n=>{if(n.severity==='WARNING')receipt.warnings.push(n.message);});
 monitor=setInterval(()=>{
  if(busy||aborted)return;busy=true;
  monitorTask=(async()=>{
   try{await check();}catch(error){aborted=true;receipt.memoryAbort=error.message;client?.connection.stream.destroy();}
   finally{busy=false;}
  })();
 },5000);
 await client.query(text(join(root,'tools/native227-host.sql')));
 for(const name of files.slice(0,-1))await migration(name);
 await verifyBusinessBodies();
 console.log(JSON.stringify({phase:'baseline',migrations:receipt.migrations.length}));
 await client.query('begin');try{
  const result=await client.query(text(join(root,'tools/native227-baseline.sql')));
  receipt.baseline=result.at(-1).rows[0].baseline;
  assert.deepEqual(receipt.baseline,{pending_requests:1,owner_can_approve:true,request_events:0,request_intents:0});
 }finally{await client.query('rollback');}
 await migration(files.at(-1));
 await verifyBusinessBodies();
 const {Db}=await import('../supabase/tests/_harness.mjs');
 const {cases227}=await import('../supabase/tests/join-request-cases227.mjs');
 receipt.expectedCases=cases227.length;
 for(const [name,test]of cases227){
  await check();assert.ok(!aborted);const start=Date.now();
  await client.query('begin');let failed;
  try{await test(new Db(client));assert.deepEqual(receipt.warnings,[],'business SQL warnings must fail acceptance');}catch(error){failed=error;}
  finally{await client.query('rollback');}
  const result={name,status:failed?'failed':'passed',durationMs:Date.now()-start};
  if(failed)result.error={code:failed.code,message:failed.message,stack:failed.stack};
  receipt.cases.push(result);console.log(JSON.stringify({phase:'case',...result}));
  if(failed)throw failed;
 }
 const remaining=(await client.query(`select(select count(*) from auth.users)::int users,
  (select count(*) from dek.profiles)::int profiles,(select count(*) from dek.orgs)::int orgs,
  (select count(*) from dek.notification_intents)::int intents,(select count(*) from realtime.messages)::int events,
  (select count(*) from net.http_request_queue)::int queued_http,
  (select count(*) from cron.job where active)::int active_jobs`)).rows[0];
 assert.ok(Object.values(remaining).every(n=>n===0));receipt.remaining=remaining;
 receipt.result='passed';
}catch(error){receipt.result='failed';receipt.error={code:error.code,message:error.message,stack:error.stack};process.exitCode=1;}
finally{
 clearInterval(monitor);
 clearTimeout(deadline);
 if(monitorTask)await monitorTask;
 if(aborted){receipt.result='failed';process.exitCode=1;}
 if(client){await client.query('rollback').catch(()=>{});await client.end().catch(()=>{});}
 // A failed pg_ctl start may still have started the owned postmaster. Prove its
 // exact data path, binary and incarnation before attempting only its fast stop.
 try{
  const current=await identity();
  if(current){
   if(receipt.postmaster)assert.deepEqual(current,receipt.postmaster);
   assert.equal(JSON.parse(text(join(run,'OWNER.json'))).nonce,nonce);
   await exec(join(bin,'pg_ctl.exe'),['-D',data,'-w','-t','15','-m','fast','stop'],{windowsHide:true,timeout:20000});
  }
  assert.ok(!existsSync(join(data,'postmaster.pid')));receipt.stopped=true;
  await bind();receipt.portRebound=true;
 }catch(error){receipt.cleanupFailure={message:error.message};process.exitCode=1;}
 try{receipt.finalFreeBytes=await free();}catch(error){receipt.finalMemoryReadError=error.message;}
 writeFileSync(join(run,'RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({phase:'terminal',run,result:receipt.result,passed:receipt.cases.filter(x=>x.status==='passed').length,
  attempted:receipt.cases.length,expected:receipt.expectedCases??7,stopped:receipt.stopped,portRebound:receipt.portRebound,receipt:join(run,'RECEIPT.json')}));
}
