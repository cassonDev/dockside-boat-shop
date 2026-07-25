-- ===========================================================================
-- 02-section-25.2-and-25.3-shops-fixes.sql   (PRODUCTION — run AFTER 01)
--
-- Consolidates the two shop-save fixes proven in staging into ONE idempotent,
-- transactional migration (no duplicate migrations):
--
--   25.2 — Additive columns on public.shops that the frontend save path
--          (updateShop) writes but the applied Section 20 schema lacked.
--   25.3 — Owner-scoped UPDATE RLS policy on public.shops (Section 20 shipped
--          only "shops: member read" SELECT; with no UPDATE policy the owner's
--          save is RLS-denied even once the columns exist).
--
-- Together with 01 (Section 25 core), this is everything production needs for
-- Shop Configuration to load AND save correctly.
--
-- SAFETY: additive only. Column adds are metadata-only (no table rewrite). The
-- UPDATE policy is owner-scoped (is_shop_owner(id)) — mechanics and platform
-- admins get NO write path to shops. No existing policy/RPC/trigger is dropped
-- except the same-named "shops: owner update" (idempotent re-create).
-- ===========================================================================

begin;

-- ---- 25.2: additive shops columns (match supabase-schema.sql types/defaults)
alter table public.shops add column if not exists legal_name    text;
alter table public.shops add column if not exists phone         text;
alter table public.shops add column if not exists email         text;
alter table public.shops add column if not exists address_line1 text;
alter table public.shops add column if not exists address_line2 text;
alter table public.shops add column if not exists city          text;
alter table public.shops add column if not exists region        text;   -- state/province
alter table public.shops add column if not exists postal_code   text;
alter table public.shops add column if not exists country       text;
alter table public.shops add column if not exists timezone      text not null default 'America/Toronto';
alter table public.shops add column if not exists settings      jsonb not null default '{}'::jsonb;

-- ---- 25.3: owner-scoped UPDATE policy on shops (SELECT policy already exists)
drop policy if exists "shops: owner update" on public.shops;
create policy "shops: owner update" on public.shops
  for update using (public.is_shop_owner(id)) with check (public.is_shop_owner(id));

commit;

-- ===========================================================================
-- VERIFICATION (read-only).
-- 1) Columns present (expect 11):
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='shops'
--   and column_name in ('legal_name','phone','email','address_line1','address_line2',
--     'city','region','postal_code','country','timezone','settings');
-- 2) Policies on shops (expect member-read SELECT + owner-update UPDATE):
-- select policyname, cmd from pg_policies
--  where schemaname='public' and tablename='shops' order by cmd;
-- 3) App smoke: owner edits + saves Shop Config, refresh persists; a MECHANIC
--    UPDATE on shops is denied (0 rows).
-- ===========================================================================
