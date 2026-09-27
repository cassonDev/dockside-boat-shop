-- ===========================================================================
-- Storage bucket for job photos: work-order-photos
--
-- WHY: The app uploads every job photo (including serial-number photos and
--      document pages) to the Storage bucket 'work-order-photos'
--      (supabase-client.js: PHOTO_BUCKET). Staging never had this bucket, so
--      uploads failed with "Bucket not found". Production already has it.
--
-- WHAT IT DOES: creates the bucket as PRIVATE if it does not exist. Nothing
--   else. It never changes an existing bucket, so running it where the bucket
--   already exists (production) changes nothing.
--
-- ACCESS: controlled by the four existing storage policies
--   ("wop: select/insert/update/delete ..."), already present in staging and
--   identical to production: only active members of the shop that owns the
--   work order can read or add its photos; only owners can delete. The app
--   shows photos through short-lived signed links, never public links.
--
-- NOTE: production's bucket is currently PUBLIC (planned to become private,
--   see STORAGE-PRIVACY.md). This file does not touch it.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('work-order-photos', 'work-order-photos', false)
on conflict (id) do nothing;
