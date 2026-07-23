-- =============================================================================
-- 02-PROD-MIGRATION.sql   — THE PRODUCTION MIGRATION. Run in prod Supabase
--                           ONLY AFTER reviewing 01-PROD-PREFLIGHT.sql output.
-- -----------------------------------------------------------------------------
-- WHAT THIS DOES: brings production up to the current staging version by adding
-- ONLY the database objects staging gained AFTER the Section 20 foundation that
-- production already has. It does NOT replay Section 20 and does NOT touch the
-- Section 20 tenant tables, helpers, stamp triggers, or shop-isolation policies.
--
-- It does NOT copy any staging data (no shops, users, memberships, work orders,
-- locations, labels, or seed rows). It is pure DDL against production's own data.
--
-- SCOPE (the entire delta):
--   A. Intake-transcript columns on work_orders           (idempotent add-if-missing)
--   B. Section 21 private-storage objects                 (helpers, wop:* policies,
--      retention columns, purge index + view) + hardening drop of the pre-tenant
--      permissive storage policies the wop:* set supersedes
--   C. Serial-label insert-stamp trigger (the "+ ADD LABEL" RLS fix)
--
-- INTENTIONALLY NOT INCLUDED (see README "Not promoted"):
--   * The `forbid_shop_change` UPDATE guard — deployed Section 20 never created
--     it, and staging has not added it either (the 21c parity check was
--     read-only and the decision was deferred). Adding it here would diverge
--     from staging and is out of scope. Cross-shop moves remain blocked by the
--     RLS WITH CHECK (row_in_current_shop) on the isolation policies.
--   * The bucket public->private flip (a later, separate deploy step).
--   * Any `supabase-schema.sql` object naming (that file is idealized and does
--     NOT match the live section-20 lineage).
--
-- SAFETY: fully idempotent — every statement is `add column if not exists`,
-- `create or replace`, or explicit `drop ... if exists` + `create`. Safe to run
-- more than once. Wrapped in a single transaction so a failure rolls back clean.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- GUARD: refuse to run unless the Section 20 foundation this delta builds on is
-- actually present. Aborts the whole transaction if a prerequisite is missing.
-- -----------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.work_orders') is null
     or to_regclass('public.work_order_photos') is null
     or to_regclass('public.shop_serial_label_options') is null then
    raise exception 'PREREQ FAIL: core tables missing — this is not the expected app DB.';
  end if;
  if not exists (select 1 from pg_proc where proname='row_in_current_shop')
     or not exists (select 1 from pg_proc where proname='is_active_user')
     or not exists (select 1 from pg_proc where proname='is_shop_owner')
     or not exists (select 1 from pg_proc where proname='set_tenant_shop_id') then
    raise exception 'PREREQ FAIL: Section 20 helpers missing — apply Section 20 first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='work_orders'
                   and column_name='shop_id') then
    raise exception 'PREREQ FAIL: work_orders.shop_id missing — Section 20 not applied.';
  end if;
  raise notice 'PREREQ OK: Section 20 foundation present. Applying delta A/B/C.';
end $guard$;


-- #############################################################################
-- BLOCK A — Intake-transcript columns on work_orders
--   Source: migration-intake-transcript.sql. No-op if already present.
-- #############################################################################
alter table public.work_orders
  add column if not exists customer_concern text not null default '',
  add column if not exists original_transcript text not null default '',
  add column if not exists original_customer_concern text not null default '',
  add column if not exists original_extraction jsonb;

comment on column public.work_orders.customer_concern is 'Current editable customer-facing concern (service order / invoice / portal wording).';
comment on column public.work_orders.original_transcript is 'Speech-to-text transcript exactly as it existed when the job was saved. Permanently read-only after save.';
comment on column public.work_orders.original_customer_concern is 'First AI-generated customer-facing concern, preserved for audit even if customer_concern is later edited.';
comment on column public.work_orders.original_extraction is 'First AI-extracted field snapshot, preserved for audit.';


-- #############################################################################
-- BLOCK B — Section 21 private-storage conversion (additive; bucket stays PUBLIC)
--   Source: section-21-storage.sql (helpers + policies + retention + view),
--   plus a flagged hardening drop of the superseded pre-tenant storage policies.
-- #############################################################################

-- 21A. Authoritative path->work_order resolvers + object-name format guard.
create or replace function public.storage_wo_in_current_shop(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.work_orders wo
    where wo.id = (storage.foldername(object_name))[1]
      and public.is_active_user()
      and public.row_in_current_shop(wo.shop_id)
  );
$$;

create or replace function public.storage_wo_owned_in_current_shop(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.work_orders wo
    where wo.id = (storage.foldername(object_name))[1]
      and public.is_shop_owner()
      and public.row_in_current_shop(wo.shop_id)
  );
