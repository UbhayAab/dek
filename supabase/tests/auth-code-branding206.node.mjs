// Full actual edge handler, isolated SDK/transport. No Auth/provider/network.
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=new URL('../functions/auth-code/index.ts',import.meta.url);
const email='fictional-owner@example.test';
async function fixture({mail=true,reason=null,mailStatus=200}={}){
 let handler;const calls=[],mails=[],clients=[];let issued;
 const sdk={rpc:async(name,args)=>{calls.push({name,args});if(name==='svc_auth_code_issue'){issued=args;return{data:reason?{ok:false,reason}:{ok:true,mail}};}if(name==='svc_auth_code_verify')return{data:{ok:Boolean(issued&&args.p_email===issued.p_email&&args.p_code_hash===issued.p_code_hash&&args.p_request_hash===issued.p_request_hash),existing:true,reason:'wrong_code'}};if(name==='svc_auth_code_release')return{data:{ok:true}};throw Error('Unexpected RPC');},auth:{admin:{generateLink:async args=>{calls.push({name:'generateLink',args});return{data:{properties:{hashed_token:'fictional-link'},user:{last_sign_in_at:'2026-11-01'}}};},createUser:async()=>{throw Error('No account creation expected');}},verifyOtp:async args=>{calls.push({name:'verifyOtp',args});return{data:{session:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer'}}};}}};
 const env={SUPABASE_URL:'https://identity.fixture.invalid',SUPABASE_SECRET_KEYS:JSON.stringify(['sb_secret_fixture_only']),DEK_INTERNAL_SECRET:'fictional-hmac-only',MAIL_URL:'https://mailer.fixture.invalid',MAIL_API_KEY:'fictional-mail-key'};
 const context=createContext({Request,Response,Headers,TextEncoder,Uint8Array,Uint32Array,crypto,AbortSignal,btoa,setTimeout:fn=>{queueMicrotask(fn);return 0;},Deno:{env:{get:key=>env[key]},serve:fn=>handler=fn},fetch:async(url,options)=>{assert.equal(url,'https://mailer.fixture.invalid/api/v1/transactional/send');assert.equal(options.method,'POST');mails.push(JSON.parse(options.body));return Response.json({status:'sent'},{status:mailStatus});}});
 const mod=new SourceTextModule(stripTypeScriptTypes(await readFile(source,'utf8')),{context});
 const stub=new SyntheticModule(['createClient'],function(){this.setExport('createClient',(url,key,options)=>{clients.push({url,options});return sdk;});},{context});
 await mod.link(spec=>{assert.match(spec,/^npm:@supabase\/supabase-js@2\.117\.2$/);return stub;});await mod.evaluate();
 const call=async(body,origin)=>{const response=await handler(new Request('https://identity.fixture.invalid/functions/v1/auth-code',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()};};
 return{call,calls,mails,clients};
}
for(const origin of['https://arc.jarurat.care','https://arc-55i.pages.dev','https://abc123.arc-55i.pages.dev'])test('Arc request receives fixed Arc merge fields from '+origin,async()=>{
 const f=await fixture();const r=await f.call({action:'send',email,app:'arc'},origin);assert.equal(r.status,200);assert.equal(f.mails.length,1);assert.equal(f.mails[0].template,'dek-otp-shared206');assert.equal(f.mails[0].data.APP_NAME,'Arc');assert.equal(f.mails[0].data.APP_INITIAL,'A');assert.equal(f.mails[0].data.FROM_NAME,'Arc');assert.match(f.mails[0].data.CODE,/^\d{8}$/);assert.equal(f.mails[0].to,email);assert(r.body.request);
});
for(const body of[{action:'send',email},{action:'send',email,app:'dek'}])test('untagged or explicit Dek keeps native/default behavior '+String(body.app),async()=>{
 const f=await fixture();const r=await f.call(body);assert.equal(r.status,200);assert.equal(f.mails[0].template,'dek-otp');assert.deepEqual(Object.keys(f.mails[0].data).sort(),['CODE','EMAIL','FROM_NAME']);assert.equal(f.mails[0].data.FROM_NAME,'Dek');
});
for(const [app,origin] of[['Arc','https://arc.jarurat.care'],['<b>Fake</b>','https://arc.jarurat.care'],['arc',undefined],['arc','https://dek-7o4.pages.dev'],['arc','https://arc.jarurat.care.evil.test'],['arc','https://evil.test/arc.jarurat.care'],['arc','http://arc-55i.pages.dev'],['arc','https://x.y.arc-55i.pages.dev'],['arc','https://arc.jarurat.care:444'],['arc','https://user@arc.jarurat.care'],['arc','null']])test('unrecognized branding/caller refused before issue: '+app+' '+origin,async()=>{
 const f=await fixture();const r=await f.call({action:'send',email,app},origin);assert.equal(r.status,400);assert.equal(r.body.error,'invalid_request');assert.equal(f.mails.length,0);assert.equal(f.calls.length,0);
});
test('same account challenge/request verify session stays standard and independent of app hint',async()=>{
 const f=await fixture();const sent=await f.call({action:'send',email:' '+email.toUpperCase()+' ',app:'arc'},'https://arc.jarurat.care');const code=f.mails[0].data.CODE;
 const verified=await f.call({action:'verify',email,code,request:sent.body.request,app:'dek'});
 assert.equal(verified.status,200);assert.equal(verified.body.session.access_token,'fixture-access');assert.equal(verified.body.session.refresh_token,'fixture-refresh');assert.equal(verified.body.new_user,false);
 assert.equal(f.calls[0].name,'svc_auth_code_issue');assert.equal(f.calls[0].args.p_email,email);assert.deepEqual(Object.keys(f.calls[0].args).sort(),['p_code_hash','p_email','p_invite_code','p_ip','p_request_hash']);
 assert.equal(f.calls[1].name,'svc_auth_code_verify');assert.equal(f.calls[1].args.p_request_hash,f.calls[0].args.p_request_hash);assert.equal(f.calls[1].args.p_code_hash,f.calls[0].args.p_code_hash);assert.equal(f.clients.length,2);assert(f.clients.every(c=>c.options.auth.persistSession===false));assert.equal(f.mails.length,1);
});
test('wrong request remains denied and never creates provider session',async()=>{
 const f=await fixture();await f.call({action:'send',email});const result=await f.call({action:'verify',email,code:f.mails[0].data.CODE,request:'different-request-fixture-only'});assert.equal(result.status,400);assert.equal(f.calls.some(c=>c.name==='generateLink'),false);
 assert.equal(result.body.message,'That code is not right. Check your latest sign-in email.');
});
test('unknown account returns generic request and no mail after brand validation',async()=>{
 const f=await fixture({mail:false});const r=await f.call({action:'send',email,app:'arc'},'https://arc.jarurat.care');assert.equal(r.status,200);assert.equal(r.body.ok,true);assert(r.body.request);assert.equal(f.mails.length,0);
});
test('rate and mail failure semantics stay unchanged',async()=>{
 const limited=await fixture({reason:'too_soon'});assert.equal((await limited.call({action:'send',email})).status,429);assert.equal(limited.mails.length,0);
 const failed=await fixture({mailStatus:503});assert.equal((await failed.call({action:'send',email})).status,502);
});
test('shared busy recovery does not direct Arc users to another app',async()=>{
 const f=await fixture({reason:'busy'});const result=await f.call({action:'send',email,app:'arc'},'https://arc.jarurat.care');
 assert.equal(result.status,503);assert.equal(result.body.error,'busy');assert.match(result.body.message,/Sign-in codes are busy/);
 assert.equal(f.mails.length,0);assert.doesNotMatch(result.body.message,/Dek/);
});
test('arbitrary extra fields cannot supply merge HTML subject code or recipient',async()=>{
 const f=await fixture();await f.call({action:'send',email,app:'arc',APP_NAME:'Injected',subject:'Injected',data:{CODE:'00000000'},to:'other@example.test'},'https://arc.jarurat.care');const wire=f.mails[0];assert.equal(wire.data.APP_NAME,'Arc');assert.equal(wire.to,email);assert.equal(Object.hasOwn(wire,'subject'),false);assert.notEqual(wire.data.CODE,'00000000');
});
test('missing configured Arc template fails normally without wrong-brand fallback',async()=>{
 const f=await fixture({mailStatus:404});const response=await f.call({action:'send',email,app:'arc'},'https://arc.jarurat.care');
 assert.equal(response.status,502);assert.equal(response.body.error,'mail_failed');
 assert.equal(f.mails.length,1);assert.equal(f.mails[0].template,'dek-otp-shared206');
 // Preserve existing send-failure/rate semantics; release is only a consumed
 // verification recovery operation, never an invitation to bypass issue brakes.
 assert.deepEqual(f.calls.map(c=>c.name),['svc_auth_code_issue']);
});
