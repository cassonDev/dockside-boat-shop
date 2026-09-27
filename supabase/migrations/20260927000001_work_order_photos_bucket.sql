-- ===========================================================================
-- Storage bucket for job photos: work-order-photos
--
-- WHY: The app uploads every job photo (including serial-number photos and
--      document pages) to the Storage bucket 'work-order-photos'
--      (supabase-client.js: PHOTO_BUCKET). Staging never had this bucket, so
--      uploads failed with "Bucket not found". Production already has it.
--
-- WHAT IT DOES: creates the bucket if it does not exist, with the SAME
--   settings as production (public, no size limit, any file type) — chosen by
--   Cassandra 2026-09-27 so staging matches production. Nothing else. It never
--   changes an existing bucket, so running it where the bucket already exists
--   (production) changes nothing.
--
-- ACCESS: controlled by the four existing storage policies
--   ("wop: select/insert/update/delete ..."), already present in staging and
--   identical to production: only active members of the shop that owns the
--   work order can read or add its photos; only owners can delete. The app
--   shows photos through short-lived signed links, never public links.
--
-- NOTE: public means anyone with a file's exact URL can open it. Both buckets
--   are planned to become private together (see STORAGE-PRIVACY.md).
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('work-order-photos', 'work-order-photos', true)
on conflict (id) do nothing;
