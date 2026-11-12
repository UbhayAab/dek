-- Host interfaces for an owned, network-isolated ordinary PostgreSQL17 cluster.
-- All Dek business SQL, RLS, grants and APIs load from the real migrations.
-- These adapters do not claim hosted Auth, Realtime, Storage, cron or provider delivery.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth;
create table auth.users(
 instance_id uuid,id uuid primary key,aud text,role text,email text,encrypted_password text,
 email_confirmed_at timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb,
 created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
);
-- Use the same JWT sub conversion as the hosted auth.uid() interface.
create function auth.uid() returns uuid language sql stable as $$
 select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create schema realtime;
create table realtime.messages(
 id uuid not null,topic text not null,extension text not null,event text,payload jsonb,private boolean,
 inserted_at timestamp without time zone not null default timezone('utc',now()),
 primary key(id,inserted_at)
) partition by range(inserted_at);
do $$ declare day text:=to_char(current_date,'YYYY_MM_DD');begin
 execute format('create table realtime.messages_%s partition of realtime.messages for values from (%L) to (%L)',
  day,current_date::timestamp,(current_date+1)::timestamp);
end $$;
create table realtime.messages_other partition of realtime.messages default;
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
grant usage on schema realtime to authenticated,service_role;
grant select,insert on realtime.messages to authenticated;
grant execute on function realtime.topic() to authenticated;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,
 owner_id text,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),last_accessed_at timestamptz);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
 select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]
$$;
grant usage on schema storage to authenticated,service_role;
grant select,insert,update,delete on storage.objects to authenticated;
grant execute on function storage.foldername(text) to authenticated;
create schema vault;
create table vault.decrypted_secrets(id uuid,name text,decrypted_secret text);
create schema net;
create table net.http_request_queue(id bigint generated always as identity primary key,url text,body jsonb,headers jsonb);
create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,
 headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$
declare result bigint;begin
 insert into net.http_request_queue(url,body,headers) values(url,body,headers) returning id into result;
 return result;
end $$;
create schema cron;
create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default false);
create table cron.job_run_details(end_time timestamptz);
create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$
declare result bigint;begin
 insert into cron.job(jobname,schedule,command,active)values(job_name,schedule,command,false)
 on conflict(jobname)do update set schedule=excluded.schedule,command=excluded.command,active=false
 returning jobid into result;return result;
end $$;
create function cron.alter_job(job_id bigint,command text) returns void language sql as $$
 update cron.job set command=$2,active=false where jobid=$1
$$;
