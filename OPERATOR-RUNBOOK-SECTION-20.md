# OPERATOR RUNBOOK — Section 20 (Tenant Foundation)

> ## ⚠ STATUS 2026-07-19 — ALREADY APPLIED. DO NOT RUN PHASES 1–6.
> Section 20 is **fully applied and verified in production** as of 2026-07-19.
> One of the Phase 6 runs previously believed to have rolled back actually
> **committed** — the earlier "both attempts rolled back completely" conclusion
> was **incorrect**. **Do NOT re-run the migration** (`section-20-tenant-
> foundation.sql`) against production; re-running would collide with the live
> objects. Phases 1–7 are effectively complete.
>
> **Verified live 2026-07-19:** 4 tenant tables · 7 helper functions · 9
> stamp/guard triggers · 11 shop-isolation policies · strict `shop_id` columns
> `NOT NULL` · backfill complete (zero unstamped strict rows) · old permissive
> policies gone · new shop-scoped isolation policies active · all backfill-
> disabled triggers re-enabled (zero left disabled).
>
> **Remaining work only:** Phase 8 (two-shop isolation test, incl. the
> id-enumeration test) · Phase 9 (live smoke test) · Phase 10 (hard stop /
> Section 21 go/no-go). Start at Phase 8.

**Who this is for:** a careful operator who is NOT a database expert.
**What it does:** adds multi-tenant isolation to the live database and moves all
existing data into the one shop, **Lessard Marine Works**. It does **not** touch
photos, the storage bucket, or Section 21.

## The three rules
1. **Phases 1–7 are already COMPLETE (see the 2026-07-19 status banner above).**
   Do **not** re-run them. Your current starting point is **Phase 8**. Phases 1–7
   below are preserved as a HISTORICAL RECORD of what was done, not as a to-do
   list.
2. **Every phase has a PASS line and a STOP line.** For the historical Phases 1–7
   these record the outcome that was reached; for the live Phases 8–10 they are
   the real gates — if you see a STOP condition there, do not continue, save
   what's on screen and get help.
3. **This runbook never runs Section 21.** Phase 10 is a hard stop.

---

# ═══ HISTORICAL RECORD — PHASES 1–7 (COMPLETED, DO NOT RE-RUN) ═══

> Everything from here down to "CURRENT STARTING POINT" describes work that has
> **already been carried out and verified** against production. It is kept for
> the audit trail — the failed attempts, the fixes, and the final verification
> that established Section 20 committed successfully. **Do not execute any SQL in
> this historical block against production.** All SQL below is reference/diagnostic
> only; it is not a current next step.
>
> **What actually happened:** Section 20 was applied via Phase 6. Two earlier
> Phase 6 attempts failed on pre-existing BEFORE UPDATE triggers and were
> believed to have rolled back. A later run committed. Live-state verification on
> 2026-07-19 (NOT NULL locks on all strict `shop_id` columns, 11 isolation
> policies, old policies gone, no stranded disabled triggers) proved the apply is
> complete and consistent. The "both attempts rolled back" belief was incorrect —
> one run committed.

You will use two places:
- **Supabase Dashboard** → its **SQL Editor** (for database steps).
- **GitHub** and **Netlify** (for the code steps).

When a step says "paste and Run", paste into the Supabase SQL Editor and click
the green **Run** button. "0 rows" means the results panel says *No rows* /
returns nothing. Copy the results panel to a note after each phase.

---

## PHASE 1 — Backup ✅ COMPLETED (HISTORICAL — do not re-run)

*Historical record of the pre-migration backup step.*

1. Supabase Dashboard → left sidebar **Database** → **Backups**.
2. Click **Create backup** (on-demand). Wait until it shows as complete.
3. Write down the backup name and the time.

**PASS:** a completed backup with a timestamp you recorded.
**STOP:** backup fails or you cannot create one. Do not go further — everything
below depends on being able to restore this.

