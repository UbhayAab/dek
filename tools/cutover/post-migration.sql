-- Cutover step 3b (docs/CUTOVER.md): lead data decisions that a migration pass from
-- legacy may not carry. Idempotent; run after every full --apply.
-- node tools/db.mjs sql "$(cat tools/cutover/post-migration.sql)"

-- Ubhay's main account (ubhayvatsaanand@gmail.com) is the platform admin and an owner of
-- Jarurat Care as well as Safalta Setu, so one sign-in sees both organizations.
insert into dek.platform_admins (user_id)
values ('1365b80e-df00-4174-945b-e9e318165317')
on conflict do nothing;

insert into dek.org_members (org_id, user_id, role)
values ('019f993c-604d-7129-af26-e406dd9da295', '1365b80e-df00-4174-945b-e9e318165317', 'owner')
on conflict (org_id, user_id) do update set role = 'owner', status = 'active';

-- Legacy invites never expired; migrated ones were stored with expiry 2100. Cap every
-- still-open one at 60 days from now so an old link cannot sit valid for decades.
update dek.invites
   set expires_at = least(expires_at, now() + interval '60 days')
 where legacy_id is not null and revoked_at is null
   and expires_at > now() + interval '60 days';

select (select count(*) from dek.platform_admins) as platform_admins,
       (select role from dek.org_members
         where org_id = '019f993c-604d-7129-af26-e406dd9da295'
           and user_id = '1365b80e-df00-4174-945b-e9e318165317') as ubhay_jcf_role,
       (select count(*) from dek.invites
         where revoked_at is null and expires_at > now() + interval '61 days') as long_invites;
