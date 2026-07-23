-- =============================================================================
-- 01-PROD-PREFLIGHT.sql   — RUN FIRST, IN PRODUCTION SUPABASE. READ-ONLY.
-- -----------------------------------------------------------------------------
-- This file makes NO changes. It only inspects. Run it in the production
-- Supabase SQL Editor and send the FULL output back before running
-- 02-PROD-MIGRATION.sql. Its purpose is to prove exactly what production
-- already has, so the migration only adds what is genuinely missing.
--
-- Baseline assumption we are TESTING (not trusting): production ran
-- `section-20-tenant-foundation.sql` (multi-tenant foundation) around
-- 2026-07-19 and has NOT had Section 21 storage, the serial-label stamp
-- trigger, or the intake-transcript columns applied since. Every block below
-- states what result confirms or contradicts that.
--
-- IMPORTANT: production follows the SECTION-20 object lineage
-- (trigger name `stamp_shop_id`; coarse "<x>: shop isolation" FOR ALL
-- policies). It does NOT follow `supabase-schema.sql` (which uses different
-- names like `set_shop_id`). Do not be alarmed that names differ from that
-- file — the section-20 names are correct/expected.
-- =============================================================================


-- P1. Tenant tables. EXPECT: 4 rows (shops, shop_locations, shop_memberships,
--     platform_admins). Fewer => Section 20 is not fully present: STOP.
select 'P1 tenant tables' as check, table_name
from information_schema.tables
where table_schema='public'
  and table_name in ('shops','shop_locations','shop_memberships','platform_admins')
order by table_name;


-- P2. Tenant helper functions. EXPECT present: current_user_shop_id,
--     is_active_shop_member, is_shop_owner, is_active_user, row_in_current_shop,
--     is_platform_admin, enforce_active_shop_id, set_active_shop,
--     set_tenant_shop_id, set_tenant_shop_id_lenient.
--     NOTE the following, which tell us how much of the *idealized* schema prod has:
--       * set_work_order_location  — present only if prod stamps work_orders.location_id
--       * forbid_shop_change       — the cross-shop-move UPDATE guard. Section 20 as
--         deployed did NOT create this; expect it ABSENT. Its absence is EXPECTED
--         and is NOT fixed by this promotion (deferred decision — see the README).
--       * storage_wo_in_current_shop / storage_wo_owned_in_current_shop /
--         storage_name_is_valid_photo — Section 21 storage helpers. EXPECT ABSENT
--         (this migration adds them).
select 'P2 helper functions' as check, proname, pg_get_function_arguments(oid) as args
from pg_proc
where proname in (
  'current_user_shop_id','is_active_shop_member','is_shop_owner','is_active_user',
  'row_in_current_shop','is_platform_admin','enforce_active_shop_id','set_active_shop',
  'set_tenant_shop_id','set_tenant_shop_id_lenient','set_work_order_location',
  'forbid_shop_change','storage_wo_in_current_shop','storage_wo_owned_in_current_shop',
  'storage_name_is_valid_photo')
order by proname, args;


-- P3. shop_id columns + nullability on every tenant table. EXPECT: shop_id
--     present on all; is_nullable = NO on the strict tables (work_orders,
--     work_order_photos, work_order_comments, activities,
--     work_order_serial_numbers, role_change_requests) and typically on
--     shop_serial_label_options + audit_log too if Section 20 locked them.
select 'P3 shop_id columns' as check, table_name, column_name, is_nullable
from information_schema.columns
where table_schema='public' and column_name in ('shop_id','location_id')
  and table_name in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
order by table_name, column_name;


-- P4. All non-internal triggers on every tenant table. THIS IS THE KEY
--     DIAGNOSTIC for the serial-label fix and guard parity.
--     EXPECT: `stamp_shop_id` present on work_orders, work_order_photos,
--     work_order_comments, activities, work_order_serial_numbers,
--     role_change_requests, audit_log, activity_history — but NOT on
--     shop_serial_label_options (that omission is the bug this migration fixes).
--     `forbid_shop_change`: expected absent everywhere (deployed Section 20 did
--     not create it). If it IS present on other tenant tables, tell us — that
--     changes the parity recommendation for the serial-label table.
select 'P4 triggers' as check, c.relname as table_name, t.tgname,
       case t.tgenabled when 'O' then 'enabled' when 'D' then 'DISABLED'
            when 'R' then 'replica' when 'A' then 'always' end as state
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and not t.tgisinternal
  and c.relname in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
