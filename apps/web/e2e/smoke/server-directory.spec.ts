// #53: deployed UI plus real authorization, using only the Dek QA organization.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { qaRpc, signIn } from '../ui/session';

interface Server { id:string; name:string; join_policy:string; requested?:boolean; my_role:string|null }
const overflow = async (page:Page) => page.evaluate(()=>({
  page:document.documentElement.scrollWidth, viewport:innerWidth,
  rows:[...document.querySelectorAll('.ap-row')].map(el=>({width:el.scrollWidth, client:el.clientWidth})),
}));

test('all active servers are discoverable and invites coexist with approved requests',async({page,context,browser},info)=>{
  test.setTimeout(240_000);
  const me=await qaRpc<{user_id:string;orgs:{id:string;name:string}[]}>('alice','me',{});
  const org=me.orgs.find(o=>o.name==='Dek QA')?.id;
  if(!org)throw new Error('Dek QA membership missing');
  const stamp=`QA53 ${info.project.name==='desktop'?'D':'P'}-${Date.now().toString().slice(-6)}`;
  const created:Server[]=[];
  const out=process.env.DEK_DIRECTORY_SHOTS ?? resolve('test-results/server-directory');
  mkdirSync(out,{recursive:true});
  const events:string[]=[];
  page.on('pageerror',e=>events.push(e.message));
  const ownerContext=await browser.newContext({...info.project.use});
  const owner=await ownerContext.newPage();
  owner.on('pageerror',e=>events.push(e.message));
  const receipt:{at:string;url?:string;viewport:unknown;checks:Record<string,unknown>;fixtures:Server[];cleanup:unknown[]}={
    at:new Date().toISOString(),viewport:info.project.use.viewport,checks:{},fixtures:created,cleanup:[],
  };
  try {
    for(const suffix of ['Invites','Requests','Open','Collaborate'])created.push(await qaRpc<Server>('owner','create_server',{
      p_org:org,p_name:`${stamp} ${suffix}`,p_join_policy:suffix==='Open'?'open':suffix==='Collaborate'?'approval':'invite',
    }));
    const [invite,requests,open,partial]=created;
    await qaRpc('owner','create_channel',{p_server:partial.id,p_name:'qa-project',p_visibility:'private',p_member_ids:[me.user_id]});
    await signIn(ownerContext,'owner');
    await owner.goto(`/o/${org}/s/${requests.id}/settings#general`);
    const invites=owner.getByRole('checkbox',{name:'Invite links',exact:true});
    await expect(invites).toBeChecked();await expect(invites).toBeDisabled();
    await owner.getByRole('checkbox',{name:'Ask to join',exact:true}).check();
    await expect(owner.getByRole('checkbox',{name:'Open',exact:true})).not.toBeChecked();
    await owner.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect.poll(async()=> (await qaRpc<Server[]>('owner','list_servers',{p_org:org})).find(s=>s.id===requests.id)?.join_policy).toBe('approval');
    await owner.reload();
    await expect(owner.getByRole('checkbox',{name:'Ask to join',exact:true})).toBeChecked();
    await owner.locator('fieldset').filter({has:owner.getByRole('checkbox',{name:'Invite links',exact:true})}).last()
      .screenshot({path:resolve(out,`53-methods-${info.project.name}.png`)});
    await owner.screenshot({path:resolve(out,`53-settings-${info.project.name}.png`)});
    receipt.checks.savedMethods=['Invite links','Ask to join'];

    await signIn(context,'alice');
    await page.goto(`/o/${org}/browse`);
    await page.getByRole('searchbox',{name:'Find a server',exact:true}).fill(stamp);
    const directory=page.getByRole('list',{name:'Team servers',exact:true});
    await expect(directory.getByRole('listitem')).toHaveCount(4);
    await expect(page.getByTestId(`server-${partial.id}`).getByText('Selected channels')).toBeVisible();
    await expect(page.getByTestId(`server-${partial.id}`).getByRole('button',{name:'Ask to join',exact:true})).toBeVisible();
    await expect(page.getByTestId(`server-${invite.id}`).getByRole('button')).toHaveCount(0);
    const inviteChannels=await qaRpc<unknown[]>('alice','list_channels',{p_server:invite.id});
    expect(inviteChannels).toEqual([]);
    await page.getByTestId(`server-${requests.id}`).getByRole('button',{name:'Ask to join',exact:true}).click();
    await expect(page.getByTestId(`server-${requests.id}`).getByText('Request sent')).toBeVisible();
    await page.reload();
    await page.getByRole('searchbox',{name:'Find a server',exact:true}).fill(stamp);
    await expect(page.getByTestId(`server-${requests.id}`).getByText('Request sent')).toBeVisible();
    expect(await qaRpc<unknown[]>('alice','list_channels',{p_server:requests.id})).toEqual([]);
    await page.getByTestId(`server-${open.id}`).getByRole('button',{name:'Join',exact:true}).click();
    await expect(page.getByTestId(`server-${open.id}`).getByText('Joined',{exact:true})).toBeVisible();
    const openChannels=page.getByRole('list',{name:`Channels in ${open.name}`,exact:true});
    await expect(openChannels).toBeAttached();
    receipt.checks.channelsRefreshedAfterJoin=true;
    receipt.checks.directory=await overflow(page);
    expect((receipt.checks.directory as Awaited<ReturnType<typeof overflow>>).page).toBeLessThanOrEqual(page.viewportSize()!.width);
    for(const row of (receipt.checks.directory as Awaited<ReturnType<typeof overflow>>).rows)expect(row.width).toBeLessThanOrEqual(row.client+1);
    await page.screenshot({path:resolve(out,`53-directory-${info.project.name}.png`)});
    await directory.screenshot({path:resolve(out,`53-directory-detail-${info.project.name}.png`)});
    receipt.checks.pendingSurvivedReload=true;
    receipt.checks.inviteOnlyChannelsHidden=true;
    receipt.checks.openJoined=true;
    await page.getByRole('searchbox',{name:'Find a channel',exact:true}).fill('no-channel-match');
    await page.getByTestId(`server-${open.id}`).getByRole('button',{name:'View channels',exact:true}).click();
    await expect(openChannels).toBeInViewport();
    await expect(page.getByRole('searchbox',{name:'Find a channel',exact:true})).toHaveValue('');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/o/${org}/browse$`));
    await expect(page.getByRole('heading',{name:'Team servers',exact:true})).toBeInViewport();
    await page.getByRole('searchbox',{name:'Find a server',exact:true}).fill(stamp);
    receipt.checks.viewChannelsAndBack=true;
    const list=await qaRpc<{items:{id:string;server_id:string;user:{id:string}}[]}>('owner','list_join_requests',{p_org:org});
    const request=list.items.find(r=>r.server_id===requests.id && r.user.id===me.user_id);
    expect(request).toBeTruthy();
    await owner.goto(`/o/${org}/s/${requests.id}/settings#requests`);
    await owner.getByTestId(`request-${request!.id}`).getByRole('button',{name:'Approve',exact:true}).click();
    await expect(owner.getByTestId(`request-${request!.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`server-${requests.id}`).getByText('Joined',{exact:true})).toBeVisible({timeout:30_000});
    receipt.checks.approvalRefreshedWithoutReload=true;
    await page.reload();
    await page.getByRole('searchbox',{name:'Find a server',exact:true}).fill(stamp);
    await expect(page.getByTestId(`server-${requests.id}`).getByText('Joined',{exact:true})).toBeVisible();
    expect((await qaRpc<unknown[]>('alice','list_channels',{p_server:requests.id})).length).toBeGreaterThan(0);
    receipt.checks.approvedAndJoined=true;
    receipt.checks.adminApprovedThroughUi=true;
    await page.screenshot({path:resolve(out,`53-approved-${info.project.name}.png`)});
    const settingsOverflow=await overflow(owner);
    expect(settingsOverflow.page).toBeLessThanOrEqual(owner.viewportSize()!.width);
    receipt.checks.settings=settingsOverflow;
    receipt.url=page.url();
    expect(events).toEqual([]);
    receipt.checks.pageErrors=events;
  } finally {
    // Reversible cleanup through the same API. No real server or membership is touched.
    const cleanupErrors:string[]=[];
    try {
      writeFileSync(resolve(out,`53-fixtures-before-cleanup-${info.project.name}.json`),JSON.stringify(created,null,2));
      for(const s of created) {
        try {
          const archived=await qaRpc<{archived:boolean}>('owner','archive_server',{p_server:s.id,p_archived:true});
          receipt.cleanup.push({id:s.id,archived:archived.archived});
        } catch {
          cleanupErrors.push(s.id);
          receipt.cleanup.push({id:s.id,archived:false});
        }
      }
      writeFileSync(resolve(out,`53-live-${info.project.name}.json`),JSON.stringify(receipt,null,2));
    } finally {
      await ownerContext.close();
    }
    expect.soft(cleanupErrors,'all synthetic QA servers archived').toEqual([]);
  }
});
