-- ===========================================================================
-- section-21-storage.sql
-- STANDALONE, additive private-storage migration for work-order-photos.
--
-- This file contains ONLY Section 21. It does NOT include, rerun, or depend on
-- any Section 1-20 SQL, does NOT add the missing shops.slug column, and does
-- NOT change the bucket public/private flag. It is safe to run on top of an
-- already-migrated live database and is rerunnable (create or replace /
-- add column if not exists / explicit drop-then-create for policies).
--
-- Apply the MIGRATION section. The VERIFICATION section at the bottom is
-- READ-ONLY and changes nothing.
-- ===========================================================================


-- ===========================================================================
-- PREFLIGHT (READ-ONLY) — confirms prerequisites exist. Makes NO changes.
--   Run this first. Every row must report ok = true before applying the
--   migration below. If any is false, STOP and reconcile — do not migrate.
-- ===========================================================================
with checks as (
  select 'table public.work_orders'          as requirement,
         to_regclass('public.work_orders')            is not null as ok
  union all
  select 'table public.work_order_photos',
         to_regclass('public.work_order_photos')      is not null
  union all
  select 'table public.profiles',
         to_regclass('public.profiles')               is not null
  union all
  select 'table storage.objects',
         to_regclass('storage.objects')               is not null
  union all
  select 'column work_orders.shop_id',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='work_orders'
                   and column_name='shop_id')
  union all
  select 'column work_order_photos.active',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='work_order_photos'
                   and column_name='active')
  union all
  select 'helper public.is_active_user()',
         exists (select 1 from pg_proc where proname='is_active_user')
  union all
  select 'helper public.is_shop_owner()',
         exists (select 1 from pg_proc where proname='is_shop_owner')
  union all
  select 'helper public.row_in_current_shop()',
         exists (select 1 from pg_proc where proname='row_in_current_shop')
)
select requirement, ok from checks order by ok, requirement;


-- ###########################################################################
-- ####################  BEGIN EXECUTABLE MIGRATION SQL  #####################
-- ###########################################################################

-- 21. PRIVATE-STORAGE CONVERSION (additive; bucket stays PUBLIC in this pass)
--
--   Goal: make work-order-photos safe to flip to a PRIVATE bucket WITHOUT
--   breaking reads, and lock every storage operation to the caller's shop as
--   proven by AUTHORITATIVE DATABASE DATA — never by trusting the object path
--   text. This section is safe to apply while the bucket is still public:
--   the SELECT policy below is inert on a public bucket (public reads bypass
--   RLS) and simply becomes the enforcement point the moment the bucket is
--   flipped private (that flip is a DEPLOY step, NOT run here).
--
--   NOTHING in this section deletes bytes or changes the bucket's public flag.
-- ===========================================================================

-- 21A. Authoritative path->work_order resolver + object-name format guard.
--   The object path is <work_order_id>/<photo_id>-{orig|thumb}.jpg. We resolve
--   the FIRST segment against public.work_orders and return the row ONLY if it
--   genuinely exists; a made-up prefix resolves to nothing and is denied. The
--   format guard additionally prevents arbitrary path creation.
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

-- Enforced object-name shape: "<segment>/<uuid-or-token>-orig.jpg" | "...-thumb.jpg".
-- Blocks arbitrary keys and stray folders (name must have exactly one "/").
create or replace function public.storage_name_is_valid_photo(object_name text)
returns boolean language sql immutable set search_path = public as $$
  select object_name ~ '^[^/]+/[^/]+-(orig|thumb)\.jpg$';
$$;

-- 21B. Storage policies (DB-authoritative). Replace the section-20 set.
drop policy if exists "work-order-photos: shop member insert" on storage.objects;
drop policy if exists "work-order-photos: owner manage" on storage.objects;
drop policy if exists "wop: select shop member" on storage.objects;
drop policy if exists "wop: insert shop member" on storage.objects;
drop policy if exists "wop: update shop member noshopmove" on storage.objects;
drop policy if exists "wop: delete owner only" on storage.objects;

-- READ: any active member of the work order's shop. Inert while the bucket is
-- public; the enforcement point once it is flipped private.
create policy "wop: select shop member" on storage.objects
  for select using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  );

-- INSERT: active member of the WO's shop AND a well-formed photo key. The WO
-- must exist in the DB and belong to the caller's current shop.
create policy "wop: insert shop member" on storage.objects
  for insert with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- UPDATE: active member of the WO's shop. USING pins the object to the current
