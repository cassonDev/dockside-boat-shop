# MANIFEST — Section 20 release package

**Scope of this package:** apply the multi-tenant foundation (Section 20) only.
**Explicitly excluded:** Section 21 storage, the storage bucket flip, any
signed-URL frontend deploy, the purge worker, and any app-code change. No new
architecture was added to build this package.

## Important: what actually changes production
- **Committing these files to GitHub/Netlify changes nothing in the database and
  nothing in how the app behaves.** They are SQL + documentation.
- **The only production change in this pass is running
  `section-20-tenant-foundation.sql` by hand in the Supabase SQL Editor
  (Runbook Phase 6).** That is a manual, transactional, self-rolling-back step.

## Files in this package

| File | New / Modified | Purpose | Runs against prod? |
|---|---|---|---|
| `section-20-tenant-foundation.sql` | **Revised 2026-07-18** | The migration: tenant tables, helpers, backfill, shop-scoped RLS, V1–V8. | **Yes — manually, Phase 6.** |
| `OPERATOR-RUNBOOK-SECTION-20.md` | **New (this pass)** | The 10-phase step-by-step runbook for a non-technical operator. | No |
| `MANIFEST.md` | **New (this pass)** | This file. | No |
| `RUN-SECTION-20.md` | Existing (repo) | Short technical run notes (companion to the runbook). | No |
| `SECTION-20-PLAN.md` | Existing (repo) | Full plan: scope, migration order, §7 two-shop test, §8 rollback, §9 go/no-go gate. | No |
| `PHASE0-AND-FINDINGS.md` | Existing (repo) | Read-only findings, RLS-conflict rationale, work-order-ID investigation. | No |
| `LIVE-VERIFICATION-READONLY.md` | **New (this pass)** | The read-only live-verification query package (§0–§6). | Read-only only |
| `RECONCILED-LIVE-STATE.md` | **New (this pass)** | The verified live-vs-repo reconciliation (evidence the plan is based on). | No |

## Changelog
- **2026-07-18b — `section-20-tenant-foundation.sql` fix (block 20D, backfill):**
  the work-table `shop_id` backfill tripped the pre-existing BEFORE UPDATE guard
  `guard_work_order_edits` (`enforce_work_order_edits()` raises `account is not
  active` because the SQL-editor migration has no `auth.uid()`). Backfill is now
  split into 20D-2/3/4: temporarily disable USER triggers on ONLY the 9 backfill
  tables (table- and transaction-scoped), backfill, then re-enable before commit.
  No RLS touched, no trigger dropped, app authorization unchanged. Runbook Phase 6
  failure B documents this + a read-only trigger-discovery query covering every
  trigger on the updated tables (not one at a time).
- **2026-07-18 — `section-20-tenant-foundation.sql` fix (block 20D step 4):** the
  `active_shop_id` backfill previously updated ALL profiles, which raised
  `P0001` from `enforce_active_shop_id()` on the first inactive profile (inactive
  membership). Now it sets `active_shop_id` only for profiles with an **active**
  membership in the seed shop; inactive profiles keep `active_shop_id = NULL`.
  The guard was **not** disabled or weakened. Runbook Phase 6 documents this
  exact failure + a read-only rollback-verification block.

## Known documentation caveat (no code change made)
`SECTION-20-PLAN.md` §4 step 2 / §10 item 2 state the migration "never drops or
replaces" existing policies. That summary is **out of date**: the actual SQL
(block 20F) and `RUN-SECTION-20.md` **do** drop the known pre-tenant baseline and
replace it with shop-scoped policies — which is the correct, verified behavior
(this is why V7b must return 0). The SQL is authoritative. Flagged, not changed.

## Verification status baked into this package
Live production was confirmed read-only before packaging:
- Section 20 is **not** applied live (tenant tables + helpers absent).
- Bucket `work-order-photos` is **public**; storage policies are pre-tenant.
- Every affected table's live RLS is pre-tenant (no `row_in_current_shop`).
Full evidence: `RECONCILED-LIVE-STATE.md`.

## Not included (deliberately)
`section-21-storage.sql`, `STORAGE-PRIVACY.md`, `VERIFICATION.md`,
`DEPLOYMENT-PLAYBOOK.md`, `scripts/storage-inventory-and-classify.js`,
`supabase-client.js`, `index.html`, and all other app files — they belong to the
Section 21 storage pass, which stays blocked.
