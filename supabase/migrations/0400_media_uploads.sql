-- 0400: media uploads. Owner: [media]. docs/CONTRACT.md sections 2.7 and 4,
-- docs/ARCHITECTURE.md section 8, PRD DEK10, DEK11, DEKA05, DEKA11.
--
-- The flow:
--   1. api.begin_upload authorises (post permission), checks the allow-list and the
--      size limit, and reserves media/<org>/<channel>/<attachment>/<safe name> (and
--      thumb.webp next to it) as a `pending` attachment row.
--   2. The browser uploads straight to Storage. The insert policy (dek.can_write_object)
--      admits only the reserver, only while the row is pending, only those two paths.
--   3. The media-finalize Edge Function reads the real bytes and calls
--      api.svc_finalize_upload, which marks the row `ready` or `rejected`.
--   4. Pending and rejected objects are never readable: dek.can_read_object needs
--      `ready` and a readable channel, so a signed URL cannot be minted for them.
--   5. Once a day dek.media_purge_tick hands deleted and rejected objects to
--      media-finalize for removal from Storage (SQL cannot delete Storage bytes).
--
-- Re-runnable: create or replace everywhere, drop before a signature change.

-- =====================================================================
-- 1. Allow-list, names, limits (private helpers)
-- =====================================================================

-- One spelling per type: lower case, parameters dropped, common aliases folded.
create or replace function dek.media_canonical_mime(p_mime text)
returns text language sql immutable set search_path = '' as $$
  select case m
    when 'image/jpg' then 'image/jpeg'
    when 'image/pjpeg' then 'image/jpeg'
    when 'image/x-png' then 'image/png'
    when 'image/heic-sequence' then 'image/heic'
    when 'image/heif-sequence' then 'image/heif'
    when 'video/x-m4v' then 'video/mp4'
    when 'audio/mp3' then 'audio/mpeg'
    when 'audio/x-mp3' then 'audio/mpeg'
    when 'audio/mpeg3' then 'audio/mpeg'
    when 'audio/x-mpeg' then 'audio/mpeg'
    when 'audio/mpg' then 'audio/mpeg'
    when 'audio/x-m4a' then 'audio/mp4'
    when 'audio/m4a' then 'audio/mp4'
    when 'audio/x-mp4' then 'audio/mp4'
    when 'audio/x-wav' then 'audio/wav'
    when 'audio/wave' then 'audio/wav'
    when 'audio/vnd.wave' then 'audio/wav'
    when 'audio/x-pn-wav' then 'audio/wav'
    when 'audio/x-aac' then 'audio/aac'
    when 'audio/aacp' then 'audio/aac'
    when 'application/x-pdf' then 'application/pdf'
    when 'text/x-csv' then 'text/csv'
    when 'application/csv' then 'text/csv'
    when 'text/comma-separated-values' then 'text/csv'
    when 'application/x-zip-compressed' then 'application/zip'
    when 'application/x-zip' then 'application/zip'
    when 'multipart/x-zip' then 'application/zip'
    else m end
  from (select lower(btrim(split_part(coalesce(p_mime, ''), ';', 1))) as m) x
$$;

-- The allow-list (CONTRACT 2.7). null = not allowed.
create or replace function dek.media_family(p_mime text)
returns text language sql immutable set search_path = '' as $$
  select case dek.media_canonical_mime(p_mime)
    when 'image/jpeg' then 'image'
    when 'image/png' then 'image'
    when 'image/gif' then 'image'
    when 'image/webp' then 'image'
    when 'image/heic' then 'image'
    when 'image/heif' then 'image'
    when 'image/avif' then 'image'
    when 'video/mp4' then 'video'
    when 'video/webm' then 'video'
    when 'video/quicktime' then 'video'
    when 'audio/mpeg' then 'audio'
    when 'audio/mp4' then 'audio'
    when 'audio/ogg' then 'audio'
    when 'audio/webm' then 'audio'
    when 'audio/wav' then 'audio'
    when 'audio/aac' then 'audio'
    when 'application/pdf' then 'pdf'
    when 'text/plain' then 'text'
    when 'text/csv' then 'text'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'office'
    when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then 'office'
    when 'application/vnd.openxmlformats-officedocument.presentationml.presentation' then 'office'
    when 'application/msword' then 'office'
    when 'application/vnd.ms-excel' then 'office'
    when 'application/vnd.ms-powerpoint' then 'office'
    when 'application/vnd.oasis.opendocument.text' then 'office'
    when 'application/vnd.oasis.opendocument.spreadsheet' then 'office'
    when 'application/vnd.oasis.opendocument.presentation' then 'office'
    when 'application/zip' then 'archive'
    else null end
