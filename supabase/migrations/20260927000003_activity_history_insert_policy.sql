-- Fix: editing a work log or customer update fails with
--   "new row violates row-level security policy for table activity_history".
--
-- Why: before saving an edit, the app stores the entry's previous version in
-- activity_history (supabase-client.js, editActivity). The tenant-isolation
-- release (Section 20) left activity_history with a read-only policy, expecting
-- a database trigger to write those rows. That trigger was never built, so every
-- edit has been refused since then.
--
-- What this adds: one INSERT policy. A signed-in user may save a previous
-- version only when all of these are true:
--   * the row is signed by them (edited_by = themselves)
--   * the entry is in their current shop (tenant isolation)
--   * they wrote the entry, or they are the shop owner (same rule as the
--     Edit button and the enforce_activity_edits trigger)
--   * the saved text and version match the entry as it is right now, so
--     nobody can plant made-up history
--
-- Unchanged: history rows still cannot be updated or deleted by anyone in the
-- app, and the read policy is untouched. No app change is needed.
--
-- Rollback: drop policy "ah: insert before own edit" on public.activity_history;

drop policy if exists "ah: insert before own edit" on public.activity_history;

create policy "ah: insert before own edit" on public.activity_history
  for insert
  to authenticated
  with check (
    edited_by = auth.uid()
    and exists (
      select 1
      from public.activities a
      where a.id = activity_history.activity_id
        and a.shop_id = activity_history.shop_id
        and public.row_in_current_shop(a.shop_id)
        and (a.author_id = auth.uid() or public.is_shop_owner())
        and a.version = activity_history.version
        and a.body = activity_history.previous_body
    )
  );
