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
-- still-open one at 7 days from now: an old link shared around for months should not
-- also unlock sign-in codes for newcomers (security review 2026-10-04). Admins make new
-- links in a moment.
update dek.invites
   set expires_at = least(expires_at, now() + interval '7 days')
 where legacy_id is not null and revoked_at is null
   and expires_at > now() + interval '7 days';

-- Migrated accounts that belong to no organization keep their name but lose their
-- password: legacy let anyone register any address with a password, so such an account
-- may have been set up by someone other than the mailbox owner. They sign in with an
-- emailed code (which proves the mailbox) and can choose a password then.
update auth.users u
   set encrypted_password = ''
 where coalesce(u.encrypted_password, '') <> ''
   and u.email not like '%.invalid'
   and exists (select 1 from dek_migration.id_map m where m.kind = 'user' and m.new_id = u.id)
   and not exists (select 1 from dek.org_members om where om.user_id = u.id and om.status = 'active');

select (select count(*) from dek.platform_admins) as platform_admins,
       (select role from dek.org_members
         where org_id = '019f993c-604d-7129-af26-e406dd9da295'
           and user_id = '1365b80e-df00-4174-945b-e9e318165317') as ubhay_jcf_role,
       (select count(*) from dek.invites
         where revoked_at is null and expires_at > now() + interval '8 days') as long_invites,
       (select count(*) from auth.users u
         where coalesce(u.encrypted_password, '') <> ''
           and not exists (select 1 from dek.org_members om where om.user_id = u.id and om.status = 'active')) as no_org_passwords;
