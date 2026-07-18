# Section 20 Tenant Foundation — Step-by-Step Run Instructions

Multi-tenant foundation. **Back up first. One transaction. Stop at each gate.**
Nothing here touches storage or the bucket. Section 21 stays blocked until this
passes.

---

## Step 0 — Back up (required)
Supabase Dashboard → Database → Backups → **create on-demand backup**. Note time.

## Step 1 — Phase 0 read-only checks (change nothing)
SQL Editor → run the **PHASE 0** block at the top of
`section-20-tenant-foundation.sql`. Save the row counts.

## Step 2 — Live confirmations (change nothing)
Run the **item 1–5 queries** from `PHASE0-AND-FINDINGS.md`:
- `is_service_advisor()` → expect **0 rows** (dropped in §19).
- The **diff query (#3+4)** → must return **0 rows**. ⚠️ If it returns ANY row,
  **STOP** — an unknown policy needs manual review; do not run the migration.

## Step 3 — Run the migration (one transaction)
SQL Editor → paste the **whole** `section-20-tenant-foundation.sql` from
`begin;` to `commit;` → **Run**.
- The guard aborts and rolls back everything if the live policy set differs.
- ⚠️ Use this file — **NOT** the full `supabase-schema.sql` (that one has the
  `slug` bug and re-runs old sections).
- Expect `NOTICE` lines: PREFLIGHT OK, RLS GUARD OK, SEED OK, BACKFILL VALIDATED.

## Step 4 — Verify (change nothing)
Run **V1–V8** at the bottom of the file. Expected:
- V1: 4 tables · V4: 1 shop, memberships = profiles · V5: zeros · V6: 9 triggers
- V7: 11 shop-scoped policies · **V7b: 0** old permissive policies left
- V7c: audit_log + activity_history SELECT-only · V8: new rows get shop_id

## Step 5 — Two-shop isolation test (staging)
Follow `SECTION-20-PLAN.md` §7, including the **UUID/id-enumeration** test
(User B supplies a real Shop A id → 0 rows / denied). All must pass.

## Step 6 — App smoke test
As a Lessard user: open a job, add a comment, upload a photo — all succeed.

---

## If anything fails
The transaction rolls back on its own (no partial changes). If a committed run
must be reverted, **restore the Step 0 backup** (cleanest). Details in
`SECTION-20-PLAN.md` §8.

## Hard limits (do not cross)
- Safe for **Lessard Marine Works only**.
- Test tenants OK for isolation checks; **no second real shop** until the
  work-order ID migration is done (`PHASE0-AND-FINDINGS.md` §3).
- **Section 21 / private storage stays blocked** until Steps 4–6 pass.

Do not deploy app code or change bucket visibility in this pass.
