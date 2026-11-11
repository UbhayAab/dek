// The actual unchanged signed hook, HMAC verifier and mail mapping. All transport
// is trapped at a reserved fake URL; there is no real Auth, SDK or provider.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {createContext, SourceTextModule} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const key = new Uint8Array(32).fill(7);
const secret = 'v1,whsec_' + btoa(String.fromCharCode(...key));
async function fixture() {
  let handler; const mails=[];
  const env={SEND_EMAIL_HOOK_SECRET:secret,MAIL_URL:'https://hook-mailer.fixture.invalid',MAIL_API_KEY:'fixture-only'};
  const context=createContext({Request,Response,Headers,TextEncoder,Uint8Array,crypto,AbortSignal,btoa,atob,console:{log(){},error(){}},
    Deno:{env:{get:name=>env[name]},serve:fn=>handler=fn},fetch:async(url,options)=>{
      assert.equal(url,'https://hook-mailer.fixture.invalid/api/v1/transactional/send');mails.push(JSON.parse(options.body));return Response.json({status:'sent'});
    }});
  const sources=await Promise.all(['index.ts','hook.ts'].map(name=>readFile(new URL('../functions/auth-email/'+name,import.meta.url),'utf8')));
  // Pin original Git content independently of rendering; allow Git's Windows
  // checkout line-ending conversion without changing either hook source file.
  for(const [i,hash] of ['db7736d146bb93f4e6c23f0a3f81612698b0164460639e5fd6277d7d92c26238','3c68d6e786c84ea4b9b3ff977aecc50e388618b3ddea38b3a1a5dd2e0420a790'].entries())
    assert.equal(createHash('sha256').update(sources[i].replaceAll('\r\n','\n')).digest('hex'),hash);
  const core=new SourceTextModule(stripTypeScriptTypes(sources[1]),{context});
  const entry=new SourceTextModule(stripTypeScriptTypes(sources[0]),{context});
  await entry.link(spec=>{assert.equal(spec,'./hook.ts');return core;});await entry.evaluate();
  async function call(action, valid=true) {
    const body=JSON.stringify({user:{email:'before@hook206.fixture',new_email:'after@hook206.fixture'},email_data:{email_action_type:action,token:'01234567',token_new:'76543210'}});
    const id='fixture206', timestamp=String(Math.floor(Date.now()/1000));
    const signing=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',signing,new TextEncoder().encode(`${id}.${timestamp}.${body}`)))));
    const response=await handler(new Request('https://hook.fixture.invalid',{method:'POST',headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+(valid?signature:'invalid')},body}));
    return {status:response.status,body:await response.json()};
  }
  return {call,mails};
}
test('signed email-change keeps two exact original Dek template/data sends',async()=>{
  const f=await fixture();assert.equal((await f.call('email_change')).status,200);
  assert.deepEqual(f.mails,[
    {template:'dek-otp',to:'before@hook206.fixture',data:{CODE:'01234567',EMAIL:'before@hook206.fixture',FROM_NAME:'Dek'}},
    {template:'dek-otp',to:'after@hook206.fixture',data:{CODE:'76543210',EMAIL:'after@hook206.fixture',FROM_NAME:'Dek'}},
  ]);
});
test('valid signed unsupported sign-in hook stays refused and unsigned email-change never sends',async()=>{
  const f=await fixture();const unsupported=await f.call('magiclink');assert.equal(unsupported.body.error.http_code,400);
  assert.equal((await f.call('email_change',false)).status,401);assert.equal(f.mails.length,0);
});
