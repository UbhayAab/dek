-- 0230: pins, saved messages, search and files [msg] (CONTRACT 2.2, DEK11).
-- Owner: msg builder. Re-runnable (create or replace).
--
-- Search sees only p_org, and inside it only channels the caller can read: the
-- readable set is built once per call (dek.msg_readable_channel_ids), never per row.

-- =====================================================================
-- Pins: pinned_at on the message. Channel members pin (announcement channels:
-- moderators only); at most 100 per channel.
-- =====================================================================

create or replace function api.pin_message(p_message uuid, p_pinned boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_msg dek.messages;
  v_ch  dek.channels;
begin
  v_uid := dek.require_uid();
  if p_pinned is null then
    perform dek.err('invalid_input', 'p_pinned must be true or false.');
  end if;
  v_msg := dek.msg_get(v_uid, p_message);
  select * into v_ch from dek.channels where id = v_msg.channel_id;
  if not dek.can_moderate_channel(v_uid, v_ch.id) then
    if v_ch.posting_policy = 'admins' then
      perform dek.err('forbidden', 'Only admins can pin messages in this channel.');
    end if;
    if not exists (select 1 from dek.channel_members cm where cm.channel_id = v_ch.id and cm.user_id = v_uid) then
      perform dek.err('forbidden', 'Join the channel to pin messages.');
    end if;
  end if;
  perform dek.msg_assert_open(v_uid, v_ch);
  if p_pinned then
    -- pins in one channel queue here, so two at 99 cannot both pass the cap
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pins:' || v_ch.id::text, 7314201));
  end if;

  select * into v_msg from dek.messages where id = v_msg.id for no key update;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;
  if p_pinned = (v_msg.pinned_at is not null) then
    return jsonb_build_object('message_id', v_msg.id, 'pinned', p_pinned);
  end if;
  if p_pinned then
    if (select count(*) from (select 1 from dek.messages x
                               where x.channel_id = v_ch.id and x.pinned_at is not null limit 100) n) >= 100 then
      perform dek.err('invalid_input', 'A channel can have at most 100 pinned messages. Unpin one first.');
    end if;
    update dek.messages set pinned_at = now(), pinned_by = v_uid, updated_at = now()
     where id = v_msg.id returning * into v_msg;
  else
    update dek.messages set pinned_at = null, pinned_by = null, updated_at = now()
     where id = v_msg.id returning * into v_msg;
  end if;
  perform dek.emit_channel(v_msg.channel_id, 'msg.upd', jsonb_build_object('message', dek.message_json(v_msg)));
  return jsonb_build_object('message_id', v_msg.id, 'pinned', p_pinned);
end $$;

create or replace function api.list_pins(p_channel uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_rows dek.messages[];
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  v_rows := array(
    select x from dek.messages x
     where x.channel_id = p_channel and x.pinned_at is not null and x.deleted_at is null
     order by x.pinned_at desc
     limit 100);
  return jsonb_build_object('messages', (
    select coalesce(jsonb_agg(dek.message_json(r) order by r.pinned_at desc, r.seq desc), '[]'::jsonb)
      from unnest(v_rows) r));
end $$;

-- =====================================================================
-- Saved messages (personal bookmarks). Only messages still readable come back.
-- =====================================================================

create or replace function api.save_message(p_message uuid, p_saved boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_msg dek.messages;
begin
  v_uid := dek.require_uid();
  if p_saved is null then
    perform dek.err('invalid_input', 'p_saved must be true or false.');
  end if;
  v_msg := dek.msg_get(v_uid, p_message);
  if p_saved then
    if v_msg.deleted_at is not null then
      perform dek.err('conflict', 'That message was deleted.');
    end if;
    insert into dek.saved_messages (user_id, message_id, org_id)
    values (v_uid, v_msg.id, v_msg.org_id)
    on conflict (user_id, message_id) do nothing;
  else
    delete from dek.saved_messages s where s.user_id = v_uid and s.message_id = v_msg.id;
  end if;
  return jsonb_build_object('message_id', v_msg.id, 'saved', p_saved);
end $$;

create or replace function api.list_saved(p_org uuid, p_before timestamptz default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_readable uuid[];
  v_items    jsonb;
  v_more     boolean;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  with top as (
    select s.created_at as saved_at, m as msg
      from dek.saved_messages s
      join dek.messages m on m.id = s.message_id
     where s.user_id = v_uid and s.org_id = p_org
       and s.created_at < coalesce(p_before, 'infinity'::timestamptz)
       and m.channel_id = any(v_readable) and m.deleted_at is null
     order by s.created_at desc, s.message_id desc
     limit v_limit + 1
  ), numbered as (
    select top.*, row_number() over (order by top.saved_at desc, (top.msg).id desc) as rn from top
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j
      from dek.channels c
     where c.id = any(array(select distinct (numbered.msg).channel_id from numbered where numbered.rn <= v_limit))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'message', dek.message_json(n.msg), 'channel', chans.j, 'saved_at', n.saved_at)
           order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         coalesce(max(n.rn), 0) > v_limit
    into v_items, v_more
    from numbered n left join chans on chans.id = (n.msg).channel_id;
  return jsonb_build_object('items', v_items, 'has_more', v_more);
end $$;

-- =====================================================================
-- Search (DEK11)
-- =====================================================================

-- The query as search terms. Words come from the same text search parser that
-- built search_tsv, so Hindi and other scripts keep their combining vowel signs
-- (regular expression classes would split them); only word tokens (letters and
-- digits) are kept, lower-cased by the 'simple' dictionary exactly as indexed. An
-- email, host, file name or version contributes its leading letters and digits.
-- Terms of 2+ characters match as prefixes, all terms must match (AND), at most 8.
-- NULL when nothing searchable is left. Terms are quoted, so no query text can
-- become a tsquery operator.
create or replace function dek.msg_search_tsquery(p_query text)
returns tsquery language sql stable set search_path = '' as $$
  with toks as (
    select p.tokid, p.token, row_number() over () as pos
      from pg_catalog.ts_parse('pg_catalog.default'::text, left(coalesce(p_query, ''), 200)) p
  ), terms as (
    select (pg_catalog.ts_lexize('pg_catalog.simple'::regdictionary, t.token))[1] as term, t.pos, false as part
      from toks t
     where t.tokid in (1, 2, 3, 9, 10, 11, 22)   -- words, hyphenated word parts, numbers
    union all
    select lower(substring(t.token from '^[[:alnum:]]+')), t.pos, true
      from toks t
     where t.tokid in (4, 6, 8, 19)              -- email, host, version, file
    union all
    select substring(t.token from '[0-9]+'), t.pos, true
      from toks t
     where t.tokid in (20, 21)                   -- decimals and signed numbers: leading digits
  ), picked as (
    select distinct on (terms.term) terms.term, terms.pos
      from terms
     where terms.term is not null and terms.term <> ''
       and (not terms.part or char_length(terms.term) >= 2)
     order by terms.term, terms.pos
  )
  select pg_catalog.string_agg(
           '''' || replace(replace(left(p.term, 64), '\', '\\'), '''', '''''') || ''''
             || case when char_length(p.term) >= 2 then ':*' else '' end,
           ' & ' order by p.pos)::tsquery
    from (select picked.term, picked.pos from picked order by picked.pos limit 8) p
$$;

-- Newest first. With terms: the GIN index on search_tsv. Without terms, a channel
-- or an author filter is required, and only that channel's or that author's newest
-- 5,000 messages are walked (by their own index), so a rare filter such as
-- has:link costs a bounded scan; otherwise nothing. Plans are always custom: the
-- planner sees the real terms, so a rare term never rides a generic plan that walks
-- the whole organization by date.
create or replace function api.search(
  p_org uuid, p_query text, p_channel uuid default null, p_author uuid default null,
  p_after timestamptz default null, p_before timestamptz default null, p_has text default null,
  p_limit int default 20, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_offset   int;
  v_after    timestamptz := coalesce(p_after, '-infinity'::timestamptz);
  v_before   timestamptz := coalesce(p_before, 'infinity'::timestamptz);
  v_readable uuid[];
  v_tsq      tsquery;
  v_floor    bigint;
  v_since    timestamptz;
  v_rows     dek.messages[] := '{}';
begin
  v_uid := dek.require_uid();
  perform dek.rate_hit(v_uid, 'search', 30, 60);
  perform dek.require_org(v_uid, p_org);
  if p_has is not null and p_has not in ('file', 'link', 'pin') then
    perform dek.err('invalid_input', 'p_has must be file, link or pin.');
  end if;
  v_limit := dek.msg_limit(p_limit, 20, 50);
  v_offset := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  if p_channel is not null then
    if not (p_channel = any(v_readable)) then
      perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
    end if;
    v_readable := array[p_channel];
  end if;
  v_tsq := dek.msg_search_tsquery(p_query);

  if v_tsq is not null then
    v_rows := array(
      select x from dek.messages x
       where x.search_tsv @@ v_tsq
         and x.org_id = p_org
         and x.channel_id = any(v_readable)
         and x.deleted_at is null
         and (p_author is null or x.author_id = p_author)
         and x.created_at > v_after and x.created_at < v_before
         and (p_has is null
              or (p_has = 'file' and x.attachment_count > 0)
              or (p_has = 'pin' and x.pinned_at is not null)
              or (p_has = 'link' and x.body ~* '(https?://|mailto:)'))
       order by x.created_at desc, x.id desc
       offset v_offset
       limit v_limit + 1);
  elsif p_channel is not null then
    select greatest(st.last_seq - 5000, 0) into v_floor from dek.channel_state st where st.channel_id = p_channel;
    v_rows := array(
      select x from dek.messages x
       where x.channel_id = p_channel
         and x.seq > coalesce(v_floor, 0)
         and x.deleted_at is null
         and (p_author is null or x.author_id = p_author)
         and x.created_at > v_after and x.created_at < v_before
         and (p_has is null
              or (p_has = 'file' and x.attachment_count > 0)
              or (p_has = 'pin' and x.pinned_at is not null)
              or (p_has = 'link' and x.body ~* '(https?://|mailto:)'))
       order by x.seq desc
       offset v_offset
       limit v_limit + 1);
  elsif p_author is not null then
    select m.created_at into v_since from dek.messages m
     where m.author_id = p_author order by m.created_at desc offset 4999 limit 1;
    v_rows := array(
      select x from dek.messages x
       where x.author_id = p_author
         and x.created_at >= coalesce(v_since, '-infinity'::timestamptz)
         and x.org_id = p_org
         and x.channel_id = any(v_readable)
         and x.deleted_at is null
         and x.created_at > v_after and x.created_at < v_before
         and (p_has is null
              or (p_has = 'file' and x.attachment_count > 0)
              or (p_has = 'pin' and x.pinned_at is not null)
              or (p_has = 'link' and x.body ~* '(https?://|mailto:)'))
       order by x.created_at desc
       offset v_offset
       limit v_limit + 1);
  end if;
  return jsonb_build_object(
    'items', dek.msg_items_json(v_uid, v_rows[1:v_limit]),
    'has_more', cardinality(v_rows) > v_limit);
end $$;

-- File names, newest first, only ready files attached to messages in readable
-- channels of p_org. A name query needs 3+ characters (the trigram index on
-- lower(file_name)); shorter ones find nothing. Without a query, the newest files of
-- each readable channel are merged, paged to at most offset 200.
create or replace function api.search_files(p_org uuid, p_query text default null, p_channel uuid default null,
                                            p_limit int default 30, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = ''
set plan_cache_mode = force_custom_plan as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_offset   int;
  v_readable uuid[];
  v_q        text;
  v_like     text;
  v_rows     dek.attachments[];
  v_out      jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 50);
  v_offset := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  if p_channel is not null then
    if not (p_channel = any(v_readable)) then
      perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
    end if;
    v_readable := array[p_channel];
  end if;
  v_q := left(lower(dek.msg_trim(p_query)), 100);

  if char_length(v_q) >= 3 then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_rows := array(
      select a from dek.attachments a
       where lower(a.file_name) like v_like
         and a.org_id = p_org and a.status = 'ready' and a.message_id is not null
         and a.channel_id = any(v_readable)
       order by a.created_at desc, a.id desc
       offset v_offset
       limit v_limit + 1);
  elsif v_q = '' then
    -- the newest files of each readable channel, merged (each probe is bounded)
    v_offset := least(v_offset, 200);
    v_rows := array(
      select f.a from (
        select la.a
          from unnest(v_readable) as ch(id)
          cross join lateral (
            select a from dek.attachments a
             where a.channel_id = ch.id and a.status = 'ready' and a.message_id is not null
             order by a.created_at desc
             limit v_offset + v_limit + 1) la) f
       order by (f.a).created_at desc, (f.a).id desc
       offset v_offset
       limit v_limit + 1);
  else
    v_rows := '{}';   -- one or two characters: too short to search names
  end if;

  with items as (
    select i as ord, v_rows[i] as att from generate_subscripts(v_rows, 1) i where i <= v_limit
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j
      from dek.channels c where c.id = any(array(select distinct (items.att).channel_id from items))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'attachment', dek.attachment_json(items.att),
           'message', dek.message_json(m),
           'channel', chans.j) order by items.ord), '[]'::jsonb)
    into v_out
    from items
    join dek.messages m on m.id = (items.att).message_id
    join chans on chans.id = (items.att).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;

create or replace function api.list_channel_files(p_channel uuid, p_before timestamptz default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_limit int;
  v_rows  dek.attachments[];
  v_out   jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  v_rows := array(
    select a from dek.attachments a
     where a.channel_id = p_channel and a.status = 'ready' and a.message_id is not null
       and a.created_at < coalesce(p_before, 'infinity'::timestamptz)
     order by a.created_at desc, a.id desc
     limit v_limit + 1);
  select coalesce(jsonb_agg(jsonb_build_object(
           'attachment', dek.attachment_json(r),
           'message_id', r.message_id,
           'author_id', coalesce(m.author_id, r.uploader_id),
           'created_at', r.created_at) order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_out
    from unnest(v_rows[1:v_limit]) r
    left join dek.messages m on m.id = r.message_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;
