-- ===========================================================================
-- Mark a shop's location as primary when it is the shop's ONLY active location
-- and the shop has no primary yet.
--
-- Run AFTER 20260926000001_shop_locations_fields_and_policies.sql (needs the
-- is_primary column).
--
-- Production preview (read-only, 2026-09-26): touches exactly 1 row.
-- Staging: touches 0 rows (every staging shop has 2+ locations).
-- Changes only is_primary and updated_at. Safe to run twice (second run: 0 rows).
--
-- Undo (if ever needed): set is_primary = false on that one location, or pick a
-- different primary in Shop Configuration -> Locations.
-- ===========================================================================

update public.shop_locations l
set is_primary = true,
    updated_at = now()
where l.is_active
  and not exists (
    select 1 from public.shop_locations o
    where o.shop_id = l.shop_id and o.is_primary
  )
  and (
    select count(*) from public.shop_locations o
    where o.shop_id = l.shop_id and o.is_active
  ) = 1;
