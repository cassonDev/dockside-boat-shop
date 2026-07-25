-- ===========================================================================
-- ROLLBACK-section-25-release.sql   (reverses the whole Section 25 release)
--
-- Run in REVERSE order of deployment: undo 25.3/25.2 first (file 02), then the
-- Section 25 core (file 01). Review before running; staging first.
--
-- WARNING: dropping the 25.2 columns DELETES any saved legal name / address /
-- phone / email / timezone / settings (settings also backs branding + feature
-- toggles). Dropping the legal tables DESTROYS acceptance history. Export first
-- if you need to keep any of it. Prefer partial rollback (e.g. only the policy)
-- over a full teardown unless truly necessary.
--
-- Does NOT drop platform_admins / is_platform_admin() — those are Section 20
-- objects, not part of this release.
-- ===========================================================================

begin;

-- ---- Reverse 25.4: shop_locations policies + columns (DESTRUCTIVE) ----
drop policy if exists "locations: owner update" on public.shop_locations;
drop policy if exists "locations: owner insert" on public.shop_locations;
drop policy if exists "locations: member read" on public.shop_locations;
alter table public.shop_locations drop column if exists updated_at;
alter table public.shop_locations drop column if exists is_primary;
alter table public.shop_locations drop column if exists timezone;
alter table public.shop_locations drop column if exists email;
alter table public.shop_locations drop column if exists phone;
alter table public.shop_locations drop column if exists location_code;

-- ---- Reverse 25.3: owner UPDATE policy (restores Section 20's SELECT-only) ----
drop policy if exists "shops: owner update" on public.shops;

-- ---- Reverse 25.2: additive shops columns (DESTRUCTIVE) ----
alter table public.shops drop column if exists settings;
alter table public.shops drop column if exists timezone;
alter table public.shops drop column if exists country;
alter table public.shops drop column if exists postal_code;
alter table public.shops drop column if exists region;
alter table public.shops drop column if exists city;
alter table public.shops drop column if exists address_line2;
alter table public.shops drop column if exists address_line1;
alter table public.shops drop column if exists email;
alter table public.shops drop column if exists phone;
alter table public.shops drop column if exists legal_name;

-- ---- Reverse Section 25 core (file 01) ----
drop function if exists public.get_platform_shop_members(uuid);
drop function if exists public.get_platform_shop_details(uuid);
drop function if exists public.get_platform_shops();
drop function if exists public.create_shop_as_owner(text, text);
drop function if exists public.accept_legal_agreement(text, integer);

do $$ begin
  if to_regclass('public.legal_agreements') is not null then
    revoke select on public.legal_agreements from authenticated;
  end if;
  if to_regclass('public.legal_acceptances') is not null then
    revoke select on public.legal_acceptances from authenticated;
  end if;
end $$;
drop table if exists public.legal_acceptances;
drop table if exists public.legal_agreements;

drop policy if exists "platform_admins: admin read" on public.platform_admins;

commit;

-- ===========================================================================
-- POST-ROLLBACK (read-only): the five section-25 functions and both legal
-- tables should be gone; the 11 shops columns removed; "shops: owner update"
-- gone; platform_admins + is_platform_admin() still present (Section 20).
-- ===========================================================================
