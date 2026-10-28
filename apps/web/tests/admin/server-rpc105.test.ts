import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('../../src/api/client',()=>({rpc:vi.fn(async()=>({}))}));
import {rpc} from '../../src/api/client';
import {api} from '../../src/api/rpc';
beforeEach(()=>vi.clearAllMocks());
it('uses the exact reviewed native policy, control and activity argument names',async()=>{
 await api.getServerRolePolicy('s');expect(rpc).toHaveBeenLastCalledWith('get_server_role_permissions105',{p_server:'s'});
 await api.setServerRolePolicy('s','moderator',{pin_messages:false},3);expect(rpc).toHaveBeenLastCalledWith('set_server_role_permissions105',{p_server:'s',p_role:'moderator',p_permissions:{pin_messages:false},p_expected_version:3,p_reset:false});
 await api.setServerRolePolicy('s','member',{},4,true);expect(rpc).toHaveBeenLastCalledWith('set_server_role_permissions105',{p_server:'s',p_role:'member',p_permissions:{},p_expected_version:4,p_reset:true});
 await api.setServerMemberControl('s','u','mute','2026-10-29T00:00:00Z','Fictional QA');expect(rpc).toHaveBeenLastCalledWith('set_server_member_control105',{p_server:'s',p_user:'u',p_action:'mute',p_until:'2026-10-29T00:00:00Z',p_reason:'Fictional QA'});
 await api.setServerMemberControl('s','u','unban');expect(rpc).toHaveBeenLastCalledWith('set_server_member_control105',{p_server:'s',p_user:'u',p_action:'unban',p_until:null,p_reason:null});
 await api.listServerMemberControls('s');expect(rpc).toHaveBeenLastCalledWith('list_server_member_controls105',{p_server:'s'});
 await api.listServerActivity('s',87,20);expect(rpc).toHaveBeenLastCalledWith('list_server_activity105',{p_server:'s',p_before:87,p_limit:20});
});
