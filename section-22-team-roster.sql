-- ===========================================================================
-- Section 22 — Team roster read path for non-owner shop members
-- ===========================================================================
-- PURPOSE
--   Let an active NON-OWNER member (mechanic) see a basic directory of the
--   ACTIVE coworkers at their own shop — name, role, status, default location
--   — without loosening any existing RLS policy and without exposing any
--   sensitive profile column (email, phone, availability/out-of-office,
--   active_shop_id, or any admin field).
--
-- WHY A FUNCTION (not a policy change)
--   Postgres RLS is ROW-level, not column-level. Granting mechanics a SELECT
--   policy on profiles would expose the WHOLE profile row. A SECURITY DEFINER
--   function returns only a whitelisted column set, so the exposure is exactly
--   the team directory and nothing more. No existing policy is modified.
--
-- SAFETY PROPERTIES
--   * Takes NO parameters — the caller cannot supply a shop_id, so it can never
--     be pointed at another tenant.
--   * Shop is derived solely from public.current_user_shop_id(), which trusts
--     profiles.active_shop_id ONLY after re-verifying an active membership.
--   * Re-checks the caller is an active member of that shop
--     (is_active_shop_member) — a non-member gets zero rows.
--   * Returns ONLY: profile_id, full_name, role, is_active, default_location_id.
--     No email/phone/availability/out-of-office/admin columns.
--   * Filters to m.is_active = true — mechanics see ACTIVE coworkers only.
--     (Owners keep the existing owner-authorized path that also shows inactive.)
--   * SECURITY DEFINER bypasses table RLS INSIDE the function; the WHERE clause
--     is the tenant boundary. Management is unaffected — this is read-only and
--     grants no ability to change any row.
--
-- IDEMPOTENT. Additive only. No table, policy, trigger, or grant is removed.
-- ---------------------------------------------------------------------------

create or replace function public.get_team_roster()
returns table (
  profile_id          uuid,
  full_name           text,
  role                text,
  is_active           boolean,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id,
         p.full_name,
         m.role,
         m.is_active,
         m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_active_shop_member(public.current_user_shop_id())
    and m.is_active                       -- active coworkers only
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;

-- Only signed-in users may call it; anon has no access. Execution still returns
-- nothing unless the caller is an active member of a shop.
revoke all on function public.get_team_roster() from public;
revoke all on function public.get_team_roster() from anon;
grant execute on function public.get_team_roster() to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (read-only; run after applying)
-- ---------------------------------------------------------------------------
-- As a mechanic (active member of shop A):
--   select * from public.get_team_roster();
--     -> only ACTIVE members of shop A; name/role/status/location only.
-- Attempt abuse (no parameter exists to pass another shop):
--   select * from public.get_team_roster('<shop B id>');   -- errors: no such function signature
-- As a user with no active membership:
--   select * from public.get_team_roster();                -- zero rows
-- Confirm no sensitive columns are returned:
--   select column_name from information_schema.routines ... (function returns only the 5 columns above)
