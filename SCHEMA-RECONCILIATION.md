# Schema Reconciliation Report — Live DB vs. Multi-Tenant Migration

**Read-only analysis. No SQL generated to run, no schema change, no policy
change, no bucket change. We are in a safe state — the Section 21 attempt
committed nothing.**

---

## 1. Verdict

**The multi-tenant foundation (Section 20) was never applied to this database.**
The live schema is the pre-tenant, **single-shop** design. The schema file
(`supabase-schema.sql`) and `MULTITENANT.md` describe an architecture that
**exists only on paper / in the file** — production drifted from (more precisely:
never caught up to) the file. Section 21 (private storage) sits on top of
Section 20 and therefore cannot be applied until the tenant foundation exists.

This is not fixable by patching `shop_id` onto one table. The entire
user→shop→work_order→photo authorization chain that Section 21 depends on is
absent.

---

## 2. Evidence: what the live DB actually has

From your read-only queries:

- **`profiles`** — `id, email, full_name, role, active, out_of_office, phone,
  availability_status, …`. **No `active_shop_id`, no membership link.** `role` is
  a global string (`shop_owner`/`mechanic`), not shop-scoped.
- **`work_orders`** — **no `shop_id`, no `location_id`.** Linked to people only,
  via `created_by` / `assigned_mechanic` → `profiles`.
- **`work_order_photos`** — **no `shop_id`.** Linked to `work_orders` +
  `profiles` (`created_by`).
- **Tenant-key search across `public`** — the only `shop_id` anywhere is
  `shop_serial_label_options.shop_id`. No `tenant_id`/`location_id`/`org_id`
  on the core tables.
- **Foreign keys** — `profiles → work_orders → work_order_photos` only. **No FK
  from profiles, work_orders, or photos to any shop/tenant/location table.**
- **Helper functions present:** only `is_active_user()` and `is_shop_owner()`,
  and both are the **pre-tenant** definitions — they read `profiles` by
  `auth.uid()` and check `role`/`active`. `is_shop_owner()` means
  "role = shop_owner AND active" — it does **not** resolve *which* shop.
- **Absent functions:** `current_user_shop_id`, `is_active_shop_member`,
  `row_in_current_shop`, `set_active_shop`, plus all three Section 21 storage
  helpers. Confirmed not in the live DB.

## 3. Evidence: what the migration file expects (Section 20)

The file's Section 20 builds a full tenant layer the live DB lacks:

- **New tables:** `public.shops`, `public.shop_locations`,
  `public.shop_memberships` (`profile_id, shop_id, role, is_active,
  default_location_id`), `public.platform_admins`.
- **New column on `profiles`:** `active_shop_id`.
- **New columns on `work_orders`:** `shop_id` **and** `location_id`
  (added in the 20 backfill `DO` block — the same block that also references
  `shops.slug` and enforces single-shop).
- **`shop_id` stamped onto** `work_order_photos` and the other tenant tables via
  a `set_tenant_shop_id` trigger.
- **Redefined helpers** so every Section 1–19 policy becomes shop-scoped:
  `current_user_shop_id()` (reads `profiles.active_shop_id` +
  `shop_memberships`), `row_in_current_shop()`, shop-scoped `is_shop_owner()` /
  `is_active_user()`.

**Section 21's storage policies call `row_in_current_shop(wo.shop_id)`** — which
requires *both* `work_orders.shop_id` *and* the membership-driven
`current_user_shop_id()`. Neither exists live. Hence the failure at the first
function-body validation.

## 4. The intended authorization path (from the file) vs. live

**Intended (file):**
```
auth.uid()
  → profiles.active_shop_id  (validated against shop_memberships)
  → current_user_shop_id()
  → work_orders.shop_id  == current shop        (row_in_current_shop)
  → work_order_photos (shop via WO)             (storage wop:* policies)
```
**Live:** none of the middle links exist. The only provable path today is
`auth.uid() → profiles → work_orders.created_by/assigned_mechanic`. There is
**no shop dimension**, so there is currently **no tenant boundary to enforce** —
every authenticated, active user is effectively in one global shop.

## 5. Why the two earlier failures were the same root cause

- **`slug` error** — Section 20 backfill assumed `shops.slug`; live `shops`
  (if it even exists as the file expects) doesn't have it. First symptom of "the
  file is ahead of production."
- **`wo.shop_id` error** — Section 21 assumed the Section 20 columns/helpers
  were already in place. Same root cause: **Section 20 was never run** (or ran
  only partially long ago under a different shape).

## 6. Which of the three drift possibilities is true

You asked to distinguish: never applied / different names / file drifted.

