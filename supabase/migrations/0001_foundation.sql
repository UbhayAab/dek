-- 0001: Dek foundation. Owner: lead.
--
-- This is the ONLY file allowed to define tables, shared helpers, the JSON shape
-- builders, Realtime and Storage authorization, sequence allocation, and the
-- notification dispatch trigger. Builders write api.* functions in their own
-- migration ranges (docs/CONTRACT.md section 2) and call these helpers. If a builder
-- needs a change here, the lead makes it in a new 09xx migration; nobody else
-- re-creates a function defined in this file (the Arc 2026-09-15 lesson).
--
-- Rules every function below follows: security definer, search_path = '', every
-- name schema-qualified, errors raised through dek.err() with a machine code.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists dek;
create schema if not exists api;
revoke all on schema dek from public;
revoke all on schema api from public;
-- authenticated needs USAGE on dek only so Storage and Realtime policies can call
-- the three policy helpers; dek_meta.lockdown() grants EXECUTE on exactly those.
grant usage on schema dek to authenticated;
grant usage on schema api to anon, authenticated, service_role;

-- =====================================================================
-- 1. Tables
-- =====================================================================

-- Identity. profiles.id equals auth.users.id but has no foreign key: deleting an
-- auth user must leave authorship intact ("Deleted user"), so profiles are
-- anonymised, never deleted.
create table dek.profiles (
  id             uuid primary key,
  display_name   text not null check (char_length(display_name) between 1 and 80),
  handle         text check (handle ~ '^[a-z0-9][a-z0-9._-]{1,30}$'),
  avatar_path    text check (char_length(avatar_path) <= 300),
  title          text check (char_length(title) <= 80),
  timezone       text not null default 'Asia/Kolkata' check (char_length(timezone) <= 64),
  status_text    text check (char_length(status_text) <= 100),
  status_emoji   text check (char_length(status_emoji) <= 64),
  status_until   timestamptz,
  last_active_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  legacy_id      uuid
);
create unique index profiles_handle_uidx on dek.profiles (lower(handle)) where handle is not null;

create table dek.platform_admins (
  user_id    uuid primary key references dek.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table dek.orgs (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null check (char_length(name) between 1 and 80),
  short_name  text check (char_length(short_name) <= 24),
  brand_color text not null default '#4F46E5' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_path   text check (char_length(logo_path) <= 300),
  settings    jsonb not null default '{}',
  created_by  uuid references dek.profiles(id),
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  legacy_id   uuid unique
);
create unique index orgs_slug_uidx on dek.orgs (lower(slug));

create table dek.org_members (
  org_id           uuid not null references dek.orgs(id) on delete cascade,
  user_id          uuid not null references dek.profiles(id) on delete cascade,
  role             text not null default 'member' check (role in ('owner', 'admin', 'member', 'guest')),
  status           text not null default 'active' check (status in ('active', 'suspended')),
  joined_at        timestamptz not null default now(),
  invited_by       uuid references dek.profiles(id),
  suspended_at     timestamptz,
  suspended_reason text check (char_length(suspended_reason) <= 500),
  primary key (org_id, user_id)
);
create index org_members_user_idx on dek.org_members (user_id);

create table dek.org_bans (
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  reason     text check (char_length(reason) <= 500),
  banned_by  uuid references dek.profiles(id),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table dek.servers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references dek.orgs(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 1000),
  icon_emoji  text check (char_length(icon_emoji) <= 64),
  position    int not null default 0,
  join_policy text not null default 'invite' check (join_policy in ('open', 'approval', 'invite')),
  created_by  uuid references dek.profiles(id),
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references dek.profiles(id),
  legacy_id   uuid unique
);
create index servers_org_idx on dek.servers (org_id, position);
create unique index servers_name_uidx on dek.servers (org_id, lower(name)) where archived_at is null;

create table dek.server_members (
  server_id uuid not null references dek.servers(id) on delete cascade,
  user_id   uuid not null references dek.profiles(id) on delete cascade,
  org_id    uuid not null references dek.orgs(id) on delete cascade,
  role      text not null default 'member' check (role in ('admin', 'moderator', 'member')),
  joined_at timestamptz not null default now(),
  added_by  uuid references dek.profiles(id),
  primary key (server_id, user_id)
);
create index server_members_user_idx on dek.server_members (user_id, org_id);

create table dek.channels (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references dek.orgs(id) on delete cascade,
  server_id       uuid references dek.servers(id) on delete cascade,
  kind            text not null check (kind in ('text', 'audio', 'dm', 'group_dm')),
  name            text check (char_length(name) between 1 and 80),
  topic           text check (char_length(topic) <= 250),
  description     text check (char_length(description) <= 1000),
  visibility      text not null default 'public' check (visibility in ('public', 'private')),
  posting_policy  text not null default 'everyone' check (posting_policy in ('everyone', 'admins')),
  allow_replies   boolean not null default true,
  allow_reactions boolean not null default true,
  auto_join       boolean not null default false,
  position        int not null default 0,
  category        text check (char_length(category) <= 40),
  dm_key          text,
  created_by      uuid references dek.profiles(id),
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  archived_by     uuid references dek.profiles(id),
  legacy_id       uuid unique,
  check ((kind in ('dm', 'group_dm')) = (server_id is null)),
  check (kind not in ('dm', 'group_dm') or visibility = 'private'),
  check (kind in ('dm', 'group_dm') or name is not null)
);
create unique index channels_dm_key_uidx on dek.channels (dm_key) where dm_key is not null;
create index channels_server_idx on dek.channels (server_id, position) where server_id is not null;
create index channels_org_idx on dek.channels (org_id);
create unique index channels_name_uidx on dek.channels (server_id, lower(name))
  where server_id is not null and archived_at is null;

-- The hot counter row, kept apart from channels so the per-message UPDATE never
-- rewrites (or locks) the row every access check reads.
create table dek.channel_state (
  channel_id      uuid primary key references dek.channels(id) on delete cascade,
  last_seq        bigint not null default 0,
  last_top_seq    bigint not null default 0,
  last_message_at timestamptz
);

create table dek.channel_members (
  channel_id    uuid not null references dek.channels(id) on delete cascade,
  user_id       uuid not null references dek.profiles(id) on delete cascade,
  org_id        uuid not null references dek.orgs(id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'member')),
  added_by      uuid references dek.profiles(id),
  joined_at     timestamptz not null default now(),
  last_read_seq bigint not null default 0,
  last_read_at  timestamptz,
  notify        text not null default 'default' check (notify in ('default', 'all', 'mentions', 'none')),
  muted_until   timestamptz,
  hidden        boolean not null default false,
  primary key (channel_id, user_id)
);
create index channel_members_user_idx on dek.channel_members (user_id, org_id);

