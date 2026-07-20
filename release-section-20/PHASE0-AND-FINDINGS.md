# Phase 0 Report, RLS Conflict Assessment & Work-Order ID Investigation

**Read-only analysis. No SQL executed, no schema/policy/bucket change.** This is
the pre-execution package you asked for. It contains one **critical security
finding** that changes the Section 20 policy approach (§2) — please read that
first.

---

## ⚠ CRITICAL FINDING (hard stop): permissive pre-tenant policies bypass isolation

The live database never applied Section 20, so it still carries the **Section
1–19 RLS policies**. Those policies gate access with `is_active_user()` /
`is_shop_owner()` **but have no per-row shop predicate**. Example, live today on
`work_orders`:

```sql
create policy "work_orders: mechanic read active" on public.work_orders
  for select using (public.is_active_user() and active = true);
```

Once Section 20 redefines `is_active_user()` to mean "active member of *my
current shop*", this policy evaluates to **true for every active row in every
shop** — because nothing checks `row_in_current_shop(shop_id)`. **PostgreSQL
RLS policies are OR-ed together**, so this single leftover policy would let any
active user of Shop B read all of Shop A's work orders. The same pattern exists
on comments, photos, activities, serial numbers, etc.

**Consequence:** my earlier "additive, never drop existing policies" standalone
file is **insecure as written** — it would create correct shop-scoped policies
*and leave the permissive ones live beside them*, and OR-ing means the loosest
policy wins. That is precisely the "permissive existing policy that could bypass
tenant isolation" you flagged as a hard stop.

**Resolution (does not contradict your intent):** "do not weaken existing
policies" is honored by **replacing** each permissive pre-tenant policy with a
**stricter shop-scoped** policy of the same intent (drop old name → create
shop-scoped). Dropping a too-broad policy and installing a narrower one is
**strengthening**, not weakening. The revised Section 20 therefore must:
1. **Drop-and-replace** the known pre-tenant baseline on every affected table
   with `row_in_current_shop(shop_id)`-guarded equivalents.
2. **Hard-stop (RAISE)** if any policy exists on an affected table that is **not
   in the known baseline** — an unknown permissive policy must be reconciled by
   a human before we proceed.

This is now reflected in the revised `section-20-tenant-foundation.sql` (§ 20F).

---

## 1. Phase 0 row-count report (run read-only, before migrating)

Run the `PHASE 0` block at the top of `section-20-tenant-foundation.sql`. On a
clean never-applied DB, for every tenant table `to_backfill` == `rows` and
`after_backfill` == `rows` (no row lost). Capture the output as evidence. Tables
covered: profiles, work_orders, activities, work_order_photos,
work_order_comments, work_order_serial_numbers, audit_log, activity_history,
role_change_requests.

*(Actual counts must be filled from the live run — I cannot query live.)*

---

## 2. Live RLS policy inventory & semantic-conflict assessment

Run this to produce the authoritative live list (also in Phase 0.2):
```sql
select tablename, policyname, cmd, qual, with_check
from pg_policies where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
order by tablename, policyname;
```

Classification of the **known codebase baseline** (what the live DB should have,
derived from `supabase-schema.sql` sections 1–19). Every one is a **potential
overlap/conflict** after tenanting because none check shop — all must be
drop-and-replaced:

