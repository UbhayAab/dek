-- 0909: no direct Storage reads of media at all. Owner: lead.
--
-- 0907 kept one read path: the uploader of a still-pending object. Nothing uses it (the
-- client uploads with INSERT only, media-finalize reads as the service role, previews
-- come from local files) and the media design says a pending file has no URL for anyone,
-- not even its uploader (media-live test). Every read now goes through media-sign: a
-- 15 minute link after dek.can_read_object_as. Without a select policy the API roles
-- simply see no media objects.

drop policy if exists dek_media_read on storage.objects;