-- shop; WITH CHECK re-validates the (possibly renamed) key against a WO in the
-- SAME shop and the required name shape — so an object can never be renamed or
-- moved into another work order or another shop.
create policy "wop: update shop member noshopmove" on storage.objects
  for update using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  ) with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- DELETE (byte removal): shop_owner of the WO's shop ONLY, as defense in depth.
-- The application never deletes bytes from the browser (soft delete only); the
-- real permanent purge runs server-side with the service-role key, which
-- bypasses RLS. This policy exists so that IF a browser-side delete is ever
-- attempted, a mechanic cannot destroy evidence and a cross-tenant caller is
-- refused. Mechanics: intentionally NO storage delete permission.
create policy "wop: delete owner only" on storage.objects
  for delete using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_owned_in_current_shop(name)
  );

-- 21C. Retention / purge lifecycle columns on work_order_photos.
--   Smallest coherent model: reuse the EXISTING soft-delete pair
--   (archived_at = deleted_at, archived_by = deleted_by) and add ONLY the
--   purge-specific state. Three distinct states are representable:
--     inactive           : active = false                (soft-deleted, keep)
--     approved-for-purge : purge_approved_at is not null AND purge_after set
--     purged             : storage_deleted_at is not null (bytes gone)
alter table public.work_order_photos add column if not exists purge_approved_at timestamptz;
alter table public.work_order_photos add column if not exists purge_approved_by uuid references public.profiles(id);
alter table public.work_order_photos add column if not exists purge_after timestamptz;
alter table public.work_order_photos add column if not exists storage_deleted_at timestamptz;
alter table public.work_order_photos add column if not exists storage_delete_error text;
-- Replacement lineage (Phase D): the photo that superseded this one, if any.
alter table public.work_order_photos add column if not exists replaced_by_photo_id uuid references public.work_order_photos(id) on delete set null;

-- Index for the future purge worker: only rows explicitly approved, past their
-- retention date, and not yet purged.
create index if not exists work_order_photos_purge_ready_idx
  on public.work_order_photos (purge_after)
  where purge_approved_at is not null and storage_deleted_at is null;

-- 21D. Read-only purge-candidate view. This SELECTS candidates; it NEVER
--   deletes. A future controlled release adds a service-role worker that reads
--   this view, re-verifies each row, removes the orig+thumb objects via the
--   Storage API, then stamps storage_deleted_at (or storage_delete_error).
--   No purge is wired up in this pass.
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

-- NOTE: the bucket is DELIBERATELY still public here. Flip it private only as a
-- deploy step AFTER the signed-URL frontend is live and verified:
--     update storage.buckets set public = false where id = 'work-order-photos';
-- Rollback: set public = true (reads work again immediately via CDN).
-- ===========================================================================

-- ###########################################################################
-- #####################  END EXECUTABLE MIGRATION SQL  ######################
-- ###########################################################################


-- ===========================================================================
-- VERIFICATION (READ-ONLY) — run AFTER the migration. Changes nothing.
--   Corresponds to DEPLOYMENT-PLAYBOOK.md checks 2.3, 2.6, 2.10, 2.11.
-- ===========================================================================

-- Playbook 2.3 — Section 21 helper functions. Expected: 3 rows.
select proname from pg_proc where proname in
 ('storage_wo_in_current_shop','storage_wo_owned_in_current_shop',
  'storage_name_is_valid_photo')
order by proname;

-- Playbook 2.6 — storage.objects policies (wop:*). Expected: 4 rows
--   (select shop member / insert shop member / update shop member noshopmove /
--    delete owner only).
select policyname, cmd from pg_policies
where schemaname='storage' and tablename='objects' and policyname like 'wop:%'
order by policyname;

-- Playbook 2.10 — retention columns on work_order_photos. Expected: 6 rows.
select column_name from information_schema.columns
where table_schema='public' and table_name='work_order_photos'
  and column_name in ('purge_approved_at','purge_approved_by','purge_after',
                      'storage_deleted_at','storage_delete_error','replaced_by_photo_id')
order by column_name;

-- Playbook 2.11 — purge-candidate view exists. Expected: 1 row.
select table_name from information_schema.views
where table_schema='public' and table_name='work_order_photos_purge_candidates';

-- Optional confirmation the purge index exists. Expected: 1 row.
select indexname from pg_indexes
where schemaname='public' and indexname='work_order_photos_purge_ready_idx';
-- ===========================================================================