- **Different names?** No — the tenant-key search found no alternately-named
  shop/tenant/location columns on the core tables. Ruled out.
- **File drifted from production?** Partially true as a *description*, but the
  concrete finding is stronger:
- **Never applied.** The Section 20 tables, `profiles.active_shop_id`,
  `work_orders.shop_id/location_id`, and every membership-aware helper are all
  absent, while the *pre-tenant* helpers remain. That is the signature of a
  Section 20 migration that **never successfully ran** against this database.

  ⚠️ One open item to confirm read-only: whether `public.shops`,
  `public.shop_memberships`, `public.shop_locations`, `public.platform_admins`
  exist *at all* (empty shells) or are entirely absent. Run:
  ```sql
  select table_name from information_schema.tables
  where table_schema='public'
    and table_name in ('shops','shop_locations','shop_memberships','platform_admins');
  select column_name from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='active_shop_id';
  ```
  Whichever they are changes only *how much* of Section 20 must run, not the
  conclusion that Section 21 cannot proceed yet.

---

## 7. Minimum path before private storage is safe (plan, not SQL)

Private storage **must wait** behind a correctly-applied tenant foundation.
Recommended order — each is its own reviewed step, no executable SQL proposed
here yet:

1. **Decide the source of truth.** Confirm whether multi-tenancy is actually
   wanted on this database now, or whether this instance is intentionally
   single-shop. If single-shop, Section 21 should be **rewritten** against the
   real model, not forced onto an absent one.

2. **If multi-tenant is intended — apply a corrected Section 20 first**, fixed to
   match the live starting point:
   - drop the `shops.slug` assumption (or add `slug` deliberately);
   - create `shops` / `shop_locations` / `shop_memberships` / `platform_admins`
     if absent;
   - add `profiles.active_shop_id`, `work_orders.shop_id` + `location_id`,
     `work_order_photos.shop_id`;
   - seed exactly one shop + memberships for existing users, backfill
     `work_orders.shop_id`;
   - install the membership-aware helpers (`current_user_shop_id`,
     `row_in_current_shop`, shop-scoped `is_shop_owner`/`is_active_user`).
   Verify the full auth path resolves for a real user **before** any storage work.

3. **Only then apply a Section 21** whose `row_in_current_shop(wo.shop_id)` now
   resolves — unchanged in intent, valid against the real schema.

4. **Then** the signed-URL frontend, surface tests, and the private-bucket flip
   per `DEPLOYMENT-PLAYBOOK.md`.

**Alternative if this DB is meant to stay single-shop:** Section 21's tenant
join is unnecessary; storage authorization would instead be keyed off
`work_orders` existence + active user (still DB-authoritative, still no
path-trust), and the bucket can still go private with signed URLs. This is a
*different, smaller* migration — but it changes the security model, so it needs
your explicit decision, not an assumption.

---

## 8. Guardrails honored

- No `shop_id` added blindly. No tenant check removed or weakened. No fallback to
  `created_by` / `assigned_mechanic` / `shop_serial_label_options.shop_id`.
- No executable SQL proposed, no live change, no bucket visibility change.
- Section 21 will **not** be re-run until the auth path is proven live.

**Decision needed from you:** is this database intended to be **multi-tenant**
(→ fix & apply Section 20 first) or **single-shop** (→ rewrite Section 21 to the
real model)? I'll produce the corrected migration plan for whichever you choose.

---

## 9. Production truth for auth/onboarding (verified 2026-07)

Confirmed by read-only queries against production, and relied on by the
invitation-only onboarding change (no migration was needed):

- **No `handle_new_membership()` function and no `on_profile_created_membership`
  trigger exist in production.** The "single-shop auto-enroll fallback" that
  appears in `supabase-schema.sql` is a repo/history artifact, **not live**.
  Do not create it. Profile-triggers on `public.profiles` are only
  `audit_profiles` and `guard_active_shop_id`.
- **`shop_memberships` already has `UNIQUE (profile_id, shop_id)`**
  (`shop_memberships_profile_id_shop_id_key`). Do not add another.
- **Verified live columns** (use only these): `shop_memberships(id, profile_id,
  shop_id, role, is_active, default_location_id, created_at)`;
  `shop_locations(id, shop_id, name, is_active, created_at)` \u2014 **no
  `is_primary`**. File-only columns `invited_by`, `approved_at`, and
  `shop_locations.is_primary` are history, not production.
- **Invariant:** membership is the sole grant of tenant access \u2014 no trusted
  membership row = no tenant access. Staff membership is created only by the
  server-side `invite_staff` path from a server-derived `shop_id`.