$$;

create or replace function public.storage_name_is_valid_photo(object_name text)
returns boolean language sql immutable set search_path = public as $$
  select object_name ~ '^[^/]+/[^/]+-(orig|thumb)\.jpg$';
$$;

-- 21B. DB-authoritative storage policies. Drop any prior variants, then create
-- the four `wop:` policies.
drop policy if exists "work-order-photos: shop member insert" on storage.objects;
drop policy if exists "work-order-photos: owner manage" on storage.objects;
drop policy if exists "wop: select shop member" on storage.objects;
drop policy if exists "wop: insert shop member" on storage.objects;
drop policy if exists "wop: update shop member noshopmove" on storage.objects;
drop policy if exists "wop: delete owner only" on storage.objects;

-- HARDENING (flagged): remove the pre-tenant PERMISSIVE storage policies that
-- the wop:* set supersedes. These grant cross-tenant access (owner-of-any-shop
-- full access; any active user insert with only path-trust) and MUST NOT
-- coexist with the shop-scoped wop:* policies. Idempotent: no-op if absent.
-- If P10 preflight showed these are already gone, these lines do nothing.
drop policy if exists "work-order-photos: shop_owner full access" on storage.objects;
drop policy if exists "work-order-photos: staff insert any job" on storage.objects;
drop policy if exists "work-order-photos: read active" on storage.objects;
drop policy if exists "work-order-photos: staff curate any" on storage.objects;
drop policy if exists "work-order-photos: uploader update own" on storage.objects;

-- READ: any active member of the WO's shop. Inert while the bucket is public;
-- becomes the enforcement point once the bucket is flipped private (later step).
create policy "wop: select shop member" on storage.objects
  for select using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  );

-- INSERT: active member of the WO's shop AND a well-formed photo key.
create policy "wop: insert shop member" on storage.objects
  for insert with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- UPDATE: active member of the WO's shop; cannot rename/move across WO or shop.
create policy "wop: update shop member noshopmove" on storage.objects
  for update using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  ) with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- DELETE (byte removal): shop_owner of the WO's shop ONLY (defense in depth).
create policy "wop: delete owner only" on storage.objects
  for delete using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_owned_in_current_shop(name)
  );

-- 21C. Retention / purge lifecycle columns on work_order_photos.
alter table public.work_order_photos add column if not exists purge_approved_at timestamptz;
alter table public.work_order_photos add column if not exists purge_approved_by uuid references public.profiles(id);
alter table public.work_order_photos add column if not exists purge_after timestamptz;
alter table public.work_order_photos add column if not exists storage_deleted_at timestamptz;
alter table public.work_order_photos add column if not exists storage_delete_error text;
alter table public.work_order_photos add column if not exists replaced_by_photo_id uuid references public.work_order_photos(id) on delete set null;

create index if not exists work_order_photos_purge_ready_idx
  on public.work_order_photos (purge_after)
  where purge_approved_at is not null and storage_deleted_at is null;

-- 21D. Read-only purge-candidate view (SELECTs only; nothing purges here).
create or replace view public.work_order_photos_purge_candidates as
  select id, work_order_id, shop_id, storage_path, thumb_path,
         active, archived_at, archived_by,
         purge_approved_at, purge_approved_by, purge_after
  from public.work_order_photos
  where active = false
    and purge_approved_at is not null
    and purge_after is not null
    and purge_after <= now()
    and storage_deleted_at is null;

-- NOTE: the bucket stays PUBLIC. Flip to private only AFTER the signed-URL
-- frontend is deployed and verified (separate deploy step, not run here):
--     update storage.buckets set public = false where id = 'work-order-photos';


-- #############################################################################
-- BLOCK C — Serial-label insert-stamp trigger (the "+ ADD LABEL" RLS fix)
--   Section 20 attached `stamp_shop_id` to every tenant table EXCEPT
--   shop_serial_label_options, so its shop_id is left NULL on insert and the
--   RLS WITH CHECK row_in_current_shop(shop_id) rejects the row. This adds the
--   missing trigger, using the SAME name (`stamp_shop_id`) and the SAME strict
--   stamp function (`set_tenant_shop_id`) as the other owner/app tables, so it
--   is consistent with the deployed lineage. Server stamps shop_id :=
--   current shop; any client-sent value is ignored. Tenant-safe.
-- #############################################################################
drop trigger if exists stamp_shop_id on public.shop_serial_label_options;
create trigger stamp_shop_id
  before insert on public.shop_serial_label_options
  for each row execute function public.set_tenant_shop_id();


commit;
-- =============================================================================
-- DONE. Now run 03-PROD-POST-VERIFICATION.sql to confirm the end state.
-- =============================================================================