---

## PHASE 2 — Phase 0 read-only checks ✅ COMPLETED (HISTORICAL — reference only)

Open `section-20-tenant-foundation.sql`. At the very top is a block labelled
**PHASE 0 — RECONCILIATION REPORT**. It has two queries (0.1 and 0.2).

1. Paste **query 0.1** (the row-count block) and Run.
   - **PASS:** for every table, `to_backfill` equals `rows`, and
     `after_backfill` equals `rows` (no rows lost). Save the numbers.
   - **STOP:** any table shows `after_backfill` less than `rows`.

2. Paste **query 0.2** (the existing-policy inventory) and Run.
   - **PASS:** the policy names all look like the known list you already
     verified (the `photos: …`, `work_orders: …`, `serial_numbers: …`, etc.
     pre-tenant names).
   - **STOP:** any policy name you do not recognize appears.

**Note:** the tenant tables (`shops`, `shop_memberships`, …) do **not** exist yet
— that is expected and correct at this point.

---

## PHASE 3 — Confirm the policy diff returns 0 rows ✅ COMPLETED (HISTORICAL — reference only)

This proves there are no surprise policies that would make the migration unsafe.
Paste this **exactly** and Run:

```sql
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
  and policyname not in (
    'profiles: shop_owner full access','profiles: self read','profiles: self update limited',
    'profiles: service_advisor update availability',
    'work_orders: shop_owner full access','work_orders: mechanic read active',
    'work_orders: mechanic update own','work_orders: mechanic insert',
    'work_orders: service_advisor full access','work_orders: staff update shop',
    'comments: shop_owner full access','comments: read active','comments: insert own',
    'photos: shop_owner full access','photos: read active','photos: advisor insert any job',
    'photos: mechanic insert own job','photos: uploader update own','photos: advisor curate any',
    'photos: staff insert any job','photos: staff curate any',
    'activities: shop_owner full access','activities: read active','activities: insert own',
    'activities: author, advisor, or shop_owner update','activities: author or shop_owner update',
    'activity_history: read active','activity_history: insert own',
    'serial_numbers: shop_owner full access','serial_numbers: read active',
    'serial_numbers: insert own','serial_numbers: creator or advisor update','serial_numbers: staff update any',
    'audit_log: shop_owner read only',
    'role_requests: shop_owner full access','role_requests: self read','role_requests: self insert',
    'serial_labels: shop_owner full access','serial_labels: read all'
  )
order by tablename, policyname;
```

**PASS:** the result is **0 rows** (No rows).
**STOP:** **any** row comes back. That is an unknown/custom policy. Do not run the
migration — the migration's own guard would abort anyway, but stop here first and
get it reviewed.

---

## PHASE 4 — Update GitHub `main` with the approved files ✅ COMPLETED (HISTORICAL)

Use the ZIP you were given (`release-section-20.zip`). It contains only the
approved files — nothing else. **No app code changes ship in this pass.**

1. Unzip it.
2. In GitHub, on the **main** branch, add/update the files with the ones from the
   ZIP (drag-and-drop upload, or your normal commit process). The files are
   listed in `MANIFEST.md`.
3. Commit to **main** with a message like `Section 20 tenant foundation + runbook`.

**PASS:** the commit appears on `main` and GitHub shows the files present.
**STOP:** you accidentally committed to a different branch, or extra files you
don't recognize were added. Undo and redo cleanly.

> These files are documentation + the migration SQL. **Committing them does not
> change the database or the live site by itself.** The database only changes in
> Phase 6 when you run the SQL by hand.

---

## PHASE 5 — Confirm the Netlify deploy is healthy ✅ COMPLETED (HISTORICAL)

1. Netlify Dashboard → your site → **Deploys**.
2. Look at the top **Published** deploy.

