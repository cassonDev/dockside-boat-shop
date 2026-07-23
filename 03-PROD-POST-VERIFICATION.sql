-- =============================================================================
-- 03-PROD-POST-VERIFICATION.sql  — Run AFTER 02-PROD-MIGRATION.sql. READ-ONLY.
-- -----------------------------------------------------------------------------
-- Proves the delta landed and that the Section 20 foundation + tenant isolation
-- are intact. Makes NO changes. Every block states its expected result; send the
-- output back so we can sign off before the private-bucket flip / go-live.
-- =============================================================================


-- V1. BLOCK A — intake columns. EXPECT: 4 rows.
select 'V1 intake columns' as check, column_name
from information_schema.columns
where table_schema='public' and table_name='work_orders'
  and column_name in ('customer_concern','original_transcript',
                      'original_customer_concern','original_extraction')
order by column_name;


-- V2. BLOCK B — Section 21 storage helpers. EXPECT: 3 rows.
select 'V2 storage helpers' as check, proname
from pg_proc
where proname in ('storage_wo_in_current_shop','storage_wo_owned_in_current_shop',
                  'storage_name_is_valid_photo')
order by proname;


-- V3. BLOCK B — storage.objects policies. EXPECT: exactly the 4 `wop:` policies
--     (select shop member / insert shop member / update shop member noshopmove /
--     delete owner only) AND NO "work-order-photos: *" permissive policies left.
--     If any "work-order-photos:" row appears, the hardening drop did not cover
--     its exact name — send it back and we will add that name.
select 'V3 storage policies' as check, policyname, cmd
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;


-- V4. BLOCK B — retention columns. EXPECT: 6 rows.
select 'V4 retention columns' as check, column_name
from information_schema.columns
where table_schema='public' and table_name='work_order_photos'
  and column_name in ('purge_approved_at','purge_approved_by','purge_after',
                      'storage_deleted_at','storage_delete_error','replaced_by_photo_id')
order by column_name;


-- V5. BLOCK B — purge view + index. EXPECT: 1 row each.
select 'V5 purge view' as check, table_name
from information_schema.views
where table_schema='public' and table_name='work_order_photos_purge_candidates';
select 'V5 purge index' as check, indexname
from pg_indexes
where schemaname='public' and indexname='work_order_photos_purge_ready_idx';


-- V6. BLOCK C — serial-label insert-stamp trigger now present. EXPECT: 1 row
--     naming `stamp_shop_id`, enabled.
select 'V6 serial-label stamp trigger' as check, tgname,
       case tgenabled when 'O' then 'enabled' else tgenabled::text end as state
from pg_trigger
where tgrelid = 'public.shop_serial_label_options'::regclass
  and not tgisinternal and tgname='stamp_shop_id';


-- V7. FOUNDATION INTACT — the Section 20 stamp triggers are still on the other
--     tenant tables (this migration must not have disturbed them). EXPECT: 9 rows
--     (8 original tables + shop_serial_label_options added by block C).
select 'V7 all stamp triggers' as check, tgrelid::regclass as tbl
from pg_trigger
where tgname='stamp_shop_id' and not tgisinternal
order by tbl;


-- V8. FOUNDATION INTACT — shop-isolation row policies still present. EXPECT the
--     Section 20 set unchanged (wo/wop/woc/act/sn/ah/rcr/audit/serial_labels +
--     profiles/shops/memberships). Confirm none were dropped.
select 'V8 isolation policies' as check, tablename, policyname
from pg_policies
where schemaname='public'
  and tablename in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
order by tablename, policyname;


-- V9. FOUNDATION INTACT — RLS still enabled on every tenant table. EXPECT: all true.
select 'V9 rls enabled' as check, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options','profiles')
order by c.relname;


-- V10. FOUNDATION INTACT — shop_id still NOT NULL on strict tenant tables.
--      EXPECT: is_nullable = NO for each.
select 'V10 shop_id not null' as check, table_name, is_nullable
from information_schema.columns
where table_schema='public' and column_name='shop_id'
  and table_name in ('work_orders','work_order_photos','work_order_comments',
    'activities','work_order_serial_numbers','role_change_requests')
order by table_name;


-- V11. DATA INTEGRITY — no unstamped rows introduced. EXPECT: all zero.
select 'V11 unstamped rows' as check,
  (select count(*) from public.work_orders where shop_id is null)               as wo_null,
  (select count(*) from public.work_order_photos where shop_id is null)         as wop_null,
  (select count(*) from public.work_order_serial_numbers where shop_id is null) as sn_null,
  (select count(*) from public.shop_serial_label_options where shop_id is null) as label_null;


-- V12. BUCKET UNCHANGED — still public (the private flip is a later step).
--      EXPECT: public = true.
select 'V12 bucket' as check, id, public from storage.buckets where id='work-order-photos';
-- =============================================================================
-- Optional live isolation smoke test (run manually in a two-shop session):
--   * As shop A user: insert a serial label with NO shop_id -> succeeds, lands
--     stamped to shop A (block C). Insert one with shop_id = <shop B> -> trigger
--     overwrites it to shop A (never lands in B).
--   * As shop A user: select from shop_serial_label_options -> only shop A rows.
--   * Confirm "+ ADD LABEL" works in the app for the shop owner.
-- =============================================================================
