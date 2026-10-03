-- 0904: an account removed straight from Auth (dashboard, admin API, a wipe tool) gets
-- the same cleanup as the in-app deletion (0320 step 1): memberships revoked, devices,
-- preferences and saved items dropped, the profile anonymized to "Deleted user" so the
-- messages they wrote keep an author. Before this, such a person stayed listed as a live
-- member with their name. In-app deletion has already done all of it (deleted_at is
-- set), so the trigger does nothing for that path. Owner: lead.

create or replace function dek.cleanup_deleted_account(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not exists (select 1 from dek.profiles p where p.id = p_user and p.deleted_at is null) then
    return;
  end if;
  for r in select m.org_id from dek.org_members m where m.user_id = p_user order by m.org_id loop
    perform dek.audit(r.org_id, 'member.account_deleted', 'user', p_user);
    perform dek.revoke_org_membership(r.org_id, p_user, false, null);
  end loop;
  delete from dek.push_devices where user_id = p_user;
  delete from dek.notification_prefs where user_id = p_user;
  delete from dek.saved_messages where user_id = p_user;
  delete from dek.user_blocks where blocker_id = p_user;
  delete from dek.platform_admins where user_id = p_user;
  update dek.join_requests set status = 'withdrawn', decided_at = now()
   where user_id = p_user and status = 'pending';
  update dek.profiles
     set display_name = 'Deleted user', handle = null, avatar_path = null, title = null,
         status_text = null, status_emoji = null, status_until = null, last_active_at = null,
         deleted_at = now(), updated_at = now()
   where id = p_user;
end $$;

create or replace function dek.on_auth_user_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform dek.cleanup_deleted_account(old.id);
  return old;
end $$;

drop trigger if exists dek_auth_user_deleted on auth.users;
create trigger dek_auth_user_deleted after delete on auth.users
  for each row execute function dek.on_auth_user_deleted();

-- profiles already orphaned by earlier direct deletions
do $$
declare r record;
begin
  for r in select p.id from dek.profiles p
            where p.deleted_at is null
              and not exists (select 1 from auth.users u where u.id = p.id) loop
    perform dek.cleanup_deleted_account(r.id);
  end loop;
end $$;