**PASS:** the latest deploy state is **Published / Ready**, its branch is
**main**, and its commit matches the commit you just made in Phase 4.
**STOP:** the deploy shows **Failed**, is stuck **Building**, or is from a
different branch/commit. Do not run the migration until the site is healthy on
the intended commit.

> Nothing about the app's behavior should change from this deploy — these are
> docs/SQL files. You are only confirming the site is healthy and on the right
> commit before touching the database.

---

## PHASE 6 — Run `section-20-tenant-foundation.sql` ✅ COMPLETED (HISTORICAL — already applied, DO NOT RE-RUN)

> **This step has already been performed and committed. Do NOT run the migration
> again — re-running would collide with the live tenant objects.** The text below
> is the historical procedure and the diagnostics that were used while
> investigating the two failed attempts. All SQL in this phase is
> reference/diagnostic ONLY.

This was the one step that changed the database. It ran as a single all-or-
nothing transaction: if anything is wrong, it undoes itself completely.

1. Open `section-20-tenant-foundation.sql`.
2. Select **only** the part from the line `begin;` down to the line `commit;`
   (inclusive). **Do not** include the PHASE 0 block at the top or the
   verification block at the bottom.
3. Paste that into the SQL Editor and Run.

**PASS:** it completes and you see these NOTICE messages in the output (in order):
`PREFLIGHT OK`, `RLS GUARD OK`, `SEED OK`, `BACKFILL GUARD: user triggers
temporarily disabled…`, `BACKFILL OK`, `BACKFILL GUARD: user triggers
re-enabled…`, `BACKFILL VALIDATED`.
**STOP:** any red error, or any message containing `PREFLIGHT:`, `RLS GUARD:`, or
`BACKFILL INCOMPLETE`. The transaction has already rolled itself back — nothing
was changed. Save the full message and get it reviewed. Do not re-run blindly.

> Use this file **only** — not `supabase-schema.sql` (that one has a known bug).

### Known failure conditions in Phase 6 (HISTORICAL — what happened during the two failed attempts)

> These two failures were **observed and resolved** during the applied run. They
> are recorded for the audit trail. They are not a checklist to work through now
> — Section 20 is already applied.

**A) `ERROR: P0001: Cannot set active shop to one you are not an active member of`**
(from `enforce_active_shop_id()`, during the profiles `active_shop_id` backfill).
- **What it means:** you are running an **old** copy of the SQL. The corrected
  file (dated 2026-07-18) only sets `active_shop_id` for profiles that have an
  **active** membership, so this error no longer occurs. The failed run has
  **already rolled itself back** — nothing was applied.
- **Do:** (1) run the **rollback-verification block** below and confirm every
  count is `0` / `pre-tenant-ok`; (2) make sure you are using the file from the
  latest `release-section-20.zip`; (3) then re-do Phase 6.
- **Do NOT:** disable or edit the `enforce_active_shop_id()` guard to force it
  through.

**B) `ERROR: P0001: Not permitted: account is not active`**
(from `enforce_work_order_edits()` — a `guard_*` BEFORE UPDATE trigger — during
the work-table `shop_id` backfill).
- **What it means:** a pre-existing app-authorization trigger is firing on the
  migration's administrative backfill. In the SQL Editor there is no logged-in
  user (`auth.uid()` is NULL), so `is_active_user()` is false and the guard
  raises. You are running an **old** copy of the SQL. The corrected file
  (2026-07-18b) temporarily disables **only** the user triggers on the backfill
  tables, does the backfill, and re-enables them **before commit** — RLS is never
  touched and no trigger is dropped. The failed run has already rolled back.
- **Do:** (1) run the **trigger-discovery query** below and save the list — it
  shows every trigger on the tables the migration updates, so you can see which
  ones the corrected SQL briefly disables and confirm they are all back on
  afterward; (2) run the rollback-verification block; (3) use the latest ZIP;
  (4) re-do Phase 6.
- **Do NOT:** drop the trigger, disable RLS, or disable triggers globally.

