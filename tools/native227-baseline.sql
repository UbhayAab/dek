-- G08 baseline only. Executed by the exact guarded rollback-only runner.
-- All UUIDs below are fixed, synthetic and prechecked absent before insertion.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
 raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('00000000-0000-0000-0000-000000000000','22700000-1112-4000-8000-000000000001','authenticated','authenticated',
  'dek227-g08-20261112-owner@dek-test.invalid','',now(),'{"provider":"email","providers":["email"]}',
  '{"display_name":"G08 synthetic owner"}',now(),now()),
 ('00000000-0000-0000-0000-000000000000','22700000-1112-4000-8000-000000000002','authenticated','authenticated',
  'dek227-g08-20261112-requester@dek-test.invalid','',now(),'{"provider":"email","providers":["email"]}',
  '{"display_name":"G08 synthetic requester"}',now(),now());
insert into dek.orgs(id,slug,name,created_by)
values('22700000-1112-4000-8000-000000000101','g08-227-20261112-baseline','G08 synthetic rollback organization',
 '22700000-1112-4000-8000-000000000001');
insert into dek.org_members(org_id,user_id,role,status) values
 ('22700000-1112-4000-8000-000000000101','22700000-1112-4000-8000-000000000001','owner','active'),
 ('22700000-1112-4000-8000-000000000101','22700000-1112-4000-8000-000000000002','member','active');
insert into dek.servers(id,org_id,name,join_policy)
values('22700000-1112-4000-8000-000000000201','22700000-1112-4000-8000-000000000101','G08 synthetic approval server','approval');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"22700000-1112-4000-8000-000000000002","role":"authenticated","aud":"authenticated"}',true);
select api.join_server('22700000-1112-4000-8000-000000000201') as first_join;
select api.join_server('22700000-1112-4000-8000-000000000201') as repeated_join;
reset role;
select jsonb_build_object(
 'pending_requests',(select count(*) from dek.join_requests where org_id='22700000-1112-4000-8000-000000000101' and status='pending'),
 'owner_can_approve',dek.has_server_permission105('22700000-1112-4000-8000-000000000001','22700000-1112-4000-8000-000000000201','decide_join_requests'),
 'request_events',(select count(*) from realtime.messages where topic='u:22700000-1112-4000-8000-000000000001'
   and event in ('join.req','server.join.req') and payload->>'org_id'='22700000-1112-4000-8000-000000000101'),
 'request_intents',(select count(*) from dek.notification_intents where org_id='22700000-1112-4000-8000-000000000101' and kind='request')
) as baseline;
