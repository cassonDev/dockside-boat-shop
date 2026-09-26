-- ===========================================================================
-- Shop Locations: add missing fields + access rules
-- Source: 03-section-25.4-shop-locations-fix.sql (repo main), unchanged except
--         for the two safety timeouts at the top of the transaction.
--
-- WHY: The live app (branch main) already saves location code, phone, email,
--      timezone and "primary" on shop locations. Production's table does not
--      have those columns and has no access rules, so owners cannot add or edit
--      locations, and nobody can see the location list.
--
-- WHAT IT DOES (additive only):
--   * Adds 6 columns. 4 are empty (null) text fields. is_primary defaults to
--     false, updated_at defaults to now(). Existing rows keep all their data.
--   * Adds 3 access rules:
--       - active members of a shop can SEE that shop's locations
--       - only an active OWNER of that shop can ADD a location
--       - only an active OWNER of that shop can EDIT / deactivate a location
--     No delete rule: locations are deactivated, never deleted.
--
-- WHAT IT DOES NOT DO: delete, rename or rewrite anything; touch work orders,
--   memberships, profiles or any other table.
--
-- SAFE TO RUN TWICE: every statement is "if not exists" / "drop if exists then
--   create", so re-running changes nothing.
--
-- LIVE USERS: runs in well under a second. lock_timeout means that if the table
--   is busy it gives up after 5 seconds instead of making users wait; nothing is
--   changed in that case and it can simply be run again.
--
-- Staging already has exactly this end state (verified 2026-09-26).
-- ===========================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.shop_locations add column if not exists location_code text;
alter table public.shop_locations add column if not exists phone         text;
alter table public.shop_locations add column if not exists email         text;
alter table public.shop_locations add column if not exists timezone      text;
alter table public.shop_locations add column if not exists is_primary    boolean not null default false;
alter table public.shop_locations add column if not exists updated_at    timestamptz not null default now();

drop policy if exists "locations: member read" on public.shop_locations;
create policy "locations: member read" on public.shop_locations
  for select using (public.is_active_shop_member(shop_id));

drop policy if exists "locations: owner insert" on public.shop_locations;
create policy "locations: owner insert" on public.shop_locations
  for insert with check (public.is_shop_owner(shop_id));

drop policy if exists "locations: owner update" on public.shop_locations;
create policy "locations: owner update" on public.shop_locations
  for update using (public.is_shop_owner(shop_id))
              with check (public.is_shop_owner(shop_id));

commit;

-- ===========================================================================
-- ROLLBACK (only if something goes wrong). Puts access back exactly as it is
-- today. The new columns are deliberately LEFT IN PLACE: they are harmless, and
-- dropping them would erase anything owners typed into them.
--
-- begin;
-- drop policy if exists "locations: member read"  on public.shop_locations;
-- drop policy if exists "locations: owner insert" on public.shop_locations;
-- drop policy if exists "locations: owner update" on public.shop_locations;
-- commit;
-- ===========================================================================