**Trigger-discovery query (HISTORICAL / diagnostic reference — read-only). Was used
to enumerate every trigger on the backfill tables before the successful run; keep
for reference, not a current step:**

```sql
select c.relname as table_name, t.tgname as trigger_name,
  case when (t.tgtype & 2) = 2 then 'BEFORE' else 'AFTER' end as timing,
  case when (t.tgtype & 4) = 4 then 'INSERT ' else '' end ||
  case when (t.tgtype & 16) = 16 then 'UPDATE ' else '' end ||
  case when (t.tgtype & 8) = 8 then 'DELETE' else '' end as events,
  p.proname as function,
  case t.tgenabled when 'O' then 'enabled' when 'D' then 'DISABLED' else t.tgenabled::text end as state,
  (pg_get_functiondef(p.oid) ~* 'is_active_user|auth\.uid|raise exception') as may_block_migration
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal
  and c.relname in ('profiles','work_orders','work_order_photos','work_order_comments',
    'activities','work_order_serial_numbers','activity_history','audit_log',
    'role_change_requests','shop_serial_label_options')
order by c.relname, timing desc, t.tgname;
```

Every BEFORE UPDATE row with `may_block_migration = true` is a tripwire; the
corrected SQL handles all of them via the temporary table-scoped disable. After
any run (success or rollback), re-run this and confirm every `state = enabled`.

**Rollback-verification block (HISTORICAL / diagnostic reference — read-only). Was
used to test whether a FAILED attempt had left prod unchanged. NOTE: this block
checks for the PRE-tenant state and is now OBSOLETE as a pass/fail gate — against
current production every `live` count is deliberately NON-zero and
`is_active_user` is intentionally `CHANGED`, because Section 20 is applied. Keep
for the audit trail only; do NOT treat its old "PASS = all zero" wording as a
current expectation:**

```sql
select 'tenant_tables' as check,
  (select count(*) from information_schema.tables where table_schema='public'
     and table_name in ('shops','shop_locations','shop_memberships','platform_admins'))::text as live,
  '0' as expected_if_rolled_back
union all select 'profiles.active_shop_id col',
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name='active_shop_id')::text, '0'
union all select 'work_orders.shop_id col',
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='work_orders' and column_name='shop_id')::text, '0'
union all select 'tenant helper fns',
  (select count(*) from pg_proc where proname in
     ('current_user_shop_id','is_active_shop_member','row_in_current_shop',
      'set_active_shop','set_tenant_shop_id','set_tenant_shop_id_lenient','enforce_active_shop_id'))::text, '0'
union all select 'stamp/guard triggers',
  (select count(*) from pg_trigger where tgname in ('stamp_shop_id','guard_active_shop_id')
     and not tgisinternal)::text, '0'
union all select 'new isolation policies',
  (select count(*) from pg_policies where schemaname='public' and policyname in
     ('wo: shop isolation','wop: shop isolation','woc: shop isolation','act: shop isolation',
      'sn: shop isolation','ah: shop isolation','audit: shop read','rcr: shop isolation',
      'serial_labels: shop isolation','shops: member read','memberships: self read'))::text, '0'
union all select 'is_active_user still pre-tenant',
  case when exists (select 1 from pg_proc where proname='is_active_user'
     and pg_get_functiondef(oid) like '%current_user_shop_id%')
     then 'CHANGED-STOP' else 'pre-tenant-ok' end, 'pre-tenant-ok'
union all select 'guard_work_order_edits still enabled',
  coalesce((select case tgenabled when 'O' then 'enabled' else 'DISABLED-STOP' end
            from pg_trigger where tgname='guard_work_order_edits'),'(absent-STOP)'), 'enabled';
```

If any count is non-zero or you see `CHANGED-STOP`, the transaction did **not**
fully roll back — STOP and get it reviewed before re-running.

---

## PHASE 7 — V1–V8 verification ✅ COMPLETED (HISTORICAL — reference only)