create table dek.messages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references dek.orgs(id) on delete cascade,
  channel_id       uuid not null references dek.channels(id) on delete cascade,
  seq              bigint not null,
  thread_root_id   uuid references dek.messages(id) on delete cascade,
  in_timeline      boolean not null default true,
  also_in_channel  boolean not null default false,
  author_id        uuid references dek.profiles(id),
  kind             text not null default 'user' check (kind in ('user', 'system')),
  body             text not null default '' check (char_length(body) <= 8000),
  mentions         uuid[] not null default '{}',
  mention_all      boolean not null default false,
  client_id        uuid,
  created_at       timestamptz not null default now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,
  deleted_by       uuid references dek.profiles(id),
  updated_at       timestamptz not null default now(),
  reply_count      int not null default 0,
  last_reply_at    timestamptz,
  reply_user_ids   uuid[] not null default '{}',
  reactions        jsonb not null default '{}',
  attachment_count int not null default 0,
  pinned_at        timestamptz,
  pinned_by        uuid references dek.profiles(id),
  meta             jsonb not null default '{}',
  legacy_id        uuid unique,
  search_tsv       tsvector generated always as (
                     to_tsvector('simple'::regconfig, case when deleted_at is null then body else '' end)
                   ) stored,
  unique (channel_id, seq),
  check (thread_root_id is not null or not also_in_channel),
  check (in_timeline = (thread_root_id is null or also_in_channel))
);
create unique index messages_client_uidx on dek.messages (author_id, client_id) where client_id is not null;
create index messages_timeline_idx on dek.messages (channel_id, seq) where in_timeline;
create index messages_thread_idx on dek.messages (thread_root_id, seq) where thread_root_id is not null;
create index messages_changed_idx on dek.messages (channel_id, updated_at);
create index messages_search_idx on dek.messages using gin (search_tsv);
create index messages_author_idx on dek.messages (author_id, created_at desc);
create index messages_mention_all_idx on dek.messages (channel_id, seq) where mention_all;
create index messages_pins_idx on dek.messages (channel_id, pinned_at desc) where pinned_at is not null;
create index messages_org_created_idx on dek.messages (org_id, created_at desc);

create table dek.reactions (
  message_id uuid not null references dek.messages(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 64),
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  channel_id uuid not null references dek.channels(id) on delete cascade,
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, emoji, user_id)
);
create index reactions_user_idx on dek.reactions (user_id);

