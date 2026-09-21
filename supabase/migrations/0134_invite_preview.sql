-- 0134: say what the invite is for, before asking who you are
--
-- 253 invites have been created on this database and 74 redeemed. 29%. 68 have
-- expired unused.
--
-- The structural reason is the order of the two questions. redeem_invite
-- requires auth.uid(), so an invited stranger must create an account BEFORE
-- anything can tell them what they were invited to. What they actually see is
-- a generic sign-in card: no server name, no inviter, no indication the link
-- did anything at all. main.js stashes the token and redeems it afterwards,
-- which is the right machinery - but from the person's side they are being
-- asked to register with a product nobody has told them anything about.
--
-- Every invite flow that converts does this the other way round. Slack, Discord
-- and Notion all show "X invited you to Y" on the signed-out screen, then ask.
--
-- This is the read that makes that possible: callable by `anon`, returning only
-- what an invite link already tells whoever is holding it.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: any id, the member list, channel
-- names, the org's other servers, or anything at all for a bad token beyond
-- "invalid". Holding a valid invite already implies being told the server's
-- name by whoever sent it, so naming it leaks nothing new. Holding a *guess*
-- reveals nothing, because the lookup is by sha256 and a miss is
-- indistinguishable from a revoked link.

create or replace function public.invite_preview(p_token text)
returns table(state text, workspace_name text, org_name text,
              inviter text, member_count int, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_inv public.invites; v_ws public.workspaces; v_hash bytea;
begin
  -- Cheap guard against somebody walking the token space through this
  -- endpoint. Not a substitute for the sha256 lookup, just a cost on volume.
  if p_token is null or length(p_token) < 8 or length(p_token) > 200 then
    state := 'invalid'; return next; return;
  end if;

  v_hash := extensions.digest(p_token, 'sha256');
  select * into v_inv from public.invites where token_sha256 = v_hash;
  if v_inv.id is null then state := 'invalid'; return next; return; end if;

  select * into v_ws from public.workspaces where id = v_inv.workspace_id;
  if v_ws.id is null then state := 'invalid'; return next; return; end if;

  -- The name comes back even when the link is spent, because "Carcinome - that
  -- link has been used" is an answer somebody can act on, and "invalid" is not.
  workspace_name := v_ws.name::text;
  expires_at := v_inv.expires_at;
  select o.name::text into org_name from public.organizations o where o.id = v_ws.org_id;
  select coalesce(p.display_name, p.username::text) into inviter
    from public.profiles p where p.id = v_inv.created_by;
  select count(*)::int into member_count
    from public.workspace_members wm where wm.workspace_id = v_inv.workspace_id;

  state := case
    when v_inv.revoked_at is not null then 'revoked'
    when v_inv.expires_at is not null and v_inv.expires_at < now() then 'expired'
    when v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses then 'exhausted'
    else 'ok' end;
  return next;
end;
$fn$;

-- The whole point is that it answers before anybody has signed in.
grant execute on function public.invite_preview(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The org-invite equivalent, for #/join-org/<token> links.
-- ---------------------------------------------------------------------------
create or replace function public.org_invite_preview(p_token text)
returns table(state text, org_name text, inviter text, member_count int,
              expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_inv public.org_invites; v_org public.organizations; v_hash bytea;
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 200 then
    state := 'invalid'; return next; return;
  end if;

  v_hash := extensions.digest(p_token, 'sha256');
  select * into v_inv from public.org_invites where token_sha256 = v_hash;
  if v_inv.id is null then state := 'invalid'; return next; return; end if;

  select * into v_org from public.organizations where id = v_inv.org_id;
  if v_org.id is null then state := 'invalid'; return next; return; end if;

  org_name := v_org.name::text;
  expires_at := v_inv.expires_at;
  select coalesce(p.display_name, p.username::text) into inviter
    from public.profiles p where p.id = v_inv.created_by;
  select count(*)::int into member_count
    from public.org_members om where om.org_id = v_inv.org_id;

  state := case
    when v_inv.revoked_at is not null then 'revoked'
    when v_inv.expires_at is not null and v_inv.expires_at < now() then 'expired'
    when v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses then 'exhausted'
    else 'ok' end;
  return next;
end;
$fn$;

grant execute on function public.org_invite_preview(text) to anon, authenticated;
