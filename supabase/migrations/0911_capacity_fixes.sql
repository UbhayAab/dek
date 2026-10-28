-- 0911: two findings of the 2026-10-04 capacity audit. Owner: lead.
--
-- 1. api.update_profile locked the profile row FOR UPDATE. Every insert that references a
--    profile (a message's author, a reaction, a mention) checks that foreign key with FOR
--    KEY SHARE, which FOR UPDATE blocks: a profile save stalled that person's sends. The
--    update never changes the key, so FOR NO KEY UPDATE is enough and blocks nothing.
-- 2. Calls had no server cap outside audio rooms (join_room: 8). A group DM of 9 could put
--    9 people in one mesh call, more than the client's 7 peer connections. Now any call
--    refuses a 9th joined person: conflict, 'This call is full (8 people).' The advisory
--    lock per call makes two simultaneous joins for the last seat take turns.

do $$
declare
  d text := pg_get_functiondef('api.update_profile(jsonb)'::regprocedure);
  old_clause constant text := 'from dek.profiles where id = v_uid for update;';
begin
  if position(old_clause in d) = 0 then
    if position('for no key update' in d) > 0 then
      return;   -- already applied
    end if;
    raise exception 'api.update_profile no longer matches what 0911 expects: review by hand';
  end if;
  execute replace(d, old_clause, 'from dek.profiles where id = v_uid for no key update;');
end $$;

create or replace function dek.call_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.state = 'joined' and (tg_op = 'INSERT' or old.state is distinct from 'joined') then
    perform pg_advisory_xact_lock(hashtextextended('dek.call:' || new.call_id::text, 0));
    if (select count(*) from dek.call_participants p
         where p.call_id = new.call_id and p.state = 'joined' and p.user_id <> new.user_id) >= 8 then
      perform dek.err('conflict', 'This call is full (8 people).');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists dek_call_capacity on dek.call_participants;
create trigger dek_call_capacity before insert or update of state on dek.call_participants
  for each row execute function dek.call_capacity();