$$;

-- 100 MB for video, 25 MB for everything else.
create or replace function dek.media_max_bytes(p_family text)
returns bigint language sql immutable set search_path = '' as $$
  select case when p_family = 'video' then 104857600::bigint else 26214400::bigint end
$$;

-- Used only when the browser could not name the type (empty or octet-stream).
create or replace function dek.media_mime_for_ext(p_ext text)
returns text language sql immutable set search_path = '' as $$
  select case lower(coalesce(p_ext, ''))
    when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg' when 'jfif' then 'image/jpeg'
    when 'png' then 'image/png' when 'gif' then 'image/gif' when 'webp' then 'image/webp'
    when 'heic' then 'image/heic' when 'heif' then 'image/heif' when 'avif' then 'image/avif'
    when 'mp4' then 'video/mp4' when 'm4v' then 'video/mp4' when 'webm' then 'video/webm'
    when 'mov' then 'video/quicktime'
    when 'mp3' then 'audio/mpeg' when 'm4a' then 'audio/mp4' when 'ogg' then 'audio/ogg'
    when 'oga' then 'audio/ogg' when 'opus' then 'audio/ogg' when 'wav' then 'audio/wav'
    when 'aac' then 'audio/aac'
    when 'pdf' then 'application/pdf' when 'txt' then 'text/plain' when 'csv' then 'text/csv'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    when 'doc' then 'application/msword' when 'xls' then 'application/vnd.ms-excel'
    when 'ppt' then 'application/vnd.ms-powerpoint'
    when 'odt' then 'application/vnd.oasis.opendocument.text'
    when 'ods' then 'application/vnd.oasis.opendocument.spreadsheet'
    when 'odp' then 'application/vnd.oasis.opendocument.presentation'
    when 'zip' then 'application/zip'
    else null end
$$;

