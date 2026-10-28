-- Drive counts from caller memberships and indexed unread sequence ranges.
-- Authorization is checked once per eligible channel, before per-message probes.
create or replace function dek.mention_unread_count(p_uid uuid,p_org uuid default null,p_channel uuid default null)
returns int language sql stable security definer set search_path='' as $$
  with eligible as materialized (
    select cm.channel_id,cm.last_read_seq from dek.channel_members cm
    where cm.user_id=p_uid and (p_org is null or cm.org_id=p_org)
      and (p_channel is null or cm.channel_id=p_channel) and dek.can_read_channel(p_uid,cm.channel_id)
  )
  select count(*)::int from (
    select id from (
      (select direct.id from eligible cm cross join lateral (
        select m.id from dek.mentions mn cross join lateral (
          select x.id from dek.messages x where x.id=mn.message_id
            and x.deleted_at is null and x.author_id is distinct from p_uid
            and (x.thread_root_id is null or x.seq>dek.thread_read_seq(p_uid,x.thread_root_id))
          offset 0
        ) m
        where mn.user_id=p_uid and mn.channel_id=cm.channel_id and mn.seq>cm.last_read_seq
        order by mn.seq limit 100
      ) direct limit 100)
      union
      (select broadcast.id from eligible cm cross join lateral (
        select m.id from dek.messages m where m.channel_id=cm.channel_id and m.seq>cm.last_read_seq
          and m.mention_all and m.deleted_at is null and m.author_id is distinct from p_uid
          and (m.thread_root_id is null or m.seq>dek.thread_read_seq(p_uid,m.thread_root_id))
        order by m.seq limit 100
      ) broadcast limit 100)
    ) candidates limit 100
  ) unread
$$;
