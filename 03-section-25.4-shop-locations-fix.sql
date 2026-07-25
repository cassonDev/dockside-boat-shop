-- ===========================================================================
-- section-25.4-shop-locations-fix.sql   (STANDALONE, FOR REVIEW — staging first)
--
-- Fixes Shop Locations create/edit/deactivate, which fail today because the
-- live table + RLS drifted from what the frontend expects.
--
-- INSPECTION FINDINGS (confirm on staging with the PRE-CHECK block below):
--   * Live public.shop_locations (from applied section-20-tenant-foundation.sql
--     + RECONCILED-LIVE-STATE.md) = (id, shop_id, name, is_active, created_at).
--   * Frontend write paths (supabase-client.js) send, and therefore REQUIRE:
--       createLocation(): location_code, phone, email, timezone, is_primary
--       updateLocation(): + is_active, updated_at
--     → the missing columns cause "Could not find the '<col>' column of
--       'shop_locations'" on the FIRST unknown key (location_code).
--   * Applied Section 20 enabled RLS on shop_locations but created NO policy
--     for it (the "locations: *" policies live only in the un-applied paper
--     schema). With RLS enabled and no policy, member READS return 0 rows and
--     ALL writes are denied.
--   * The frontend payload is CORRECT vs. the intended schema — so this is a
--     schema + policy fix ONLY. No frontend change is required or included.
--
-- INSERT vs UPDATE: a FOR UPDATE policy does NOT cover INSERT. Creating a
--   location needs its own INSERT (WITH CHECK) policy; deactivate/reactivate is
--   an UPDATE (is_active flip) and needs the UPDATE policy. Both are added below.
--   DELETE is intentionally NOT granted (the app soft-deactivates, never DELETEs).
--
-- SAFETY: additive columns (metadata-only, no rewrite); owner-scoped policies
--   (is_shop_owner(shop_id)) — no broad authenticated write, mechanics stay
--   read-only, tenant isolation preserved. Idempotent; one transaction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK (READ-ONLY — run separately BEFORE migrating to confirm the gaps).
--   Expected on the drifted DB: the column list is missing location_code/phone/
--   email/timezone/is_primary/updated_at, and shop_locations has 0 policies.
-- ---------------------------------------------------------------------------
-- select column_name from information_schema.columns
--   where table_schema='public' and table_name='shop_locations' order by column_name;
-- select policyname, cmd from pg_policies
--   where schemaname='public' and tablename='shop_locations' order by cmd;

begin;

-- ---- Additive columns the frontend write paths require (match paper types) ---
alter table public.shop_locations add column if not exists location_code text;
alter table public.shop_locations add column if not exists phone         text;
alter table public.shop_locations add column if not exists email         text;
alter table public.shop_locations add column if not exists timezone      text;   -- null → inherit shop tz
alter table public.shop_locations add column if not exists is_primary    boolean not null default false;
alter table public.shop_locations add column if not exists updated_at    timestamptz not null default now();
-- NOTE (deliberately omitted, minimal scope): address_line1/2, city, region,
--   postal_code, country, settings, created_by are in the paper schema but the
--   frontend create/updateLocation does NOT write them, so they are not needed
--   for the save path. Add later only if the Locations form starts writing them.
-- NOTE (single-primary): the paper's partial unique index
--   shop_locations_one_primary is NOT added here — the frontend does not unset a
--   previous primary when marking a new one, so the index could reject a legit
--   save. Deferred as a separate hardening once the UI clears the old primary.

-- ---- Owner-scoped RLS: read (members), insert + update (owners of that shop) --
-- Members of the shop may READ its locations (mechanics read-only).
drop policy if exists "locations: member read" on public.shop_locations;
create policy "locations: member read" on public.shop_locations
  for select using (public.is_active_shop_member(shop_id));

-- Only an active OWNER of that exact shop may CREATE a location in it.
drop policy if exists "locations: owner insert" on public.shop_locations;
create policy "locations: owner insert" on public.shop_locations
  for insert with check (public.is_shop_owner(shop_id));

-- Only an active OWNER of that exact shop may EDIT / deactivate / reactivate.
drop policy if exists "locations: owner update" on public.shop_locations;
create policy "locations: owner update" on public.shop_locations
  for update using (public.is_shop_owner(shop_id))
              with check (public.is_shop_owner(shop_id));
-- (No DELETE policy: deactivation is an is_active UPDATE; hard delete stays denied.)

commit;

-- ===========================================================================
-- POST-VERIFICATION (READ-ONLY).
-- 1) Columns present (expect the 6 added):
-- select column_name from information_schema.columns
--   where table_schema='public' and table_name='shop_locations'
--   and column_name in ('location_code','phone','email','timezone','is_primary','updated_at');
-- 2) Policies (expect member-read SELECT, owner-insert INSERT, owner-update UPDATE):
-- select policyname, cmd from pg_policies
--   where schemaname='public' and tablename='shop_locations' order by cmd;
-- 3) App smoke (as owner): create/edit/deactivate/reactivate a location, refresh,
--    values persist. As a MECHANIC: create/update/deactivate all denied (0 rows);
--    read still works. Cross-shop: another shop cannot see or modify these rows.
-- ===========================================================================