create table dek.mentions (
  message_id uuid not null references dek.messages(id) on delete cascade,
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  channel_id uuid not null references dek.channels(id) on delete cascade,
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  seq        bigint not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index mentions_user_idx on dek.mentions (user_id, org_id, created_at desc);
create index mentions_channel_idx on dek.mentions (user_id, channel_id, seq);

create table dek.thread_follows (
  root_id             uuid not null references dek.messages(id) on delete cascade,
  user_id             uuid not null references dek.profiles(id) on delete cascade,
  channel_id          uuid not null references dek.channels(id) on delete cascade,
  org_id              uuid not null references dek.orgs(id) on delete cascade,
  following           boolean not null default true,
  last_read_reply_seq bigint not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (root_id, user_id)
);
create index thread_follows_user_idx on dek.thread_follows (user_id, org_id) where following;

create table dek.saved_messages (
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  message_id uuid not null references dek.messages(id) on delete cascade,
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index saved_messages_user_idx on dek.saved_messages (user_id, org_id, created_at desc);

create table dek.attachments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references dek.orgs(id) on delete cascade,
  channel_id    uuid not null references dek.channels(id) on delete cascade,
  message_id    uuid references dek.messages(id) on delete set null,
  uploader_id   uuid references dek.profiles(id),
  bucket        text not null default 'media',
  object_path   text not null unique,
  thumb_path    text unique,
  file_name     text not null check (char_length(file_name) between 1 and 200),
  declared_mime text not null check (char_length(declared_mime) <= 120),
  mime_type     text not null check (char_length(mime_type) <= 120),
  size_bytes    bigint not null check (size_bytes >= 0),
  width         int,
  height        int,
  duration_ms   int,
  status        text not null default 'pending' check (status in ('pending', 'ready', 'rejected', 'deleted')),
  reject_reason text,
  created_at    timestamptz not null default now(),
  ready_at      timestamptz,
  deleted_at    timestamptz,
  purged_at     timestamptz,
  legacy_id     uuid unique
);
create index attachments_message_idx on dek.attachments (message_id) where message_id is not null;
create index attachments_channel_idx on dek.attachments (channel_id, created_at desc) where status = 'ready';
create index attachments_name_trgm_idx on dek.attachments using gin (lower(file_name) extensions.gin_trgm_ops);
create index attachments_pending_idx on dek.attachments (created_at) where status = 'pending';
create index attachments_purge_idx on dek.attachments (created_at)
  where status in ('deleted', 'rejected') and purged_at is null;

create table dek.invites (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references dek.orgs(id) on delete cascade,
  server_id         uuid references dek.servers(id) on delete cascade,
  channel_ids       uuid[] not null default '{}',
  role              text not null default 'member' check (role in ('member', 'guest')),
  -- Lookup is by sha256(code). `code` is kept for invites made here so admins can copy
  -- the link again; migrated legacy invites only ever stored the hash (legacy links
  -- keep working because the hash is all a lookup needs).
  code              text unique check (code ~ '^[A-Za-z0-9]{16,40}$'),
  code_sha256       bytea not null unique,
  email             text check (char_length(email) <= 254),
  requires_approval boolean not null default false,
  created_by        uuid references dek.profiles(id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  max_uses          int check (max_uses is null or max_uses > 0),
  use_count         int not null default 0,
  revoked_at        timestamptz,
  revoked_by        uuid references dek.profiles(id),
  legacy_id         uuid unique
);
create index invites_org_idx on dek.invites (org_id, created_at desc);

create table dek.invite_uses (
  invite_id uuid not null references dek.invites(id) on delete cascade,
  user_id   uuid not null references dek.profiles(id) on delete cascade,
  used_at   timestamptz not null default now(),
  primary key (invite_id, user_id)
);

create table dek.join_requests (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  server_id  uuid references dek.servers(id) on delete cascade,
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  invite_id  uuid references dek.invites(id) on delete set null,
  note       text check (char_length(note) <= 500),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by uuid references dek.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index join_requests_pending_uidx on dek.join_requests
  (org_id, coalesce(server_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id) where status = 'pending';

create table dek.reports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references dek.orgs(id) on delete cascade,
  reporter_id    uuid references dek.profiles(id),
  kind           text not null check (kind in ('message', 'user')),
  message_id     uuid references dek.messages(id) on delete set null,
  channel_id     uuid references dek.channels(id) on delete set null,
  target_user_id uuid references dek.profiles(id),
  reason         text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  details        text check (char_length(details) <= 2000),
  status         text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolved_by    uuid references dek.profiles(id),
  resolved_at    timestamptz,
  resolution     text check (char_length(resolution) <= 1000),
  created_at     timestamptz not null default now()
);
create index reports_org_idx on dek.reports (org_id, status, created_at desc);

create table dek.user_blocks (
  blocker_id uuid not null references dek.profiles(id) on delete cascade,
  blocked_id uuid not null references dek.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on dek.user_blocks (blocked_id);

create table dek.audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid references dek.orgs(id) on delete cascade,
  actor_id    uuid references dek.profiles(id),
  action      text not null,
  target_type text,
  target_id   uuid,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index audit_log_org_idx on dek.audit_log (org_id, created_at desc);

create table dek.notification_prefs (
  user_id        uuid primary key references dek.profiles(id) on delete cascade,
  default_level  text not null default 'mentions' check (default_level in ('all', 'mentions', 'none')),
  dm_level       text not null default 'all' check (dm_level in ('all', 'none')),
  thread_replies boolean not null default true,
  quiet_start    time,
  quiet_end      time,
  quiet_tz       text not null default 'Asia/Kolkata' check (char_length(quiet_tz) <= 64),
  preview        text not null default 'full' check (preview in ('full', 'name_only', 'none')),
  updated_at     timestamptz not null default now()
);

create table dek.push_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references dek.profiles(id) on delete cascade,
  kind            text not null check (kind in ('webpush', 'fcm', 'apns')),
  endpoint        text not null check (char_length(endpoint) <= 2000),
  p256dh          text check (char_length(p256dh) <= 200),
  auth            text check (char_length(auth) <= 100),
  label           text check (char_length(label) <= 80),
  platform        text check (char_length(platform) <= 40),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status     text check (char_length(last_status) <= 200),
  failure_count   int not null default 0,
  enabled         boolean not null default true,
  revoked_at      timestamptz,
  unique (kind, endpoint)
);
create index push_devices_user_idx on dek.push_devices (user_id) where revoked_at is null and enabled;

create table dek.calls (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  channel_id uuid not null references dek.channels(id) on delete cascade,
  kind       text not null check (kind in ('direct', 'room')),
  media      text not null default 'audio' check (media in ('audio', 'video')),
  started_by uuid references dek.profiles(id),
  created_at timestamptz not null default now(),
  ended_at   timestamptz,
  end_reason text check (char_length(end_reason) <= 40)
);
create unique index calls_one_active_uidx on dek.calls (channel_id) where ended_at is null;

create table dek.call_participants (
  call_id           uuid not null references dek.calls(id) on delete cascade,
  user_id           uuid not null references dek.profiles(id) on delete cascade,
  session_id        uuid,
  state             text not null check (state in ('ringing', 'joined', 'left', 'declined', 'missed')),
  joined_at         timestamptz,
  left_at           timestamptz,
  last_heartbeat_at timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (call_id, user_id)
);
create index call_participants_user_idx on dek.call_participants (user_id) where state in ('ringing', 'joined');

create table dek.notification_intents (
  id               bigint generated always as identity primary key,
  org_id           uuid references dek.orgs(id) on delete cascade,
  kind             text not null check (kind in ('message', 'call', 'test')),
  message_id       uuid references dek.messages(id) on delete cascade,
  channel_id       uuid references dek.channels(id) on delete cascade,
  call_id          uuid references dek.calls(id) on delete cascade,
  actor_id         uuid references dek.profiles(id),
  target_user_id   uuid references dek.profiles(id),
  target_device_id uuid references dek.push_devices(id) on delete set null,
  status           text not null default 'pending'
                     check (status in ('pending', 'processing', 'done', 'failed', 'expired')),
  attempts         int not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz,
  last_error       text
);
create index notification_intents_open_idx on dek.notification_intents (created_at)
  where status in ('pending', 'processing');
create index notification_intents_done_idx on dek.notification_intents (created_at)
  where status in ('done', 'failed', 'expired');

create table dek.notification_deliveries (
  id          bigint generated always as identity primary key,
  intent_id   bigint not null references dek.notification_intents(id) on delete cascade,
  user_id     uuid not null references dek.profiles(id) on delete cascade,
  device_id   uuid references dek.push_devices(id) on delete set null,
  kind        text check (kind in ('webpush', 'fcm', 'apns')),
  status      text not null check (status in ('sent', 'failed', 'skipped', 'expired', 'not_configured')),
  reason      text check (char_length(reason) <= 300),
  http_status int,
  created_at  timestamptz not null default now()
);
create unique index notification_deliveries_once_uidx on dek.notification_deliveries (intent_id, device_id)
  where device_id is not null;
create index notification_deliveries_user_idx on dek.notification_deliveries (user_id, created_at desc);
create index notification_deliveries_created_idx on dek.notification_deliveries (created_at);

-- Fixed-window counters. UNLOGGED: a crash forgets a minute of rate history,
-- which is harmless, and every hit skips the WAL.
create unlogged table dek.rate_buckets (
  user_id      uuid not null,
  key          text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (user_id, key, window_start)
);

create table dek.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Every dek table: RLS on, no policies. Only security definer functions owned by
-- the table owner (which bypasses RLS) can touch them. A second wall behind the
-- grants lockdown.
do $$
declare r record;
begin
  for r in select c.oid::regclass as rel
             from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'dek' and c.relkind = 'r'
  loop
    execute format('alter table %s enable row level security', r.rel);
  end loop;
end $$;

-- =====================================================================
-- 2. Errors, identity, rate limits, audit
-- =====================================================================

create or replace function dek.err(p_code text, p_hint text default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, hint = coalesce(p_hint, p_code);
end $$;

create or replace function dek.require_uid()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    perform dek.err('auth_required', 'Sign in to continue.');
  end if;
  if exists (select 1 from dek.profiles p where p.id = v and p.deleted_at is not null) then
    perform dek.err('auth_required', 'This account has been deleted.');
  end if;
  return v;
end $$;

-- Throttled "last active" stamp: at most one write per user per 4 minutes. This is
-- the whole presence system (DEK12): no Realtime Presence, which is billed once per
-- recipient, and nothing that can stay "online" after the person leaves.
create or replace function dek.touch_active(p_uid uuid)
returns void language sql security definer set search_path = '' as $$
  update dek.profiles set last_active_at = now()
   where id = p_uid and (last_active_at is null or last_active_at < now() - interval '4 minutes')
$$;

create or replace function dek.is_platform_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from dek.platform_admins a where a.user_id = p_uid)
$$;

create or replace function dek.rate_hit(p_uid uuid, p_key text, p_limit int, p_window_seconds int)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits  int;
begin
  insert into dek.rate_buckets as b (user_id, key, window_start, hits)
  values (p_uid, p_key, v_start, 1)
  on conflict (user_id, key, window_start) do update set hits = b.hits + 1
  returning b.hits into v_hits;
  if v_hits > p_limit then
    perform dek.err('rate_limited', format('Slow down a little. Try again in %s seconds.',
      greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::int)));
  end if;
end $$;

create or replace function dek.audit(p_org uuid, p_action text, p_target_type text, p_target_id uuid,
                                     p_details jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into dek.audit_log (org_id, actor_id, action, target_type, target_id, details)
  values (p_org, auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_details, '{}'::jsonb))
$$;

-- =====================================================================
-- 3. Access rules. Every api function goes through these.
-- =====================================================================

create or replace function dek.org_role(p_uid uuid, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from dek.org_members m
   where m.org_id = p_org and m.user_id = p_uid and m.status = 'active'
$$;

create or replace function dek.is_org_admin(p_uid uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(dek.org_role(p_uid, p_org) in ('owner', 'admin'), false)
$$;

-- Raises not_found for strangers (existence never leaks across tenants) and
-- suspended for suspended members. Returns the caller's org role.
create or replace function dek.require_org(p_uid uuid, p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text; v_status text;
begin
  select m.role, m.status into v_role, v_status
    from dek.org_members m where m.org_id = p_org and m.user_id = p_uid;
  if v_role is null then
    perform dek.err('not_found', 'That organization does not exist or you are not a member of it.');
  end if;
  if v_status <> 'active' then
    perform dek.err('suspended', 'Your membership in this organization is suspended.');
  end if;
  return v_role;
end $$;

create or replace function dek.require_org_admin(p_uid uuid, p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text := dek.require_org(p_uid, p_org);
begin
  if v_role not in ('owner', 'admin') then
    perform dek.err('forbidden', 'Only organization admins can do that.');
  end if;
  return v_role;
end $$;

create or replace function dek.shares_org(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_a = p_b or exists (
    select 1 from dek.org_members x
      join dek.org_members y on y.org_id = x.org_id and y.user_id = p_b and y.status = 'active'
     where x.user_id = p_a and x.status = 'active')
$$;

create or replace function dek.server_role(p_uid uuid, p_server uuid)
returns text language sql stable security definer set search_path = '' as $$
  select sm.role
    from dek.server_members sm
    join dek.org_members om on om.org_id = sm.org_id and om.user_id = sm.user_id and om.status = 'active'
   where sm.server_id = p_server and sm.user_id = p_uid
$$;

create or replace function dek.is_server_member(p_uid uuid, p_server uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select dek.server_role(p_uid, p_server) is not null
$$;

-- Server admin: server role admin, or an admin of the server's org.
create or replace function dek.is_server_admin(p_uid uuid, p_server uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(dek.server_role(p_uid, p_server) = 'admin', false)
      or exists (select 1 from dek.servers s where s.id = p_server and dek.is_org_admin(p_uid, s.org_id))
$$;

create or replace function dek.is_server_mod(p_uid uuid, p_server uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(dek.server_role(p_uid, p_server) in ('admin', 'moderator'), false)
      or exists (select 1 from dek.servers s where s.id = p_server and dek.is_org_admin(p_uid, s.org_id))
$$;

-- THE read rule (DEK02, DEK11): active org member, and either an explicit channel
-- member, or a public server channel in a server the caller belongs to (guests
-- never see public channels they were not added to).
create or replace function dek.can_read_channel(p_uid uuid, p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from dek.channels c
      join dek.org_members om on om.org_id = c.org_id and om.user_id = p_uid and om.status = 'active'
     where c.id = p_channel
       and (
         exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = p_uid)
         or (c.visibility = 'public' and c.server_id is not null and om.role <> 'guest'
             and exists (select 1 from dek.server_members sm
                          where sm.server_id = c.server_id and sm.user_id = p_uid))
       )
  )
$$;

-- Moderators of a channel: org admins, server admins and moderators of its server,
-- and the channel's owner. For DMs, org admins only (acting on reports).
create or replace function dek.can_moderate_channel(p_uid uuid, p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from dek.channels c
     where c.id = p_channel
       and dek.org_role(p_uid, c.org_id) is not null
       and (
         dek.is_org_admin(p_uid, c.org_id)
         or (c.server_id is not null and coalesce(dek.server_role(p_uid, c.server_id) in ('admin', 'moderator'), false))
         or (c.kind in ('text', 'audio') and exists (
               select 1 from dek.channel_members cm
                where cm.channel_id = c.id and cm.user_id = p_uid and cm.role = 'owner'))
       )
  )
$$;

create or replace function dek.assert_read(p_uid uuid, p_channel uuid)
returns dek.channels language plpgsql stable security definer set search_path = '' as $$
declare c dek.channels;
begin
  if p_channel is null or not dek.can_read_channel(p_uid, p_channel) then
    perform dek.err('not_found', 'That conversation does not exist or you do not have access to it.');
  end if;
  select * into c from dek.channels where id = p_channel;
  return c;
end $$;

-- Post rule: readable, not archived (channel or server), the posting policy
-- (announcement channels: moderators only, except thread replies when the channel
-- allows replies), and no block between the two people of a 1:1 DM.
create or replace function dek.assert_post(p_uid uuid, p_channel uuid, p_is_reply boolean default false)
returns dek.channels language plpgsql stable security definer set search_path = '' as $$
declare c dek.channels;
begin
  c := dek.assert_read(p_uid, p_channel);
  if c.archived_at is not null
     or exists (select 1 from dek.servers s where s.id = c.server_id and s.archived_at is not null) then
    perform dek.err('archived', 'This conversation is archived and read only.');
  end if;
  if p_is_reply and not c.allow_replies then
    perform dek.err('forbidden', 'Replies are turned off in this channel.');
  end if;
  if c.posting_policy = 'admins' and not (p_is_reply and c.allow_replies)
     and not dek.can_moderate_channel(p_uid, p_channel) then
    perform dek.err('forbidden', 'Only admins can post in this channel.');
  end if;
  if c.kind = 'dm' then
    if exists (
      select 1 from dek.channel_members cm
        join dek.user_blocks b
          on (b.blocker_id = cm.user_id and b.blocked_id = p_uid)
          or (b.blocker_id = p_uid and b.blocked_id = cm.user_id)
       where cm.channel_id = c.id and cm.user_id <> p_uid) then
      perform dek.err('blocked', 'You cannot message this person.');
    end if;
    if exists (
      select 1 from dek.channel_members cm
       where cm.channel_id = c.id and cm.user_id <> p_uid
         and dek.org_role(cm.user_id, c.org_id) is null) then
      perform dek.err('forbidden', 'This person is no longer in the organization.');
    end if;
  end if;
  return c;
end $$;

-- =====================================================================
-- 4. Realtime and Storage policy helpers (executable by authenticated)
-- =====================================================================

create or replace function dek.can_use_topic(p_topic text, p_mode text, p_extension text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_prefix text;
  v_rest   text;
  v_id     uuid;
begin
  if v_uid is null or p_topic is null or p_mode not in ('read', 'write') then
    return false;
  end if;
  v_prefix := split_part(p_topic, ':', 1);
  v_rest := substr(p_topic, char_length(v_prefix) + 2);
  if v_rest !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := v_rest::uuid;

  if v_prefix = 'u' then
    -- personal inbox: read your own, nobody sends from a client
    return p_mode = 'read' and v_id = v_uid and p_extension = 'broadcast';
  elsif v_prefix = 's' then
    -- server topic: members (never guests) receive; clients send nothing
    return p_mode = 'read' and p_extension = 'broadcast'
       and exists (select 1 from dek.servers s
                     join dek.org_members om on om.org_id = s.org_id and om.user_id = v_uid
                                            and om.status = 'active' and om.role <> 'guest'
                     join dek.server_members sm on sm.server_id = s.id and sm.user_id = v_uid
                    where s.id = v_id);
  elsif v_prefix = 't' then
    -- channel view topic: typing broadcasts between readers
    return p_extension = 'broadcast' and dek.can_read_channel(v_uid, v_id);
  elsif v_prefix = 'call' then
    -- call topic: signaling and presence between participants (and room readers)
    return p_extension in ('broadcast', 'presence')
       and exists (
         select 1 from dek.calls c
          where c.id = v_id and c.ended_at is null
            and (exists (select 1 from dek.call_participants p where p.call_id = c.id and p.user_id = v_uid)
                 or (c.kind = 'room' and dek.can_read_channel(v_uid, c.channel_id))));
  end if;
  return false;
end $$;

-- Storage paths: media/<org>/<channel>/<attachment>/<file>. A signed URL is only
-- minted when this returns true, so revoking channel access stops new URLs at once.
create or replace function dek.can_read_object(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  a       dek.attachments;
begin
  if v_uid is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into a from dek.attachments where id = v_parts[3]::uuid;
  if not found or a.status <> 'ready' then return false; end if;
  if p_name <> a.object_path and p_name is distinct from a.thumb_path then return false; end if;
  return dek.can_read_channel(v_uid, a.channel_id);
end $$;

create or replace function dek.can_write_object(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  a       dek.attachments;
begin
  if v_uid is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into a from dek.attachments where id = v_parts[3]::uuid;
  return found
     and a.status = 'pending'
     and a.uploader_id = v_uid
     and a.created_at > now() - interval '2 hours'
     and (p_name = a.object_path or p_name = a.thumb_path);
end $$;

-- =====================================================================
-- 5. JSON shape builders (docs/CONTRACT.md section 1)
-- =====================================================================

create or replace function dek.profile_json(p dek.profiles)
returns jsonb language sql stable set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'id', p.id,
    'display_name', case when p.deleted_at is null then p.display_name else 'Deleted user' end,
    'handle', case when p.deleted_at is null then p.handle end,
    'avatar_path', case when p.deleted_at is null then p.avatar_path end,
    'title', case when p.deleted_at is null then p.title end,
    'timezone', p.timezone,
    'status_text', case when p.deleted_at is null and (p.status_until is null or p.status_until > now()) then p.status_text end,
    'status_emoji', case when p.deleted_at is null and (p.status_until is null or p.status_until > now()) then p.status_emoji end,
    'status_until', case when p.status_until > now() then p.status_until end,
    'last_active_at', p.last_active_at,
    'deleted', p.deleted_at is not null) end
$$;

create or replace function dek.attachment_json(a dek.attachments)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes,
    'width', a.width, 'height', a.height, 'duration_ms', a.duration_ms,
    'path', a.object_path, 'thumb_path', a.thumb_path, 'status', a.status)
$$;

create or replace function dek.message_json(m dek.messages)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'org_id', m.org_id, 'channel_id', m.channel_id, 'seq', m.seq,
    'thread_root_id', m.thread_root_id,
    'author_id', m.author_id, 'kind', m.kind,
    'body', case when m.deleted_at is null then m.body else '' end,
    'mentions', case when m.deleted_at is null then to_jsonb(m.mentions) else '[]'::jsonb end,
    'mention_all', m.mention_all and m.deleted_at is null,
    'client_id', m.client_id,
    'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted_at', m.deleted_at,
    'updated_at', m.updated_at,
    'reply_count', m.reply_count, 'last_reply_at', m.last_reply_at,
    'reply_user_ids', to_jsonb(m.reply_user_ids),
    'reactions', case when m.deleted_at is null then m.reactions else '{}'::jsonb end,
    'attachments', case when m.attachment_count > 0 and m.deleted_at is null then coalesce((
        select jsonb_agg(dek.attachment_json(a) order by a.created_at, a.id)
          from dek.attachments a where a.message_id = m.id and a.status = 'ready'), '[]'::jsonb)
      else '[]'::jsonb end,
    'pinned', m.pinned_at is not null,
    'also_in_channel', m.also_in_channel,
    'meta', m.meta)
$$;

-- Channel fields that are the same for everyone (used in chan.upd events).
create or replace function dek.channel_public_json(c dek.channels)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'org_id', c.org_id, 'server_id', c.server_id, 'kind', c.kind,
    'name', c.name, 'topic', c.topic, 'description', c.description,
    'visibility', c.visibility, 'posting_policy', c.posting_policy,
    'allow_replies', c.allow_replies, 'allow_reactions', c.allow_reactions, 'auto_join', c.auto_join,
    'archived', c.archived_at is not null, 'position', c.position, 'category', c.category,
    'created_by', c.created_by, 'created_at', c.created_at)
$$;

-- The full per-caller Channel shape. Unread and mention counts are capped at 100
-- so a long-unread channel costs at most 100 index entries to count.
create or replace function dek.channel_json(c dek.channels, p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cm     dek.channel_members;
  st     dek.channel_state;
  v_unr  int := 0;
  v_men  int := 0;
  v_cnt  int;
  v_dm   jsonb := null;
begin
  select * into cm from dek.channel_members x where x.channel_id = c.id and x.user_id = p_uid;
  select * into st from dek.channel_state s where s.channel_id = c.id;
  if cm.user_id is not null then
    select count(*) into v_unr from (
      select 1 from dek.messages m
       where m.channel_id = c.id and m.in_timeline and m.deleted_at is null
         and m.seq > cm.last_read_seq and m.author_id is distinct from p_uid
       limit 100) u;
    select count(*) into v_men from (
      select 1 from dek.mentions mn
       where mn.user_id = p_uid and mn.channel_id = c.id and mn.seq > cm.last_read_seq
      union all
      select 1 from dek.messages m
       where m.channel_id = c.id and m.mention_all and m.deleted_at is null
         and m.seq > cm.last_read_seq and m.author_id is distinct from p_uid
      limit 100) x;
  end if;
  select count(*) into v_cnt from dek.channel_members x where x.channel_id = c.id;
  if c.kind in ('dm', 'group_dm') then
    select coalesce(jsonb_agg(x.user_id order by x.joined_at, x.user_id), '[]'::jsonb) into v_dm
      from dek.channel_members x where x.channel_id = c.id and x.user_id <> p_uid;
  end if;
  return dek.channel_public_json(c) || jsonb_build_object(
    'member', cm.user_id is not null,
    'my_role', cm.role,
    'notify', coalesce(cm.notify, 'default'),
    'muted_until', cm.muted_until,
    'hidden', coalesce(cm.hidden, false),
    'last_seq', coalesce(st.last_seq, 0),
    'last_read_seq', coalesce(cm.last_read_seq, 0),
    'unread', v_unr,
    'mentions', v_men,
    'last_message_at', st.last_message_at,
    'member_count', v_cnt,
    'dm_user_ids', v_dm);
end $$;

create or replace function dek.server_json(s dek.servers, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'org_id', s.org_id, 'name', s.name, 'description', s.description,
    'icon_emoji', s.icon_emoji, 'position', s.position, 'join_policy', s.join_policy,
    'archived', s.archived_at is not null,
    'my_role', dek.server_role(p_uid, s.id),
    'member_count', (select count(*) from dek.server_members sm where sm.server_id = s.id))
$$;

create or replace function dek.org_settings(o dek.orgs)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'edit_window_minutes', null,
    'allow_guests', true,
    'member_can_create_channels', true,
    'member_can_invite', false,
    'default_invite_hours', 168) || coalesce(o.settings, '{}'::jsonb)
$$;

create or replace function dek.org_summary_json(o dek.orgs, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'slug', o.slug, 'name', o.name, 'short_name', o.short_name,
    'brand_color', o.brand_color, 'logo_path', o.logo_path,
    'my_role', dek.org_role(p_uid, o.id),
    'unread_channels', (
      select count(*) from dek.channel_members cm
        join dek.channel_state st on st.channel_id = cm.channel_id
       where cm.user_id = p_uid and cm.org_id = o.id and not cm.hidden
         and st.last_top_seq > cm.last_read_seq and cm.notify <> 'none'),
    'mention_count', (
      select count(*) from (
        select 1 from dek.mentions mn
          join dek.channel_members cm on cm.channel_id = mn.channel_id and cm.user_id = mn.user_id
         where mn.user_id = p_uid and mn.org_id = o.id and mn.seq > cm.last_read_seq
         limit 100) x))
$$;

create or replace function dek.call_json(c dek.calls)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'org_id', c.org_id, 'channel_id', c.channel_id, 'kind', c.kind, 'media', c.media,
    'started_by', c.started_by, 'created_at', c.created_at, 'ended_at', c.ended_at, 'end_reason', c.end_reason,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', p.user_id, 'state', p.state, 'session_id', p.session_id, 'joined_at', p.joined_at)
             order by p.joined_at nulls last, p.user_id)
        from dek.call_participants p where p.call_id = c.id), '[]'::jsonb))
$$;

-- =====================================================================
-- 6. Realtime emit. Set-based, one subtransaction per call however many
--    topics: realtime.send() opens a subtransaction per topic, and a fanout of
--    hundreds of those inside one transaction overflows the subxid cache.
-- =====================================================================

create or replace function dek.emit_many(p_topics text[], p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_topics is null or cardinality(p_topics) = 0 then
    return;
  end if;
  insert into realtime.messages (id, topic, extension, event, payload, private)
  select x.id, x.topic, 'broadcast', p_event,
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('v', 1, 'id', x.id), true
    from (select gen_random_uuid() as id, t.topic
            from (select distinct u as topic from unnest(p_topics) u where u is not null) t) x;
exception when others then
  -- A broadcast must never fail the write that caused it: clients heal by cursor.
  raise warning 'dek.emit_many(% topics, %) failed: %', cardinality(p_topics), p_event, sqlerrm;
end $$;

create or replace function dek.emit_user(p_user uuid, p_event text, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  select dek.emit_many(array['u:' || p_user::text], p_event, p_payload)
$$;

create or replace function dek.emit_users(p_users uuid[], p_event text, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  select dek.emit_many(array(select 'u:' || u::text from unnest(p_users) u), p_event, p_payload)
$$;

-- Public server channels go once to s:<server> (plus u:<member> for the rare
-- channel member who is not in the server); private channels and DMs go to each
-- member's u: topic.
create or replace function dek.emit_channel(p_channel uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c        dek.channels;
  v_topics text[];
begin
  select * into c from dek.channels where id = p_channel;
  if not found then return; end if;
  if c.server_id is not null and c.visibility = 'public' then
    v_topics := array['s:' || c.server_id::text] || array(
      select 'u:' || cm.user_id::text from dek.channel_members cm
       where cm.channel_id = c.id
         and not exists (select 1 from dek.server_members sm
                          where sm.server_id = c.server_id and sm.user_id = cm.user_id));
  else
    v_topics := array(select 'u:' || cm.user_id::text from dek.channel_members cm where cm.channel_id = c.id);
  end if;
  perform dek.emit_many(v_topics, p_event, p_payload);
end $$;

-- =====================================================================
-- 7. Sequence allocation and system messages
-- =====================================================================

create or replace function dek.on_channel_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into dek.channel_state (channel_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger dek_channel_state_row after insert on dek.channels
  for each row execute function dek.on_channel_created();

-- The per-channel order. An UPDATE takes FOR NO KEY UPDATE on the channel_state
-- row: writers to the same channel queue here (gapless, ordered), writers to other
-- channels never meet, and foreign-key KEY SHARE locks from child inserts do not
-- conflict with it. Held until commit, so callers do everything else first where
-- they can.
create or replace function dek.allocate_seq(p_channel uuid, p_in_timeline boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_seq bigint;
begin
  update dek.channel_state
     set last_seq = last_seq + 1,
         last_top_seq = case when p_in_timeline then last_seq + 1 else last_top_seq end,
         last_message_at = now()
   where channel_id = p_channel
  returning last_seq into v_seq;
  if v_seq is null then
    perform dek.err('not_found', 'That conversation does not exist.');
  end if;
  return v_seq;
end $$;

-- System lines ("Call ended, 4 min"). No author, no notification.
create or replace function dek.post_system(p_channel uuid, p_body text, p_meta jsonb default '{}')
returns dek.messages language plpgsql security definer set search_path = '' as $$
declare
  c dek.channels;
  m dek.messages;
begin
  select * into c from dek.channels where id = p_channel;
  if not found then
    perform dek.err('not_found', 'That conversation does not exist.');
  end if;
  insert into dek.messages (org_id, channel_id, seq, author_id, kind, body, meta)
  values (c.org_id, c.id, dek.allocate_seq(c.id, true), null, 'system', left(p_body, 8000), coalesce(p_meta, '{}'::jsonb))
  returning * into m;
  perform dek.emit_channel(c.id, 'msg.new', jsonb_build_object('message', dek.message_json(m)));
  return m;
end $$;

-- =====================================================================
-- 8. Notification intents: outbox row, dispatched after commit by pg_net
-- =====================================================================

create or replace function dek.enqueue_intent(
  p_kind text, p_org uuid, p_message uuid default null, p_channel uuid default null,
  p_call uuid default null, p_actor uuid default null, p_target_user uuid default null,
  p_target_device uuid default null)
returns bigint language sql security definer set search_path = '' as $$
  insert into dek.notification_intents
    (kind, org_id, message_id, channel_id, call_id, actor_id, target_user_id, target_device_id)
  values (p_kind, p_org, p_message, p_channel, p_call, p_actor, p_target_user, p_target_device)
  returning id
$$;

-- net.http_post only queues a row in net.http_request_queue; the pg_net worker
-- sends it after this transaction commits, and a rollback takes it back with
-- everything else. That is the outbox guarantee (OPS12) without a polling loop.
create or replace function dek.dispatch_intent(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select s.value into v_url from dek.settings s where s.key = 'functions_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name = 'dek_internal_secret';
  if v_url is null or v_secret is null then
    return;   -- not configured yet; the sweeper retries once it is
  end if;
  perform net.http_post(
    url := v_url || '/push-dispatch',
    body := jsonb_build_object('intent_id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dek-internal', v_secret),
    timeout_milliseconds := 15000);
exception when others then
  raise warning 'dek.dispatch_intent(%) failed: %', p_id, sqlerrm;
end $$;

create or replace function dek.on_intent_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform dek.dispatch_intent(new.id);
  return new;
end $$;
create trigger dek_intent_dispatch after insert on dek.notification_intents
  for each row execute function dek.on_intent_created();

-- Every minute. The first statement is an indexed existence probe, so an idle
-- minute costs one index lookup (the 2026-09-30 lesson: periodic jobs must not do
-- work to discover there is no work).
create or replace function dek.sweep_intents()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not exists (select 1 from dek.notification_intents
                  where status in ('pending', 'processing') and created_at < now() - interval '30 seconds') then
    return;
  end if;
  -- A notification an hour late is noise, not a notification.
  update dek.notification_intents
     set status = 'expired', processed_at = now(), last_error = coalesce(last_error, 'expired after 1 hour')
   where status in ('pending', 'processing') and created_at < now() - interval '1 hour';
  update dek.notification_intents
     set status = 'failed', processed_at = now(), last_error = coalesce(last_error, 'gave up after 5 attempts')
   where status in ('pending', 'processing') and attempts >= 5;
  for r in
    select i.id from dek.notification_intents i
     where i.status in ('pending', 'processing') and i.created_at < now() - interval '30 seconds'
       and (i.locked_until is null or i.locked_until < now())
     order by i.id
     limit 100
  loop
    perform dek.dispatch_intent(r.id);
  end loop;
end $$;
alter function dek.sweep_intents() set statement_timeout = '20s';

-- Daily housekeeping, bounded.
create or replace function dek.prune()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.notification_deliveries where created_at < now() - interval '14 days';
  delete from dek.notification_intents
   where status in ('done', 'failed', 'expired') and created_at < now() - interval '7 days';
  delete from dek.rate_buckets where window_start < now() - interval '1 day';
  begin
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  exception when others then
    raise warning 'dek.prune: cron history not pruned: %', sqlerrm;
  end;
end $$;
alter function dek.prune() set statement_timeout = '120s';

-- =====================================================================
-- 9. New auth user -> profile
-- =====================================================================

create or replace function dek.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into dek.profiles (id, display_name)
  values (new.id, left(coalesce(
            nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
            nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
            'New member'), 80))
  on conflict (id) do nothing;
  insert into dek.notification_prefs (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger dek_on_auth_user_created after insert on auth.users
  for each row execute function dek.on_auth_user_created();

-- =====================================================================
-- 10. Realtime authorization (private channels)
-- =====================================================================

drop policy if exists dek_realtime_read on realtime.messages;
create policy dek_realtime_read on realtime.messages
  for select to authenticated
  using (dek.can_use_topic((select realtime.topic()), 'read', realtime.messages.extension));

drop policy if exists dek_realtime_write on realtime.messages;
create policy dek_realtime_write on realtime.messages
  for insert to authenticated
  with check (dek.can_use_topic((select realtime.topic()), 'write', realtime.messages.extension));

-- =====================================================================
-- 11. Storage
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 104857600, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
                                allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists dek_media_read on storage.objects;
create policy dek_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and dek.can_read_object(name));

drop policy if exists dek_media_upload on storage.objects;
create policy dek_media_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and dek.can_write_object(name));

drop policy if exists dek_avatar_insert on storage.objects;
create policy dek_avatar_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists dek_avatar_update on storage.objects;
create policy dek_avatar_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists dek_avatar_delete on storage.objects;
create policy dek_avatar_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- =====================================================================
-- 12. Schedules. Invariant: statement_timeout < interval, so no job can still be
--     running when its next tick fires.
-- =====================================================================

select cron.schedule('dek-sweep-intents', '* * * * *', 'select dek.sweep_intents()');
select cron.schedule('dek-prune', '47 21 * * *', 'select dek.prune()');
