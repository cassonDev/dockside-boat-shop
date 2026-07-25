# Section 25 — Production Release Package (FINAL)

Everything production needs for Section 25 (legal agreements, owner onboarding,
read-only Platform Admin, **existing-user agreement gate**) **and** for Shop
Configuration + Locations to load and save correctly. Consolidated from staging;
all earlier Section 25 bundles and the individual staging files
(`section-25*.sql`, `section-25.2*.sql`, `section-25.4*.sql`, `section-25.6*.sql`)
are **superseded** by the files in this folder — do **not** also run those.

Includes (folded in, no separate steps):
- **25.1** Shop Config prepopulation fix — in `index.html`.
- **25.5** existing-user agreement gate — in `index.html` + `supabase-client.js`
  (temporary staging diagnostics have been removed).
- **25.6** `grant select on legal_acceptances to authenticated` — folded into
  `01-…legal-and-platform-admin.sql` (the 403 fix).

## Contents

| File | What |
|---|---|
| `01-section-25-legal-and-platform-admin.sql` | Section 25 core: `legal_agreements` + `legal_acceptances`, seeded pilot agreement, `accept_legal_agreement`, `create_shop_as_owner`, platform read RPCs, `platform_admins`/`is_platform_admin` (idempotent), **and the corrected `grant select` on BOTH `legal_agreements` and `legal_acceptances` to `authenticated`** (25.1-grant + 25.6). |
| `02-section-25.2-and-25.3-shops-fixes.sql` | 25.2 additive `shops` columns (`legal_name, phone, email, address_line1, address_line2, city, region, postal_code, country, timezone, settings`) **+** 25.3 owner-scoped `shops` UPDATE RLS policy. Idempotent, one txn. |
| `03-section-25.4-shop-locations-fix.sql` | 25.4 additive `shop_locations` columns (`location_code, phone, email, timezone, is_primary, updated_at`) **+** owner-scoped RLS (`member read` SELECT, `owner insert` INSERT, `owner update` UPDATE). Idempotent, one txn. |
| `ROLLBACK-section-25-release.sql` | Reverses 25.4 → 25.3 → 25.2 → core, in safe order. |
| `index.html` | Frontend: owner onboarding, existing-user agreement gate (25.5, diagnostics removed), read-only Platform Admin area, and the 25.1 Shop Config prepopulation fix. |
| `supabase-client.js` | Frontend: legal/onboarding/platform client functions. |

> Note on 25.1: the Shop Config prepopulation fix was **frontend-only** and is
> already baked into `index.html` here. There is no separate 25.1 SQL.

## Exact deployment order

1. **Backup / PITR checkpoint** on production.
2. Run **`01-section-25-legal-and-platform-admin.sql`** (single transaction).
3. Run **`02-section-25.2-and-25.3-shops-fixes.sql`** (single transaction).
4. Run **`03-section-25.4-shop-locations-fix.sql`** (single transaction).
5. Run the verification queries at the bottom of each SQL file.
6. **Seed the production platform admin** (one row, out-of-band — there is no UI):
   ```sql
   select id, email, full_name from public.profiles where email = 'REPLACE_ADMIN_EMAIL';
   insert into public.platform_admins (profile_id, is_active)
   values ('REPLACE_PROFILE_ID', true)
   on conflict (profile_id) do update set is_active = true;
   ```
7. **Deploy the frontend**: `index.html` + `supabase-client.js`.
8. **Production smoke test** (below).

Rollback at any point: run `ROLLBACK-section-25-release.sql` (read its warnings —
dropping 25.2 columns and the legal tables is destructive) and redeploy the prior
frontend.

## Production smoke test (must all pass)

- [ ] Shop Configuration **loads** existing values (Shop Name prefilled).
- [ ] Shop Configuration **saves**; **refresh** reloads saved values.
- [ ] **Branding** saves; **Features** save (both use `shops.settings`).
- [ ] **Locations** still load and edit; **create / edit / deactivate / reactivate** a location persists across refresh (25.4).
- [ ] **Team** still works (roster, role, active/inactive).
- [ ] **Platform Admin** still works (admin sees shops; non-admin cannot).
- [ ] **Onboarding** works for a fresh user with no shop (agreement → create shop).
- [ ] **Tenant isolation** unchanged (a shop only sees its own data).
- [ ] **Existing user without acceptance** (owner, mechanic, and platform admin) is stopped at the agreement gate; accepting returns them to their existing shop with role/data intact; already-accepted users skip it (25.5/25.6).
- [ ] **Mechanics cannot edit shop information** (owner-scoped UPDATE policy; a
      mechanic `shops` UPDATE affects 0 rows).

## Why 25.2 + 25.3 + 25.4 are all required

Section 20 shipped `shops` with only `(id, name, is_active, created_at,
updated_at)` and a single `"shops: member read"` SELECT policy, and shipped
`shop_locations` with `(id, shop_id, name, is_active, created_at)` and **no**
policy. The frontend was written against the richer `supabase-schema.sql` shape.
**25.2** adds the missing `shops` columns; **25.3** adds the missing `shops`
UPDATE policy (without it the owner's save is RLS-denied even after the columns
exist); **25.4** does the identical fix for `shop_locations` (missing columns +
missing read/insert/update policies). None weaken isolation: every write policy
is `is_shop_owner(id/shop_id)` only; mechanics stay read-only.