| Table | Existing policy | Class | Why |
|---|---|---|---|
| work_orders | `shop_owner full access` | conflict → replace | `is_shop_owner()` now shop-scoped but no row predicate on ALL cmd |
| work_orders | `mechanic read active` | **conflict (leak)** → replace | reads every shop's rows |
| work_orders | `mechanic update own` | conflict → replace | no shop check |
| work_orders | `mechanic insert` | conflict → replace | no shop check |
| work_orders | `service_advisor full access` | conflict → replace | no shop check |
| work_orders | `staff update shop` | conflict → replace | no shop check |
| work_order_comments | `shop_owner full access` / `read active` / `insert own` | conflict → replace | no shop check |
| work_order_photos | `shop_owner full access` / `read active` / `advisor insert any job` / `mechanic insert own job` / `uploader update own` / `advisor curate any` / `staff insert any job` / `staff curate any` | conflict → replace | none check shop |
| activities | `shop_owner full access` / `read active` / `insert own` / `author, advisor, or shop_owner update` / `author or shop_owner update` | conflict → replace | none check shop |
| activity_history | `read active` / `insert own` | conflict → replace | none check shop |
| work_order_serial_numbers | `shop_owner full access` / `read active` / `insert own` / `creator or advisor update` / `staff update any` | conflict → replace | none check shop |
| audit_log | `audit_log: shop_owner read only` | conflict → replace | SELECT-only, but reads all shops |
| role_change_requests | `shop_owner full access` / `self read` / `self insert` | conflict → replace | no shop check |
| profiles | `self read` | **compatible** (keep) | `id = auth.uid()` — self only, no cross-tenant path |
| profiles | `self update limited` | compatible (keep) | self only |
| profiles | `shop_owner full access` | conflict → replace | owner sees all shops' profiles |
| profiles | `service_advisor update availability` | conflict → replace | no shop scope |
| shop_serial_label_options | `serial_labels: read all` / `shop_owner full access` | conflict → replace | `shop_id` now real; must scope |

**Hard-stop rule:** if the live inventory shows **any** policy name **not** in
this baseline on an affected table, STOP and reconcile manually — it may grant
broader access than the new tenant policies. The revised SQL enforces this with
a RAISE.

### Live-baseline correction (important)

The baseline is the **Section-19 end state**, not the union of all historical
policies. Section 19 (two-role model) **dropped `is_service_advisor()`**
(schema line 1043) and **replaced** the advisor-era policies with "staff"
versions:
- `work_orders: mechanic update own` + `... service_advisor full access` →
  **`work_orders: staff update shop`**
- `photos: advisor curate any` → **`photos: staff insert any job`** +
  **`photos: staff curate any`**
- `activities: author, advisor, or shop_owner update` →
  **`activities: author or shop_owner update`**
- `serial_numbers: creator or advisor update` →
  **`serial_numbers: staff update any`**
- `profiles: service_advisor update availability` → **dropped, not recreated**

So live almost certainly has **no `is_service_advisor()`** and none of the
`*advisor*` policy names. The migration is robust either way: the RLS-guard
allowlist is a **superset** (it lists both the historical and the Section-19
"staff" names), and every `drop policy` is `if exists`, so absent names are
harmless and any truly unknown name still hard-stops.

### Item 1–5 live confirmation queries (run these, return output)

```sql
-- 1. Does is_service_advisor() exist? (expected: 0 rows, dropped in \u00a719g)
select proname, pg_get_function_arguments(oid) as args, pg_get_functiondef(oid) as def
from pg_proc where proname = 'is_service_advisor';

-- 2. Complete live RLS inventory for every affected table.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
order by tablename, policyname;

-- 3+4. Diff live vs. the known allowlist: any row returned is EXTRA/renamed/
--      unexpected and is a HARD STOP. (Empty result = live matches baseline.)
select tablename, policyname from pg_policies where schemaname='public'
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
    'serial_labels: shop_owner full access','serial_labels: read all');
```

**5. Guard aborts before any DDL:** in `section-20-tenant-foundation.sql` the
identical allowlist check runs as a `DO $$ ... raise exception ... $$` block
placed **before 20A and before any `drop policy`**, inside the single migration
transaction. If query #3+4 returns anything, the in-file guard raises and the
whole transaction rolls back with **zero** changes. Run #3+4 manually first as a
dry check; the guard is the enforced backstop.

---

## 3. Work-order ID investigation

**Type / constraints (`supabase-schema.sql`):**
- `work_orders.id` is **`text primary key`** — **no length limit, no default, no
  CHECK constraint**. Comment: short job/tag code, e.g. "7G2MH".
- It is the **sole global primary key**. All child tables reference it:
  `work_order_comments`, `work_order_photos`, `activities`,
  `work_order_serial_numbers` each have `work_order_id text ... references
  public.work_orders(id) on delete cascade`.

**Generator (`supabase-client.js` `newJobCode`, line 223):**
- **Frontend-generated** (browser), not DB/Netlify. Also mirrored in
  `dockside-data.js` (demo data).
- Alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — **31 chars** (excludes I, L, O, 0,
  1). **Length 5.** **Random** via `Math.floor(Math.random()*31)` (not
  crypto-strong, not sequential, not timestamp, not shop-specific).
- **Possible values = 31⁵ = 28,629,151 (~28.6M).**
- **Uniqueness check is client-side and scoped:** `while
  (existingIds.includes(code))`, where `existingIds` = the **jobs currently
  loaded in app state**. Post-tenant, state holds **only the current shop's
  jobs** — so the check does **not** see other shops' IDs. The DB primary key is
  the only *global* guarantee, and a collision there causes an **insert failure**
  (PK violation), not a silent overwrite.

**Routes / dependencies on the ID:**
- URL route `/job/:code` (`_parseJobCodeFromLocation`, regex `^/job/([A-Za-z0-9]+)`).
- QR codes encode the job code; deep links resolve by `jobs.find(j => j.id ===
  code)`.
- All four child-table foreign keys above.

**Collision risk as shops are added:**
- Per-insert collision probability ≈ (existing global rows) / 28.6M. At ~28,600
  total orders that's ~0.1% *per new order*; birthday-style, a **50% chance of
  at least one collision appears around ~6,300 total orders** across all shops.
- Because the client only de-dupes against the current shop, cross-shop
  collisions are **not retried** — they surface as **PK-violation insert
  failures** (an availability landmine), and **two shops can never share the same
  visible job number** while `id` is the global PK.
- Not a data-leak; a **reliability/scaling** problem that grows with tenant count.

**Verdict for the go/no-go: Option 2 — global uniqueness is NOT proven.**
- The generator is random over a modest 28.6M space with only a **shop-local**
  uniqueness check; global uniqueness rests solely on the PK rejecting dupes.
- **Section 20 may proceed for the current single shop** (existing IDs are
  preserved and remain globally unique today).
- **Onboarding additional shops must be BLOCKED** until a separate, tested
  identifier migration is designed — options to evaluate then: composite identity
  `(shop_id, id)` with a per-shop unique constraint + surrogate global key; or a
  server-side/global uniqueness check; or longer/namespaced codes. **Not done in
  Section 20.**

**Language correction accepted:** database identity remains **globally
determined by `work_orders.id`**. Tenant authorization *checks* `shop_id` +
`work_orders.id`, but I will not describe that pair as the primary identity while
`id` alone is the global PK.

---

## 4. Audit/history append-only + stamping verification (revised)

Per your conditions, the revised SQL and verification now ensure:
- Legacy rows may keep `shop_id IS NULL`; **NULL-shop rows are readable only by
  platform admins** (`... or is_platform_admin()` in the read policy; normal shop
  users match only `row_in_current_shop(shop_id)`, which is false for NULL).
- **New** audit/history rows get stamped via the lenient trigger; a stamp failure
  never blocks the base write.
- **Append-only preserved:** audit_log and activity_history get **SELECT-only**
  client policies — **no INSERT/UPDATE/DELETE** policy for any shop user (rows
  are written by `SECURITY DEFINER` triggers only).
- **New verification V8** creates representative rows in a transaction, asserts
  their `shop_id` is populated, and **fails if any newly created row is
  NULL-shop**; then rolls back so it changes nothing.

---

## 5. Updated go / no-go gate (reflecting the ID finding)

Section 21 may be reviewed only after Section 20 applies AND:
- [ ] Phase 0 counts captured; live RLS inventory matches the known baseline —
      **zero unknown policies** on affected tables (else hard stop).
- [ ] Revised Section 20 committed: permissive baseline **replaced** with
      shop-scoped policies; RLS hard-stop guard passed.
- [ ] V1–V8 pass, including **V8 audit/history stamping** and the
      **UUID/id-enumeration** isolation test.
- [ ] **ID decision recorded = Option 2:** stay single-shop; **adding shops is
      blocked** pending an identifier migration. If/when multi-shop onboarding is
      wanted, that migration is designed, tested, and gated separately.
- [ ] Pre-migration backup retained; app smoke test passes for a Lessard user.

---

**No SQL executed. No deploy. No bucket change.** The critical finding (§2) means
the standalone Section 20 SQL now uses drop-and-replace for the permissive
baseline plus an unknown-policy hard stop; see the updated file and plan.
