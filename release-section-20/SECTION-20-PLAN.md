# Section 20 Tenant-Foundation — Corrected Migration Plan

**Decision recorded: this database is the production multi-tenant foundation.**
This plan introduces the tenant layer the live DB is missing, backfills all
existing data into the initial tenant **Lessard Marine Works**, and defines the
exact gate that must pass **before** Section 21 (private storage) may run.

**Nothing is executed. Review the plan + `section-20-tenant-foundation.sql`
first.** Section 21 is deliberately still separate and **must be re-reviewed**
against this corrected foundation — not assumed valid.

---

## 1. What changed vs. the original (broken) Section 20

| Original assumption | Reality | Correction |
|---|---|---|
| `shops.slug` exists | live `shops` has no such column | **`slug` removed entirely** from table + seed |
| Section 20 already applied | it was **never applied** | full foundation built from the live pre-tenant shape |
| `work_orders.shop_id` present | absent | added NULL → backfilled → set NOT NULL |
| helpers are shop-scoped | live helpers are pre-tenant zero-arg | redefined membership-aware, backward-compatible |
| seed shop found by slug/name | n/a | seed by **name = 'Lessard Marine Works'**, idempotent |

## 2. Tables receiving tenant ownership

Confirmed against the live table list:
- **New:** `shops`, `shop_locations`, `shop_memberships`, `platform_admins`.
- **`profiles`** → `active_shop_id` (pointer; ownership lives in memberships).
- **`work_orders`** → `shop_id` + `location_id`.
- **Child tables** (backfilled from their parent WO): `work_order_photos`,
  `work_order_comments`, `activities`, `work_order_serial_numbers` → `shop_id`.
- **`shop_serial_label_options`** → existing nullable `shop_id` backfilled.
- **Now tenant-scoped (per approved isolation-scope decision):**
  - **`role_change_requests`** → `shop_id`, **NOT NULL**, strict stamp + full
    row-isolation RLS. A role-change request belongs to exactly one shop.
  - **`audit_log`** → `shop_id`, **NULLABLE** (append-only), **lenient** stamp,
    **SELECT-only** shop-read RLS. Rationale: the audit log is written by
    `SECURITY DEFINER` triggers in many contexts; blocking a write because a
    shop can't be resolved would break the base operation and defeat an
    append-only audit trail. Legacy NULL-shop rows are visible to platform
    admins only, so nothing leaks cross-tenant.
  - **`activity_history`** → `shop_id`, **NULLABLE** (append-only), **lenient**
    stamp, backfilled from its parent `activities.shop_id`, full-command RLS
    scoped to shop (NULL legacy rows platform-admin only). Same append-only
    rationale as audit_log.
- **Nothing left ambiguous:** every table above is explicitly either
  tenant-scoped (strict or lenient) or documented as platform-scoped.

## 3. Proven authorization path this establishes

```
auth.uid()
  → shop_memberships (is_active)                     ← active membership
  → profiles.active_shop_id / resolved default       ← current_user_shop_id()
  → work_orders.shop_id == current shop              ← row_in_current_shop()
  → work_order_photos.shop_id (stamped from WO)      ← per-row RLS
```
Every link now exists in the schema, so Section 21's
`row_in_current_shop(wo.shop_id)` will resolve.

## 4. Migration order (single transaction)

0. **Phase 0 reconciliation (read-only, run SEPARATELY first)** — per-table row
   counts + backfill projection (`rows` / `to_backfill` / `after_backfill`) for
   profiles, work_orders, activities, photos, comments, serial numbers, audit_log,
   activity_history, role_change_requests; plus a full inventory of existing RLS
   policies on all affected tables for manual baseline comparison. **No schema
   change.** This is the manual review gate before execution.
1. **Preflight** — `DO` block RAISES and aborts unless the live schema is the
   expected pre-tenant shape (warns — not aborts — if `work_orders.id` isn't text,
   since the PK is preserved either way).
2. **RLS-policy guard** — `DO` block ABORTS if any of the NEW isolation policy
   names already exist on the affected tables (partial prior run / clash). The
   migration **never drops or replaces** any existing section 1–19 policy — it
   only creates new, distinctly-named policies.
3. **20A** — create tenant tables (no slug) + `profiles.active_shop_id`.
4. **20B** — add NULL `shop_id`/`location_id` columns (incl. audit_log,
   activity_history, role_change_requests).
5. **20C** — membership-aware helpers + **strict** and **lenient** stamp
   functions + triggers + `set_active_shop`.
6. **20D** — seed Lessard Marine Works + one location, enroll all profiles,
   backfill every tenant table (children from parents; audit/rcr to seed shop).
   Idempotent.
7. **20E** — validation `DO` blocks RAISE if any **strict** table row is
   unstamped (audit_log/activity_history reported but allowed NULL) → lock
   `NOT NULL` on strict tables, add indexes, install stamp triggers (strict for
   app tables, lenient for append-only).