-- Programs, scripts, installers, disk images, web pages and macro documents, by the
-- file's last extension. Malware scanning is not available on this stack
-- (ARCHITECTURE 8), so these never get in at all.
create or replace function dek.media_blocked_ext(p_ext text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(coalesce(p_ext, '')) = any (array[
    'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'scr', 'pif', 'cpl', 'msc', 'sys', 'drv', 'ocx',
    'jar', 'class', 'js', 'jse', 'mjs', 'cjs', 'vbs', 'vbe', 'vb', 'wsf', 'wsh', 'ws', 'wsc', 'sct',
    'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psm1', 'psd1',
    'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'command', 'tool', 'run', 'bin', 'elf', 'so', 'dylib', 'out',
    'app', 'apk', 'aab', 'xapk', 'ipa', 'xap', 'appx', 'appxbundle', 'msix', 'msixbundle',
    'dmg', 'pkg', 'mpkg', 'deb', 'rpm', 'snap', 'flatpak', 'appimage',
    'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pl', 'pm', 'rb', 'php', 'phtml', 'php3', 'php4', 'php5', 'phar',
    'asp', 'aspx', 'jsp', 'cgi', 'lua', 'tcl', 'awk',
    'html', 'htm', 'xhtml', 'shtml', 'xht', 'mht', 'mhtml', 'hta', 'svg', 'svgz', 'xsl', 'xslt',
    'lnk', 'url', 'scf', 'reg', 'inf', 'ins', 'isp', 'gadget', 'application', 'appref-ms', 'chm', 'hlp',
    'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xla', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
    'iso', 'img', 'vhd', 'vhdx', 'vmdk', 'swf', 'wasm'
  ])
$$;

create or replace function dek.media_blocked_mime(p_mime text)
returns boolean language sql immutable set search_path = '' as $$
  select m like '%macroenabled%'
      or m like '%javascript%'
      or m like '%ecmascript%'
      or m like '%shellscript%'
      or m like '%executable%'
      or m like '%msdownload%'
      or m = any (array[
        'application/x-msdos-program', 'application/x-msi', 'application/x-ms-installer',
        'application/x-dosexec', 'application/x-elf', 'application/x-mach-binary',
        'application/vnd.microsoft.portable-executable', 'application/x-sh', 'application/x-csh',
        'application/x-bat', 'application/x-msdos-batch', 'application/hta',
        'application/java-archive', 'application/x-java-archive', 'application/java-vm',
        'application/vnd.android.package-archive', 'application/x-apple-diskimage',
        'application/x-python', 'application/x-python-code', 'text/x-python', 'application/x-perl', 'text/x-perl',
        'application/x-php', 'application/x-httpd-php', 'text/x-php', 'application/x-ruby', 'text/x-ruby',
        'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/x-shockwave-flash',
        'application/wasm', 'application/x-iso9660-image', 'application/x-ms-shortcut'
      ])
  from (select lower(btrim(split_part(coalesce(p_mime, ''), ';', 1))) as m) x
$$;

-- The name people see: the original, minus control and bidirectional override
-- characters (which can make "photo<RLO>gpj.exe" display as "photoexe.jpg") and any
-- path a tool prepended. 1 to 200 characters, extension kept when trimmed.
create or replace function dek.media_display_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v     text := coalesce(p_name, '');
  v_ext text;
begin
  v := regexp_replace(v, '[\u0001-\u001f\u007f‎‏‪-‮⁦-⁩]', '', 'g');
  v := regexp_replace(v, '^.*[/\\]', '');
  -- Windows drops trailing dots and spaces when saving, so "run.bat. " lands as run.bat.
  v := regexp_replace(btrim(v), '[. ]+$', '');
  if v = '' then
    return null;
  end if;
  if char_length(v) > 200 then
    v_ext := substring(v from '(\.[A-Za-z0-9]{1,10})$');
    v := btrim(left(v, 200 - coalesce(char_length(v_ext), 0))) || coalesce(v_ext, '');
  end if;
  return v;
end $$;

-- The name inside the object path: [A-Za-z0-9._-] only, at most 120 characters, the
-- extension kept (lower case). Never "thumb.webp", which is the thumbnail's name.
create or replace function dek.media_safe_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_ext  text := lower(substring(coalesce(p_name, '') from '\.([A-Za-z0-9]{1,10})$'));
  v_base text := coalesce(p_name, '');
  v_out  text;
begin
  if v_ext is not null then
    v_base := left(v_base, char_length(v_base) - char_length(v_ext) - 1);
  end if;
  v_base := regexp_replace(v_base, '[^A-Za-z0-9._-]+', '_', 'g');
  v_base := regexp_replace(v_base, '_{2,}', '_', 'g');
  v_base := regexp_replace(v_base, '^[._-]+|[._-]+$', '', 'g');
  v_base := regexp_replace(left(v_base, 120 - coalesce(char_length(v_ext) + 1, 0)), '[._-]+$', '');
  if v_base = '' then
    v_base := 'file';
  end if;
  v_out := v_base || coalesce('.' || v_ext, '');
  if v_out = 'thumb.webp' then
    v_out := 'image.webp';
  end if;
  return v_out;
end $$;

-- The Storage object behind a path (postgres bypasses RLS on storage.objects).
create or replace function dek.media_object_meta(p_bucket text, p_name text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'size', case when (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint end,
           'mimetype', o.metadata ->> 'mimetype')
    from storage.objects o
   where o.bucket_id = p_bucket and o.name = p_name
$$;

-- =====================================================================
-- 2. api.begin_upload, api.abort_upload
-- =====================================================================

-- The per-person cap on reservations in flight (begin_upload) reads this.
create index if not exists media_attachments_pending_uploader_idx on dek.attachments (uploader_id, created_at)
  where status = 'pending';

drop function if exists api.begin_upload(uuid, text, text, bigint, boolean);
create or replace function api.begin_upload(p_channel uuid, p_file_name text, p_mime text, p_size bigint,
                                            p_with_thumb boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  c        dek.channels;
  v_name   text;
  v_ext    text;
  v_mime   text;
  v_family text;
  v_limit  bigint;
  v_id     uuid := gen_random_uuid();
  v_path   text;
  v_thumb  text;
begin
  v_uid := dek.require_uid();
  c := dek.assert_post(v_uid, p_channel);
  perform dek.rate_hit(v_uid, 'begin_upload', 60, 600);

  -- At most 20 reservations in flight per person: each may hold up to 100 MB.
  if (select count(*) from (select 1 from dek.attachments a
                             where a.uploader_id = v_uid and a.status = 'pending'
                               and a.created_at > now() - interval '2 hours' limit 20) x) >= 20 then
    perform dek.err('rate_limited', 'Finish or cancel the uploads in progress first.');
  end if;

  v_name := dek.media_display_name(p_file_name);
  if v_name is null then
    perform dek.err('invalid_input', 'p_file_name: the file needs a name.');
  end if;
  v_ext := lower(substring(v_name from '\.([A-Za-z0-9_-]{1,20})$'));
  if dek.media_blocked_ext(v_ext) or dek.media_blocked_mime(p_mime) then
    perform dek.err('invalid_input', 'p_file_name: programs, scripts and web pages cannot be shared in Dek.');
  end if;

  v_mime := dek.media_canonical_mime(p_mime);
  if v_mime in ('', 'application/octet-stream', 'binary/octet-stream') then
    v_mime := coalesce(dek.media_mime_for_ext(v_ext), v_mime);
  end if;
  -- Windows names .csv files application/vnd.ms-excel when Excel is installed.
  if v_ext = 'csv' and v_mime in ('application/vnd.ms-excel', 'text/plain') then
    v_mime := 'text/csv';
  end if;
  v_family := dek.media_family(v_mime);
  if v_family is null then
    perform dek.err('invalid_input',
      'p_mime: Dek takes photos, videos, audio, PDF, text, CSV, Office documents and zip files.');
  end if;

  v_limit := dek.media_max_bytes(v_family);
  if p_size is null or p_size < 1 then
    perform dek.err('invalid_input', 'p_size: the file is empty.');
  end if;
  if p_size > v_limit then
    perform dek.err('invalid_input', format('p_size: %s files can be up to %s MB.',
      case v_family when 'video' then 'Video' else 'These' end, v_limit / 1048576));
  end if;

  v_path := c.org_id::text || '/' || c.id::text || '/' || v_id::text || '/' || dek.media_safe_name(v_name);
  if coalesce(p_with_thumb, false) and v_family in ('image', 'video') then
    v_thumb := c.org_id::text || '/' || c.id::text || '/' || v_id::text || '/thumb.webp';
  end if;

  insert into dek.attachments (id, org_id, channel_id, uploader_id, bucket, object_path, thumb_path,
                               file_name, declared_mime, mime_type, size_bytes, status)
  values (v_id, c.org_id, c.id, v_uid, 'media', v_path, v_thumb,
          v_name, left(lower(btrim(coalesce(p_mime, ''))), 120), v_mime, p_size, 'pending');

  return jsonb_build_object(
    'attachment_id', v_id, 'bucket', 'media', 'path', v_path, 'thumb_path', v_thumb,
    'max_bytes', v_limit, 'mime', v_mime);
end $$;

drop function if exists api.abort_upload(uuid);
create or replace function api.abort_upload(p_attachment uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  a     dek.attachments;
begin
  v_uid := dek.require_uid();
  select * into a from dek.attachments where id = p_attachment for update;
  if not found or a.uploader_id is distinct from v_uid then
    perform dek.err('not_found', 'That upload does not exist.');
  end if;
  perform dek.require_org(v_uid, a.org_id);
  if a.status = 'rejected' and a.reject_reason = 'aborted' then
    return jsonb_build_object('aborted', true);
  end if;
  if a.status <> 'pending' then
    perform dek.err('conflict', 'This upload has already finished.');
  end if;
  update dek.attachments set status = 'rejected', reject_reason = 'aborted' where id = a.id;
  return jsonb_build_object('aborted', true);
end $$;

-- =====================================================================
-- 3. Service functions for media-finalize (service_role only)
-- =====================================================================

-- What media-finalize needs before it reads any bytes: the row, and the Storage
-- metadata of the object and the thumbnail. not_found unless p_user uploaded it.
drop function if exists api.svc_upload_info(uuid, uuid);
create or replace function api.svc_upload_info(p_attachment uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a dek.attachments;
begin
  select * into a from dek.attachments where id = p_attachment;
  if not found or p_user is null or a.uploader_id is distinct from p_user then
    perform dek.err('not_found', 'That upload does not exist.');
  end if;
  return jsonb_build_object(
    'id', a.id, 'org_id', a.org_id, 'channel_id', a.channel_id, 'uploader_id', a.uploader_id,
    'status', a.status, 'reject_reason', a.reject_reason, 'file_name', a.file_name,
    'declared_mime', a.declared_mime, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes,
    'bucket', a.bucket, 'object_path', a.object_path, 'thumb_path', a.thumb_path, 'created_at', a.created_at,
    'max_bytes', dek.media_max_bytes(dek.media_family(a.mime_type)),
    'object', dek.media_object_meta(a.bucket, a.object_path),
    'thumb', case when a.thumb_path is not null then dek.media_object_meta(a.bucket, a.thumb_path) end,
    'attachment', dek.attachment_json(a));
end $$;

drop function if exists api.svc_finalize_upload(uuid, boolean, text, bigint, int, int, int, text);
create or replace function api.svc_finalize_upload(p_attachment uuid, p_ok boolean, p_mime text, p_size bigint,
                                                   p_width int, p_height int, p_duration_ms int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a        dek.attachments;
  v_mime   text;
  v_family text;
  v_obj    jsonb;
  v_thumb  boolean;
begin
  select * into a from dek.attachments where id = p_attachment for update;
  if not found then
    perform dek.err('not_found', 'That upload does not exist.');
  end if;
  if a.status <> 'pending' then
    -- A retried finalize that reaches the same outcome is not an error. On a ready
    -- file it also reconciles the thumbnail: media-finalize checks the thumbnail's
    -- bytes once the file is ready (nothing can be uploaded after that) and removes
    -- a bad one, then calls again so thumb_path stops pointing at nothing.
    if a.status = 'ready' and coalesce(p_ok, false) then
      if a.thumb_path is not null and dek.media_object_meta(a.bucket, a.thumb_path) is null then
        update dek.attachments set thumb_path = null where id = a.id returning * into a;
      end if;
      return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
    end if;
    if a.status = 'rejected' and not coalesce(p_ok, false) then
      return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
    end if;
    perform dek.err('conflict', 'This upload has already been finalized.');
  end if;

  if coalesce(p_ok, false) then
    v_mime := dek.media_canonical_mime(p_mime);
    v_family := dek.media_family(v_mime);
    if v_family is null then
      perform dek.err('invalid_input', 'p_mime: not on the allow-list.');
    end if;
    if p_size is null or p_size < 1 or p_size > dek.media_max_bytes(v_family) then
      perform dek.err('invalid_input', 'p_size: outside the limit for this type.');
    end if;
    v_obj := dek.media_object_meta(a.bucket, a.object_path);
    if v_obj is null then
      perform dek.err('conflict', 'The file has not been uploaded yet.');
    end if;
    if (v_obj ->> 'size') is not null and (v_obj ->> 'size')::bigint <> p_size then
      perform dek.err('invalid_input', 'p_size: does not match the stored object.');
    end if;
    -- Storage serves the bytes with the type the upload declared: allow-listed only.
    if dek.media_family(v_obj ->> 'mimetype') is null then
      perform dek.err('invalid_input', 'p_mime: the stored object is served with a type off the allow-list.');
    end if;
    -- A thumbnail stays only if Storage holds it as an allowed image of at most 2 MB,
    -- even if it arrived after media-finalize looked.
    v_thumb := false;
    if a.thumb_path is not null then
      v_obj := dek.media_object_meta(a.bucket, a.thumb_path);
      v_thumb := v_obj is not null
             and dek.media_family(v_obj ->> 'mimetype') = 'image'
             and coalesce((v_obj ->> 'size')::bigint, 0) between 1 and 2097152;
    end if;
    update dek.attachments
       set status = 'ready', mime_type = v_mime, size_bytes = p_size,
           width = case when p_width between 1 and 100000 then p_width end,
           height = case when p_height between 1 and 100000 then p_height end,
           duration_ms = case when p_duration_ms between 0 and 86400000 then p_duration_ms end,
           thumb_path = case when v_thumb then thumb_path end,
           reject_reason = null, ready_at = now()
     where id = a.id
    returning * into a;
  else
    -- When media-finalize already removed the bytes, nothing is left for the purge.
    update dek.attachments
       set status = 'rejected',
           reject_reason = left(coalesce(nullif(btrim(p_reason), ''), 'rejected'), 300),
           purged_at = case
             when dek.media_object_meta(bucket, object_path) is null
              and (thumb_path is null or dek.media_object_meta(bucket, thumb_path) is null) then now() end
     where id = a.id
    returning * into a;
  end if;
  return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
end $$;

-- The purge loop's one call: stamp what the last batch removed, hand out the next
-- batch (oldest first, at most 100, skipping ids whose removal failed this run).
drop function if exists api.svc_media_purge(uuid[], uuid[], int);
create or replace function api.svc_media_purge(p_done uuid[] default '{}', p_failed uuid[] default '{}',
                                               p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_stamped int;
  v_items   jsonb;
begin
  update dek.attachments
     set purged_at = now()
   where id = any (coalesce(p_done, '{}'::uuid[]))
     and status in ('deleted', 'rejected') and purged_at is null;
  get diagnostics v_stamped = row_count;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'paths', to_jsonb(array_remove(array[x.object_path, x.thumb_path], null)))
           order by x.created_at), '[]'::jsonb)
    into v_items
    from (select a.id, a.object_path, a.thumb_path, a.created_at
            from dek.attachments a
           where a.status in ('deleted', 'rejected') and a.purged_at is null
             and not (a.id = any (coalesce(p_failed, '{}'::uuid[])))
             and not (a.id = any (coalesce(p_done, '{}'::uuid[])))
           order by a.created_at
           limit least(greatest(coalesce(p_limit, 100), 0), 100)) x;
  return jsonb_build_object('stamped', v_stamped, 'items', v_items);
end $$;

-- =====================================================================
-- 4. Daily purge trigger (cron)
-- =====================================================================

-- Uploads that were reserved and never sent, kept apart from migrated rows.
create index if not exists media_attachments_unsent_idx on dek.attachments (created_at)
  where status = 'ready' and message_id is null and legacy_id is null;

-- Daily. Starts with indexed existence probes, so an idle day costs three index
-- lookups. Abandoned reservations (pending a day) become rejected, files reserved and
-- never sent for 14 days become deleted, and if anything is left to remove, one
-- pg_net request (sent after commit) asks media-finalize to do it, exactly the way
-- dek.dispatch_intent reaches push-dispatch.
create or replace function dek.media_purge_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  if not exists (select 1 from dek.attachments a
                  where a.status = 'pending' and a.created_at < now() - interval '1 day')
     and not exists (select 1 from dek.attachments a
                      where a.status in ('deleted', 'rejected') and a.purged_at is null)
     and not exists (select 1 from dek.attachments a
                      where a.status = 'ready' and a.message_id is null and a.legacy_id is null
                        and a.created_at < now() - interval '14 days') then
    return;
  end if;

  update dek.attachments
     set status = 'rejected', reject_reason = 'abandoned'
   where id in (select a.id from dek.attachments a
                 where a.status = 'pending' and a.created_at < now() - interval '1 day'
                 order by a.created_at limit 5000);

  update dek.attachments
     set status = 'deleted', deleted_at = now()
   where id in (select a.id from dek.attachments a
                 where a.status = 'ready' and a.message_id is null and a.legacy_id is null
                   and a.created_at < now() - interval '14 days'
                 order by a.created_at limit 5000);

  if not exists (select 1 from dek.attachments a
                  where a.status in ('deleted', 'rejected') and a.purged_at is null) then
    return;
  end if;
  select s.value into v_url from dek.settings s where s.key = 'functions_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name = 'dek_internal_secret';
  if v_url is null or v_secret is null then
    return;   -- not configured yet; tomorrow's run tries again
  end if;
  perform net.http_post(
    url := v_url || '/media-finalize',
    body := jsonb_build_object('action', 'purge'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dek-internal', v_secret),
    timeout_milliseconds := 120000);
end $$;
-- 02:41 IST. The bound lives in the command: a function-level SET statement_timeout
-- does not bound the statement that calls the function (measured: a 1 s setting let
-- a 3 s sleep finish), while a SET earlier in the same command string does.
select cron.schedule('dek-media-purge', '11 21 * * *',
  $cmd$set statement_timeout = '60s'; select dek.media_purge_tick()$cmd$);