order by c.relname, t.tgname;


-- P4b. Focused: does shop_serial_label_options have an insert-stamp trigger?
--      EXPECT: 0 rows (missing) — this is exactly what block C of the migration
--      adds. If it returns `stamp_shop_id`, the fix is already present (harmless
--      to re-run; the migration is idempotent).
select 'P4b serial-label stamp trigger' as check, tgname,
       case tgenabled when 'O' then 'enabled' else tgenabled::text end as state
from pg_trigger
where tgrelid = 'public.shop_serial_label_options'::regclass and not tgisinternal;


-- P5. Intake-transcript columns on work_orders. EXPECT: 4 rows if already
--     present, 0 if not. Either way the migration handles it (add if not
--     exists). Just tells us whether block A is a no-op.
select 'P5 intake columns' as check, column_name
from information_schema.columns
where table_schema='public' and table_name='work_orders'
  and column_name in ('customer_concern','original_transcript',
                      'original_customer_concern','original_extraction')
order by column_name;


-- P6. Section 21 retention columns on work_order_photos. EXPECT: 0 rows
--     (migration block B adds all 6).
select 'P6 retention columns' as check, column_name
from information_schema.columns
where table_schema='public' and table_name='work_order_photos'
  and column_name in ('purge_approved_at','purge_approved_by','purge_after',
                      'storage_deleted_at','storage_delete_error','replaced_by_photo_id')
order by column_name;


-- P7. Purge-candidate view + index. EXPECT: 0 rows each (block B adds them).
select 'P7 purge view' as check, table_name
from information_schema.views
where table_schema='public' and table_name='work_order_photos_purge_candidates';
select 'P7 purge index' as check, indexname
from pg_indexes
where schemaname='public' and indexname='work_order_photos_purge_ready_idx';


-- P8. RLS enabled on every app/tenant table. EXPECT: rowsecurity = true for all.
select 'P8 rls enabled' as check, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options','profiles',
    'shops','shop_locations','shop_memberships','platform_admins')
order by c.relname;


-- P9. Row-level policies on public tenant tables. EXPECT the Section 20 set,
--     e.g. `wo: shop isolation`, `wop: shop isolation`, `woc: shop isolation`,
--     `act: shop isolation`, `sn: shop isolation`, `ah: shop isolation`,
--     `rcr: shop isolation`, `audit: shop read`, `serial_labels: shop isolation`,
--     plus `profiles:`/`shops:`/`memberships:` policies. Send the full list so
--     we can confirm no pre-tenant permissive policy survived.
select 'P9 row policies' as check, tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and tablename in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options','profiles',
    'shops','shop_locations','shop_memberships','platform_admins')
order by tablename, policyname;


-- P10. Storage policies on storage.objects for the photo bucket. CRITICAL for
--      the storage-isolation hardening decision.
--      EXPECT (pre-Section-21): the OLD permissive pre-tenant policies may still
--      be here, e.g. "work-order-photos: shop_owner full access" and
--      "work-order-photos: staff insert any job". EXPECT the four `wop:` policies
--      to be ABSENT. The migration adds the four `wop:` policies and (as a
--      flagged hardening step) drops the old permissive ones. Send the full list.
select 'P10 storage policies' as check, policyname, cmd,
       coalesce(qual,'') as using_expr, coalesce(with_check,'') as check_expr
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;


-- P11. Photo bucket flag. EXPECT: public = true (the private flip is a later,
--      separate deploy step and is NOT part of this migration).
select 'P11 bucket' as check, id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'work-order-photos';


-- P12. Existing production data volume (so we confirm we are NOT importing
--      staging data — we only run DDL against prod's own data). Informational.
select 'P12 data counts' as check,
  (select count(*) from public.shops)             as shops,
  (select count(*) from public.shop_memberships)  as memberships,
  (select count(*) from public.work_orders)       as work_orders,
  (select count(*) from public.shop_serial_label_options) as serial_labels;
-- Also confirm zero unstamped strict rows (Section 20 backfill integrity).
select 'P12 unstamped rows' as check,
  (select count(*) from public.work_orders where shop_id is null)            as wo_null,
  (select count(*) from public.work_order_photos where shop_id is null)      as wop_null,
  (select count(*) from public.work_order_serial_numbers where shop_id is null) as sn_null;
-- =============================================================================
-- END PREFLIGHT. Send all P1–P12 output back before running the migration.
-- =============================================================================