8. **20F** — **replace** the permissive pre-tenant policy baseline with
   shop-scoped (`row_in_current_shop`) policies on every affected table
   (audit_log + activity_history are SELECT-only, append-only). A guard RAISES
   first if any **unknown** policy exists on those tables.
9. **Verification** (read-only V1–V8) after commit.

> **CRITICAL (see PHASE0-AND-FINDINGS.md §2):** the live pre-tenant policies are
> permissive with **no per-row shop predicate**. Because RLS policies are OR-ed,
> leaving them beside the new tenant policies would **bypass isolation**. Section
> 20 therefore **drops and replaces** them (strengthening, not weakening) and
> **hard-stops** on any policy name outside the known baseline.

**IDs and data preserved:** no `id` is rewritten; only new columns are populated.
All existing work orders, photos, comments, activities, serials keep their keys.

## 4b. Work-order IDs — preserved, not redesigned

Per the approved direction, **`work_orders.id` is left exactly as-is.** We do NOT
redesign primary keys or introduce shop-scoped IDs. Authorization relies on
**`shop_id` + `work_orders.id`**, never on the identifier strategy. Note for the
record: the live `id` is a short **TEXT** job code (globally unique today), not a
uuid; the plan preserves it. If uuid PKs are ever wanted, that is a separate,
explicit migration — out of scope here. The preflight only *warns* on the id
type; it does not abort or alter it.

## 5. Read-only preflight (run BEFORE, outside the migration)

```sql
-- Are the tenant tables absent or empty shells?
select table_name from information_schema.tables where table_schema='public'
  and table_name in ('shops','shop_locations','shop_memberships','platform_admins');
select 'shops' t, count(*) from public.shops        -- errors if table absent (expected)
 union all select 'memberships', count(*) from public.shop_memberships;

-- Confirm the missing columns really are missing.
select table_name, column_name from information_schema.columns
where table_schema='public'
  and ((table_name='profiles' and column_name='active_shop_id')
    or (table_name='work_orders' and column_name in ('shop_id','location_id')));

-- Current helper definitions (confirm still pre-tenant).
select proname, pg_get_functiondef(oid) from pg_proc
where proname in ('is_active_user','is_shop_owner');

-- How many rows will be backfilled?
select (select count(*) from public.profiles) profiles,
       (select count(*) from public.work_orders) work_orders,
       (select count(*) from public.work_order_photos) photos;
```
If the tenant tables **exist and contain rows**, STOP — this is not a clean
never-applied state and the seed/backfill must be re-examined.

## 6. Post-migration verification

Run V1–V8 (read-only, AFTER commit — not inside the tx):
- V1: 4 tenant tables. V2: helpers present (`is_service_advisor` should be GONE).
  V3: `shop_id` NOT NULL on strict work tables. V4: 1 shop, memberships ==
  profiles. V5: zeros. V6: **9** stamp triggers. V7: **11** shop-scoped policies.
  **V7b: 0** permissive pre-tenant policies remain. **V7c:** audit_log +
  activity_history SELECT-only. **V8:** new audit/history rows stamp non-null
  `shop_id`.

## 6b. Execution order (single transaction)

1. Backup DB (Phase 1.4). 2. Run PHASE 0 report + the item 1–5 confirmation
queries (read-only) — confirm `is_service_advisor` absent and the diff query
returns **0 rows**. 3. Run `section-20-tenant-foundation.sql` from `begin;` to
`commit;` as **one transaction** (Supabase SQL editor runs a script as one tx;
the explicit `begin/commit` makes it unambiguous). The in-file guard aborts the
whole tx if the live inventory differs. 4. Run V1–V8. 5. Run the §7 isolation
tests in staging. Each step is a hard stop.

## 7. Two-shop isolation test plan (MUST pass before Section 21)

Create a **temporary second shop** in a staging copy (never seed a real second
tenant in prod just to test):

1. Insert `shops('Test Shop B')` + a location; enroll a **Test User B** via
   `shop_memberships`; set their `active_shop_id`. Seed ≥1 work order, photo,
   comment, activity, serial number, and (if applicable) role-change request +
   audit rows under **each** shop.
2. As **User A** (Lessard): each of these returns **only Lessard rows**:
   `work_orders`, `work_order_photos`, `work_order_comments`, `activities`,
   `work_order_serial_numbers`, `audit_log`.
3. As **User B**: the same six queries return **only B's rows** — confirm A
   **cannot view** B's: work orders, photos, serial numbers, comments, **audit
   logs**. (activity_history likewise scoped.)
