# Staging → Production Promotion Package

**Date:** 2026-07-22 · **Goal:** bring production fully up to the current staging
version in one clean promotion, without copying any staging data.

> ⚠️ **Read this before running anything.** Do **not** run the migration just
> because it says "production." Run **`01-PROD-PREFLIGHT.sql`** first and send the
> output back. The migration is idempotent and safe, but the preflight confirms
> what production already has so we only add what is genuinely missing.

---

## 0. The one thing to understand first

The repo contains **two different representations** of the schema, and they do
not match:

| | Trigger name | Policy shape | `forbid_shop_change` |
|---|---|---|---|
| `section-20-tenant-foundation.sql` **(what the live DBs actually ran)** | `stamp_shop_id` | coarse `"<x>: shop isolation"` FOR ALL | **not created** |
| `supabase-schema.sql` **(idealized; NOT deployed)** | `set_shop_id` | granular per-command | created |

**Production and staging both follow the `section-20` lineage.** This package is
built against that lineage. **Do NOT apply `supabase-schema.sql` to production** —
it would create duplicate/renamed triggers and policies alongside the live ones.

---

## 1. What production already has (Section 20 foundation, applied ~2026-07-19)

4 tenant tables, the tenant helper functions, `shop_id` (NOT NULL) + `location_id`
on the tenant tables with backfill complete, `stamp_shop_id` insert triggers on 8
tenant tables, and the 11 Section 20 shop-isolation RLS policies. Bucket
`work-order-photos` is still **public**. The preflight re-confirms all of this
against the live DB rather than trusting this note.

## 2. What this promotion ADDS (the entire delta — see `02-PROD-MIGRATION.sql`)

- **A. Intake-transcript columns** on `work_orders` (`customer_concern`,
  `original_transcript`, `original_customer_concern`, `original_extraction`).
  Add-if-missing; a no-op if production already has them.
- **B. Section 21 private-storage objects** — 3 storage helper functions, the 4
  `wop:` shop-scoped `storage.objects` policies, 6 retention columns on
  `work_order_photos`, the purge index, and the read-only purge-candidate view.
  Also (flagged hardening) **drops the pre-tenant permissive storage policies**
  that the `wop:` set supersedes. The bucket stays **public** (the private flip
  is a later, separate deploy step).
- **C. Serial-label insert-stamp trigger** — adds the `stamp_shop_id` BEFORE
  INSERT trigger to `shop_serial_label_options`, which Section 20 omitted. This is
  the fix for the Shop Owner **"+ ADD LABEL" → "row violates row-level security
  policy"** error.

## 3. What is intentionally NOT promoted

- **Staging data.** No shops, users, memberships, work orders, locations, serial
  labels, or seed rows are copied. The migration is pure DDL and runs against
  production's own existing data. Section 20's starter serial-label defaults are
  only inserted on a *blank* table and are not part of this migration.
- **`forbid_shop_change` UPDATE guard.** Deployed Section 20 never created it and
  staging has not added it (the `section-21c` parity check was read-only; the
  decision was deferred). Adding it would diverge from staging. Cross-shop moves
  remain blocked by the RLS `WITH CHECK (row_in_current_shop(...))` on the
  isolation policies. **If preflight P4 shows `forbid_shop_change` unexpectedly
  present on other tenant tables, tell me** — that would change the recommendation.
- **The bucket public → private flip.** Separate deploy step after the signed-URL
  frontend is verified.
- **`supabase-schema.sql`** and all the Section 20 SQL/docs — already applied;
  not re-run.
- **The versioned working folders** (`invite-fix/`, `auth-offset-fix/`,
  `mobile-header-fix/`, `header-nav-fix/`, `serial-label-fix/`, `changed/`,
  `release-section-20/`) and `uploads/` — history/scratch, not deployable.

## 4. Code in this package (`code/`)

The current staging application runtime:

- `index.html`, `supabase-client.js`, `support.js`, `dockside-data.js`, `_redirects`
- `netlify/functions/*` (the deployed serverless functions) + their `package.json`
- `scripts/generate-config.js` (build step) + `scripts/storage-inventory-and-classify.js`
- `netlify.toml`, `package.json`

**Excluded from `code/`:** `config.js` (a local preview stub — production's
`config.js` is generated at build time by `generate-config.js` from the
`SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars; do not overwrite it). Env vars and
secrets (`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `SHOP_OWNER_BOOTSTRAP_CODE`)
must already be set in the production Netlify site — this package does not carry them.

The frontend change vs. the last app deploy of note: **mechanic assignment is now
optional at intake** (job saves as Unassigned; no auto-assign) — frontend only,
no DB change (`work_orders.assigned_mechanic` was already nullable).

---

## 5. Deployment order

- **A. Run `01-PROD-PREFLIGHT.sql`** in the production Supabase SQL Editor.
- **B. Send me the full P1–P12 output and review it.** Confirm: Section 20 present;
  intake columns present/absent; serial-label stamp trigger absent (P4b);
  Section 21 objects absent; and the storage-policy list (P10) so the hardening
  drops match the real names. I will confirm or adjust the migration before you run it.
- **C. Run `02-PROD-MIGRATION.sql`** in the production Supabase SQL Editor (single
  transaction; rolls back cleanly on any error).
- **D. Run `03-PROD-POST-VERIFICATION.sql`** and send the output. All V-blocks
  should meet their stated expectations (foundation intact + delta present).
- **E. Deploy the `code/` files to the production Netlify site** (push to the
  production branch / trigger the build). Confirm env vars are set and the build's
  `generate-config.js` step runs.
- **F. Smoke test production** (see below).

## 6. Production smoke test (after E)

1. Sign in as a shop owner. Open **Shop Config → serial labels → "+ ADD LABEL"** →
   adds successfully (no RLS error). This is the headline fix.
2. **New Job / AI intake** → save with **Unassigned** mechanic → job saves; then
   assign a mechanic from the work-order view → persists.
3. New Job with a mechanic selected → saves pre-assigned.
4. Upload a work-order photo and view it → still works (bucket still public).
5. Tenant isolation: in a second shop/session, confirm you see only your own
   shop's jobs, labels, and photos.
6. Confirm a mechanic account still cannot edit jobs / change roles outside its
   permissions (RLS unchanged).

---

## 7. Files

| File | Runs against prod? | Purpose |
|---|---|---|
| `01-PROD-PREFLIGHT.sql` | **Read-only** | Inventory prod's actual state. Run first. |
| `02-PROD-MIGRATION.sql` | **Yes (DDL, idempotent, transactional)** | The delta: A + B + C. |
| `03-PROD-POST-VERIFICATION.sql` | **Read-only** | Prove end state + foundation intact. |
| `code/` | Deploy via Netlify | Current staging application runtime. |
| `PROMOTION-README.md` | No | This file. |

**Nothing in this package has been run against production. No staging changes were
made in producing it.**
