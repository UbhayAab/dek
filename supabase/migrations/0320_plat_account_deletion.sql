-- 0320: account deletion (PRD APP08: in-app deletion for store review). Owner: plat.
--
-- Two steps, so a half-finished deletion can always be finished:
--   1. api.request_account_deletion, as the signed-in person: refused while they are
--      the last owner of an organization; otherwise every organization is left
--      through dek.revoke_org_membership (memberships, follows, access.revoked),
--      devices, preferences, saved messages and blocks they made are removed,
--      pending join requests are withdrawn, and the profile is anonymised. From
--      that moment dek.require_uid() refuses the account everywhere.
--   2. The account-delete Edge Function deletes the auth user with the admin API,
--      then calls api.svc_complete_account_deletion, which checks the auth user is
--      gone and purges the delivery log.
-- Messages they wrote stay, shown as "Deleted user": they are the organization's
-- record of the conversation (the retention the store listing explains).

-- "This person's pending requests" when they delete their account.
create index if not exists plat_join_requests_user_idx on dek.join_requests (user_id) where status = 'pending';

create or replace function api.request_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  v_org text;
  r     record;
begin
  -- Two co-owners deleting at the same moment must not both pass the check below:
  -- lock the owner rows of every org the caller owns (in a fixed order, so callers
  -- cannot deadlock). The second caller waits, then sees the first one gone.
  perform 1 from dek.org_members x
   where x.role = 'owner'
     and x.org_id in (select m.org_id from dek.org_members m where m.user_id = v_uid and m.role = 'owner')
   order by x.org_id, x.user_id
   for update;
  select o.name into v_org
    from dek.org_members m
    join dek.orgs o on o.id = m.org_id
   where m.user_id = v_uid and m.role = 'owner'
     and not exists (select 1 from dek.org_members x
                      where x.org_id = m.org_id and x.role = 'owner' and x.status = 'active'
                        and x.user_id <> v_uid)
   order by o.name
   limit 1;
  if v_org is not null then
    perform dek.err('conflict', format('You are the last owner of %s. Make someone else an owner first.', v_org));
  end if;
  for r in select m.org_id from dek.org_members m where m.user_id = v_uid order by m.org_id loop
    perform dek.audit(r.org_id, 'member.account_deleted', 'user', v_uid);
    perform dek.revoke_org_membership(r.org_id, v_uid, false, null);
  end loop;
  delete from dek.push_devices where user_id = v_uid;
  delete from dek.notification_prefs where user_id = v_uid;
  delete from dek.saved_messages where user_id = v_uid;
  delete from dek.user_blocks where blocker_id = v_uid;
  delete from dek.platform_admins where user_id = v_uid;
  update dek.join_requests set status = 'withdrawn', decided_at = now()
   where user_id = v_uid and status = 'pending';
  update dek.profiles
     set display_name = 'Deleted user', handle = null, avatar_path = null, title = null,
         status_text = null, status_emoji = null, status_until = null, last_active_at = null,
         deleted_at = now(), updated_at = now()
   where id = v_uid;
  return jsonb_build_object('status', 'scheduled');
end $$;

-- Step 2, after the auth user is gone. Idempotent.
create or replace function api.svc_complete_account_deletion(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p dek.profiles;
begin
  if p_user is null then
    perform dek.err('invalid_input', 'user: required.');
  end if;
  select * into p from dek.profiles x where x.id = p_user for update;
  if not found then
    perform dek.err('not_found', 'That account does not exist.');
  end if;
  if p.deleted_at is null then
    perform dek.err('conflict', 'Deletion was not requested for this account.');
  end if;
  if exists (select 1 from auth.users u where u.id = p_user) then
    perform dek.err('conflict', 'The sign-in account still exists. Delete it first.');
  end if;
  delete from dek.push_devices where user_id = p_user;
  delete from dek.notification_prefs where user_id = p_user;
  delete from dek.notification_deliveries where user_id = p_user;
  delete from dek.rate_buckets where user_id = p_user;
  return jsonb_build_object('status', 'deleted');
end $$;