4. **UUID / id-enumeration test (REQUIRED before Section 21):** as **User B**,
   supply a **valid identifier from Shop A** directly and confirm every one is
   denied / returns 0 rows — not found via the tenant boundary, even though the
   id is real:
   - `select * from work_orders where id = '<A work_order id>';` → 0 rows
   - `select * from work_order_photos where id = '<A photo uuid>';` → 0 rows
   - `select * from work_order_serial_numbers where id = '<A serial uuid>';` → 0
   - `select * from work_order_comments where id = '<A comment uuid>';` → 0
   - `select * from activities where id = '<A activity uuid>';` → 0
   - `update work_orders set customer_name='x' where id='<A work_order id>';` →
     0 rows affected
   - attempt to insert a photo/comment naming `<A work_order id>` → stamped to
     B's shop (or rejected), **never** written into A's shop.
5. `select public.current_user_shop_id();` returns the correct distinct shop for
   each user.
6. `set_active_shop(<other shop>)` for a non-member → RAISES.
7. Tear down Test Shop B in staging. **Gate: every assertion above passes,
   including the UUID-enumeration test.**

## 8. Rollback plan

Because 20 runs in one transaction, a failure mid-run rolls back automatically.
If a committed migration must be reverted (staging, or emergency):

- **Drop the additions in reverse:** the isolation policies (all 10 new names) →
  `stamp_shop_id` triggers (9 tables) → indexes → `NOT NULL` (back to nullable)
  → the added `shop_id` / `location_id` / `active_shop_id` columns (incl.
  audit_log, activity_history, role_change_requests) → tenant tables
  (`platform_admins`, `shop_memberships`, `shop_locations`, `shops`) → restore
  the pre-tenant zero-arg `is_active_user()`/`is_shop_owner()` definitions → drop
  the strict + lenient stamp functions and `set_active_shop`.
- **Preferred for production:** restore from the pre-migration backup (Phase 1.4)
  rather than hand-reverting — cleaner and avoids helper-redefinition drift.
- No storage bytes or bucket settings are touched by Section 20, so there is
  nothing storage-side to roll back here.

## 9. Go / No-Go gate before Section 21

**Scope statement (read aloud at the gate):**
- Section 20 is safe for the **current Lessard Marine Works tenant only**.
- **Temporary two-shop TEST tenants** may be created in staging for isolation
  verification.
- **No second REAL shop may be onboarded** until the work-order identifier
  migration (PHASE0-AND-FINDINGS.md §3, Option 2) is designed, implemented, and
  tested.
- **Section 21 (private storage) remains BLOCKED** until Section 20 verification
  (V1–V8) and the two-shop isolation tests all pass.

Proceed only if all are true:

- [ ] Phase 0 report reviewed; counts and existing-policy inventory expected.
- [ ] Preflight + RLS-policy guard passed; migration committed with no RAISE.
- [ ] V1–V8 all match expected — including **V7b (zero permissive policies
      remain)**, **V7c (audit/history append-only)**, and **V8 (audit/history
      tenant-stamping)**.
- [ ] Two-shop isolation test (§7) — every assertion passed in staging,
      **including the UUID/id-enumeration test**.
- [ ] `current_user_shop_id()` returns the right shop for a real Lessard user.
- [ ] **Work-order ID verdict recorded = Option 2 (global uniqueness NOT
      proven):** current single shop proceeds; **onboarding additional shops is
      BLOCKED** until a separate identifier migration is designed and tested
      (see PHASE0-AND-FINDINGS.md §3). IDs are preserved; PK unchanged.
- [ ] Existing app still works read/write under the new RLS (smoke test:
      open a job, add a comment, upload a photo — all succeed for a Lessard user).
- [ ] Pre-migration backup retained.

**Then and only then:** re-review `section-21-storage.sql` against this
foundation (do **not** assume it is unchanged — re-confirm `work_orders.shop_id`,
`row_in_current_shop`, and the `wop:*` policy joins resolve), apply it public,
run signed-URL + surface + isolation tests, and finally flip the bucket private
per `DEPLOYMENT-PLAYBOOK.md`.

---

## 10. Open items flagged for your call

1. **Tenant-scope decisions applied (no longer ambiguous):** `role_change_requests`
   strict tenant-scoped; `audit_log` + `activity_history` lenient tenant-scoped
   (append-only, nullable, platform-admin sees legacy NULL rows). Confirm you
   accept the append-only lenient treatment vs. strict NOT NULL.
2. **Existing section 1–19 RLS policies** live in the DB already; the migration
   does **not** touch them (new policy names only) and the RLS-policy guard
   aborts on any name clash. Review the Phase 0 policy inventory so the new
   per-row isolation policies don't unintentionally stack with an existing
   policy of the same intent under a different name.
3. **`work_orders.id` preserved** as the existing short TEXT code (§4b). Confirm
   cross-shop code collisions are acceptable (they don't break RLS, but the same
   code could exist in two shops and affects QR/URL lookups if those ever go
   cross-tenant).

**No execution performed. Awaiting your review of this plan and the SQL.**