> The V1–V8 checks were run and matched their expected results (this is part of
> what established that the apply is complete). The block below is retained as the
> reference definition of those checks; re-running them read-only is harmless but
> is not a required next step.

At the **bottom** of `section-20-tenant-foundation.sql` is a block labelled
**POST-MIGRATION VERIFICATION** with checks **V1 through V8**. Run each and
compare:

- **V1** → **4 rows** (the four tenant tables). 
- **V2** → all listed helper functions present.
- **V3** → `is_nullable = NO` on every `shop_id` row.
- **V4** → **1 shop**; `memberships` equals `profiles` count.
- **V5** → all **zeros**.
- **V6** → **9 rows** (stamp triggers).
- **V7** → **11 rows** (shop-scoped isolation policies).
- **V7b** → **0 rows** (old permissive policies are gone).
- **V7c** → `audit_log` and `activity_history` show only SELECT (`r`) policies.
- **V8** → (optional; the commented block) new audit/history rows get a non-null
  `shop_id`. If you don't run V8, note it as skipped.

**PASS:** every one of V1–V7c matches the expected result above.
**STOP:** any mismatch — especially **V7b not zero** (an old cross-tenant policy
survived) or **V5 not all zero** (unstamped rows). Stop and get it reviewed;
consider restoring the Phase 1 backup.

> Expect V7b to be 0 because the migration **drops and replaces** the old
> policies. (One planning doc's summary says it "never drops" old policies — that
> summary is out of date; the SQL you ran does replace them, which is correct.)

---

---

# ═══ ▶ CURRENT STARTING POINT — BEGIN HERE ═══

> Phases 1–7 above are DONE. **Phase 8 is your current, live next step.** From
> here on the PASS/STOP gates are real and apply to production/staging.

## PHASE 8 — Two-shop isolation test (in staging, not production) — ▶ CURRENT NEXT STEP

Follow `SECTION-20-PLAN.md` section **§7** step by step. In a **staging copy**
(never production), create a temporary **Test Shop B** and **Test User B**, seed
a little data in each shop, then confirm:

1. User A (Lessard) sees **only** Lessard rows across work orders, photos,
   comments, activities, serial numbers, audit log.
2. User B sees **only** B's rows; User A's data is invisible to B.
3. **The id-enumeration test (required):** as User B, paste a **real Shop A id**
   directly into the queries listed in §7 step 4. Each must return **0 rows** or
   be denied — even though the id is real.
4. `set_active_shop(<a shop you don't belong to>)` **raises an error**.
5. Tear down Test Shop B when done.

**PASS:** every assertion in §7 passes, **including** the id-enumeration test.
**STOP:** any query returns another shop's row, or the id-enumeration test
returns data. Isolation is not working — stop and get it reviewed.

---

## PHASE 9 — Smoke-test the app

As a real Lessard user, in the live app:
1. Open an existing job.
2. Add a comment.
3. Upload a photo.

**PASS:** all three succeed with no errors, and the job/photo/comment appear.
**STOP:** any of them fails or shows a permissions error. The new rules may be
blocking normal use — stop and get it reviewed; consider restoring the backup.

---

## PHASE 10 — STOP. Do not run Section 21 yet.

You are done with this pass. **Do not**:
- run `section-21-storage.sql`,
- change the storage bucket from public to private,
- deploy any signed-URL app changes.

Report the results of Phases 1–9 (the saved numbers and PASS/STOP outcomes) back
for the go/no-go review. Section 21 stays blocked until that review approves it.

---

### If something goes wrong at any phase
- During Phase 6, the migration undoes itself automatically (one transaction).
- After a committed run, the clean fix is **restore the Phase 1 backup**
  (Supabase → Database → Backups → restore). Details in `SECTION-20-PLAN.md` §8.
- Never try to hand-fix the database under time pressure — restore instead.
