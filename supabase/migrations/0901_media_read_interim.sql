-- 0901: interim. 0900 narrowed media reads to pending uploads ahead of the media-sign
-- function, which is not deployed yet, so ready files became unreadable. Until media-sign
-- exists and the client uses it, ready objects are readable again through the access
-- check. TODO (lead): deploy media-sign, switch the client, then re-narrow this policy.
drop policy if exists dek_media_read on storage.objects;
create policy dek_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (dek.can_read_object(name) or dek.can_write_object(name)));
