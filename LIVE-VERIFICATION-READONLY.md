# Live Verification Package — READ ONLY

**Purpose:** establish the *live* reality of Supabase storage security before any
change. Live Supabase is the source of truth — the repo is only a hypothesis.

**Nothing in this file changes anything.** Every SQL block is `SELECT`/catalog
inspection only. No `create`, `alter`, `drop`, `insert`, `update`, `delete`, no
bucket flag, no policy edit. If you ever see one of those verbs in this file,
it's a bug — stop.

**How to run:** paste each block into the Supabase **SQL editor** (or `psql`)
against the **production** project. Capture the output. Compare to *Expect* /
*STOP* under each block. Do not proceed past any STOP.

Legend: ✅ Expect = the pass result · 🛑 STOP = reconcile with a human before
going further · 🔍 all blocks are read-only.

---

## 0. Which database am I on? (prove you're pointed at production)

```sql
select current_database(), current_user, inet_server_addr(), version();
```

🔍 Read-only.
✅ Expect: the production database name / host you intend to verify.
🛑 STOP: if this is a staging/branch DB, or you're unsure — everything below is
meaningless against the wrong database.

---

## 1. Is Section 20 fully applied live?

Section 20 = the multi-tenant foundation: tenant tables, helper functions, the
`shop_id` columns + stamping trigger, and shop-scoped RLS. All four sub-checks
must pass to call Section 20 "fully applied."

### 1a. Tenant tables exist

```sql
select t.expected as table_name,
       to_regclass('public.'||t.expected) is not null as present
from (values ('shops'),('shop_locations'),('shop_memberships'),
             ('platform_admins')) as t(expected)
order by table_name;
```

✅ Expect: 4 rows, `present = true` for every one.
🛑 STOP: any `present = false` → Section 20 is **not** applied (or partially).
🔍 Read-only.

### 1b. Tenant helper functions exist

```sql
select f.expected as proname,
       exists (select 1 from pg_proc p where p.proname = f.expected) as present
from (values ('current_user_shop_id'),('is_active_shop_member'),
             ('is_shop_owner'),('is_active_user'),('row_in_current_shop'),
             ('is_platform_admin')) as f(expected)
order by proname;
```

✅ Expect: all `present = true`.
🛑 STOP: any missing → Section 20 helpers not installed; the storage policies that
call them cannot be evaluating as intended. Do not proceed.
🔍 Read-only.

### 1c. `shop_id` columns + stamping trigger on tenant tables

```sql
-- shop_id column present on every tenant table
select c.tbl as table_name,
       exists (
         select 1 from information_schema.columns col
         where col.table_schema='public' and col.table_name=c.tbl
           and col.column_name='shop_id'
       ) as has_shop_id
from (values ('work_orders'),('work_order_photos'),('work_order_comments'),
             ('activities'),('activity_history'),('work_order_serial_numbers'),
             ('audit_log'),('role_change_requests'),('profiles')) as c(tbl)
order by table_name;

-- stamping trigger present on work_order_photos (representative)
select tgname from pg_trigger
where tgrelid = 'public.work_order_photos'::regclass and not tgisinternal;
```

✅ Expect: `has_shop_id = true` on every tenant table; at least one non-internal
trigger on `work_order_photos` (the shop-stamping trigger).
🛑 STOP: any `has_shop_id = false`, or no trigger on `work_order_photos` →
Section 20 incomplete.
🔍 Read-only.

### 1d. RLS is actually enabled (a policy that isn't enforced is theater)

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','profiles','shops','shop_locations',
    'shop_memberships','platform_admins')
order by table_name;
```

✅ Expect: `rls_enabled = true` on every listed table.
🛑 STOP: any `rls_enabled = false` → RLS off; policies do not run. Cross-tenant
open. Reconcile immediately.
🔍 Read-only.

**Section 20 verdict:** "fully applied" only if 1a–1d all pass. Anything else =
Section 20 is NOT live as the repo assumes → the prior wrong assumption is
repeating; STOP and reconcile before touching storage.

---

## 2. Live `storage.buckets` configuration

```sql
select id, name, public, file_size_limit, allowed_mime_types,
       created_at, updated_at
from storage.buckets
order by id;
```

✅ Expect: a row `id = 'work-order-photos'`. Record its `public` flag verbatim.
Given the repo state, `public = true` today is the expected (insecure) baseline.
🛑 STOP conditions:
  - `work-order-photos` **absent** → app is writing to a bucket that doesn't
    exist as expected, or a different id is live. Reconcile.
  - **More than one** bucket, or an unexpected bucket id → investigate what else
    stores objects and under what policy.
  - `public` already `false` **but** the signed-URL frontend is not yet live →
    reads may already be broken; investigate before anything else.
🔍 Read-only.

---

## 3. Every live RLS policy on the relevant objects

### 3a. `storage.objects`

```sql
select policyname, cmd, permissive, roles, qual, with_check
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;
```

✅ Expect: one coherent generation of `work-order-photos` policies (see the
generation map in §5). Note exactly which names appear.
🛑 STOP: any policy whose name is **not** in the known universe (§5), any policy
referencing a **different bucket_id**, or a mix of generations that OR together
into something broader than intended.
🔍 Read-only.

### 3b. `work_order_photos`

```sql
select policyname, cmd, permissive, roles, qual, with_check
from pg_policies
where schemaname='public' and tablename='work_order_photos'
order by policyname;
```

✅ Expect: shop-scoped policies (each `qual`/`with_check` mentions
`row_in_current_shop`), if Section 20 is live.
🛑 STOP: any policy whose `qual` has **no** `row_in_current_shop(shop_id)` (a
pre-tenant permissive policy still live → cross-tenant read/write leak), or any
unknown policy name.
🔍 Read-only.

### 3c. `work_orders`

```sql
select policyname, cmd, permissive, roles, qual, with_check
from pg_policies
where schemaname='public' and tablename='work_orders'
order by policyname;
```

✅ Expect: every policy `qual` references `row_in_current_shop(shop_id)`.
🛑 STOP: any policy without the shop predicate (e.g. a leftover
`mechanic read active` that reads every shop) — this is the exact leak class the
Phase 0 finding identified.
🔍 Read-only.

### 3d. All tenant/helper-relied-on tables in one shot

```sql
select tablename, policyname, cmd, permissive, roles, qual, with_check
from pg_policies
where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos',
    'work_order_comments','activities','activity_history',
    'work_order_serial_numbers','audit_log','role_change_requests',
    'shop_serial_label_options','shops','shop_locations','shop_memberships',
    'platform_admins')
order by tablename, policyname;
```

✅ Expect: every non-`profiles-self` policy carries a shop predicate; the tenant
tables (`shops`, `shop_memberships`, etc.) have sane owner/self policies.
🛑 STOP: any policy on an affected table with no shop predicate, or any policy
name not in the §5 baseline.
🔍 Read-only.

---

## 4. Live definitions of the helper + storage functions

Read the **actual source** of what the policies call — do not trust names.

```sql
select n.nspname as schema, p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       p.provolatile as volatility,          -- s=stable, i=immutable, v=volatile
       p.proconfig as settings,              -- expect search_path pinned
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname in (
  'is_active_user','is_shop_owner','row_in_current_shop',
  'current_user_shop_id','is_active_shop_member','is_platform_admin',
  'storage_wo_in_current_shop','storage_wo_owned_in_current_shop',
  'storage_name_is_valid_photo'
)
order by p.proname;
```

For each of the three you named specifically:

- **`is_active_user()`** — ✅ Expect: body ties the user to *their current shop*
  (membership + active), NOT merely "any active auth user". 🛑 STOP if it returns
  true for any authenticated active user with no shop scoping (that's the
  pre-tenant definition — every table policy that calls it then leaks).
- **`is_shop_owner()`** — ✅ Expect: checks owner role **within the current
  shop**. 🛑 STOP if it's shop-agnostic (owner of any shop passes everywhere).
- **`row_in_current_shop()`** — ✅ Expect: compares the passed `shop_id` to the
  caller's resolved current shop and returns false for NULL/mismatch. 🛑 STOP if
  absent, or if it can return true for a NULL/foreign shop_id.

For the storage helpers:
- ✅ Expect (only if §21 already applied): all three present, `security definer`,
  `search_path` pinned to `public`, resolving the WO through `public.work_orders`
  (not trusting path text). 🛑 STOP if present but path-trusting, or SECURITY
  INVOKER, or unpinned search_path.
- Present = §21 already live. Absent = §21 not yet applied (expected right now).

🔍 Read-only.

---

## 5. Live-vs-baseline diff (missing / extra / renamed / broader-than-expected)

### 5a. Storage policy generation map — classify every live storage policy

```sql
with known(policyname, generation) as (values
  ('work-order-photos: mechanic insert own job','§10 (pre-tenant)'),
  ('work-order-photos: shop_owner full access', '§10/§19 (pre-tenant)'),
  ('work-order-photos: staff insert any job',   '§19 (pre-tenant)'),
  ('work-order-photos: shop member insert',     '§20 (shop-scoped)'),
  ('work-order-photos: owner manage',           '§20 (shop-scoped)'),
  ('wop: select shop member',                   '§21 (target)'),
  ('wop: insert shop member',                   '§21 (target)'),
  ('wop: update shop member noshopmove',        '§21 (target)'),
  ('wop: delete owner only',                    '§21 (target)')
)
select pol.policyname, pol.cmd,
       coalesce(k.generation, '❗ UNKNOWN — STOP') as generation
from pg_policies pol
left join known k on k.policyname = pol.policyname
where pol.schemaname='storage' and pol.tablename='objects'
order by generation, pol.policyname;
```

✅ Expect: every live storage policy resolves to **one** generation, and they all
agree (all §19, or all §20, or all §21 — not a mix).
🛑 STOP: any row shows `❗ UNKNOWN — STOP` (extra/renamed policy → possible
broader access), or the generations are **mixed** (older permissive policy
OR-ing beside a newer one → the loosest wins).
🔍 Read-only.

### 5b. Which target §21 storage policies are MISSING

```sql
select e.policyname as expected_section21_policy,
       exists (
         select 1 from pg_policies p
         where p.schemaname='storage' and p.tablename='objects'
           and p.policyname = e.policyname
       ) as present
from (values ('wop: select shop member'),('wop: insert shop member'),
             ('wop: update shop member noshopmove'),('wop: delete owner only')
     ) as e(policyname)
order by expected_section21_policy;
```

✅ Expect **right now**: all `present = false` (§21 not applied yet — correct,
you're pre-cutover).
🛑 STOP: a **partial** set present (some true, some false) → a half-applied §21;
reconcile before doing anything.
🔍 Read-only.

### 5c. Public-schema policies NOT in the known Section-19/20 baseline (extras/renames)

```sql
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos',
    'work_order_comments','activities','activity_history',
    'work_order_serial_numbers','audit_log','role_change_requests',
    'shop_serial_label_options')
  and policyname not in (
    'profiles: shop_owner full access','profiles: self read',
    'profiles: self update limited','profiles: service_advisor update availability',
    'work_orders: shop_owner full access','work_orders: mechanic read active',
    'work_orders: mechanic update own','work_orders: mechanic insert',
    'work_orders: service_advisor full access','work_orders: staff update shop',
    'comments: shop_owner full access','comments: read active','comments: insert own',
    'photos: shop_owner full access','photos: read active',
    'photos: advisor insert any job','photos: mechanic insert own job',
    'photos: uploader update own','photos: advisor curate any',
    'photos: staff insert any job','photos: staff curate any',
    'activities: shop_owner full access','activities: read active',
    'activities: insert own','activities: author, advisor, or shop_owner update',
    'activities: author or shop_owner update',
    'activity_history: read active','activity_history: insert own',
    'serial_numbers: shop_owner full access','serial_numbers: read active',
    'serial_numbers: insert own','serial_numbers: creator or advisor update',
    'serial_numbers: staff update any',
    'audit_log: shop_owner read only',
    'role_requests: shop_owner full access','role_requests: self read',
    'role_requests: self insert',
    'serial_labels: shop_owner full access','serial_labels: read all'
  )
order by tablename, policyname;
```

✅ Expect: **zero rows** (live matches the known baseline).
🛑 STOP: **any** row returned = an extra, renamed, or unrecognized policy on an
affected table. It may grant broader access than intended. Reconcile with a human
before proceeding — do not assume it's benign.
🔍 Read-only.

### 5d. Broader-than-expected: table policies missing the shop predicate

```sql
select tablename, policyname, cmd, qual
from pg_policies
where schemaname='public'
  and tablename in ('work_orders','work_order_photos','work_order_comments',
    'activities','activity_history','work_order_serial_numbers','audit_log',
    'role_change_requests','shop_serial_label_options')
  and coalesce(qual,'') not like '%row_in_current_shop%'
  and policyname not like '%self%'
order by tablename, policyname;
```

✅ Expect: **zero rows** if Section 20's shop-scoped replacement is fully live.
🛑 STOP: any row = a policy on a tenant table that does **not** check
`row_in_current_shop` → cross-tenant leak (OR-ed with everything else). This is
the single most important cross-tenant check; treat any hit as a hard stop.
🔍 Read-only.

### 5e. Helper/storage functions: missing vs present

```sql
select f.expected as function_name,
       exists (select 1 from pg_proc p where p.proname = f.expected) as present,
       case when f.expected like 'storage\_%' escape '\' then 'section 21'
            else 'section 20' end as belongs_to
from (values ('is_active_user'),('is_shop_owner'),('row_in_current_shop'),
             ('current_user_shop_id'),('is_active_shop_member'),
             ('is_platform_admin'),('storage_wo_in_current_shop'),
             ('storage_wo_owned_in_current_shop'),
             ('storage_name_is_valid_photo')) as f(expected)
order by belongs_to, function_name;
```

✅ Expect: all **section 20** functions `present = true`; **section 21** storage
functions `present = false` right now (not applied yet).
🛑 STOP: any section-20 function missing (foundation incomplete), or a **partial**
set of section-21 functions (half-applied §21).
🔍 Read-only.

---

## 6. Git / Netlify: prove the deployed site is built from intended `main`

These are **outside the database** — run them in your terminal / Netlify
dashboard. All read-only (no push, no deploy, no env change).

### 6a. Identify the intended commit on `main`

```bash
git fetch origin --prune                       # read-only: updates refs only
git rev-parse origin/main                       # the SHA main currently points at
git log -1 --format='%H %ci %s' origin/main     # sanity: latest commit details
git status --porcelain                          # expect EMPTY (no local drift)
```

✅ Expect: a clean `git status` and a known `origin/main` SHA you intend to ship.
🛑 STOP: dirty working tree, or `origin/main` is not the commit you think it is.
🔍 Read-only (no commit/push/checkout).

### 6b. Confirm the working tree you inspected == that commit

```bash
git rev-parse HEAD                               # SHA of your local checkout
git merge-base --is-ancestor origin/main HEAD && echo "HEAD contains origin/main" \
  || echo "HEAD is BEHIND origin/main"
git diff --stat origin/main -- supabase-client.js index.html supabase-schema.sql \
  section-20-tenant-foundation.sql section-21-storage.sql
```

✅ Expect: `HEAD` == `origin/main` SHA and the `git diff --stat` is **empty** for
the storage-critical files.
🛑 STOP: any diff on those files → the code you reasoned about is not what's on
`main`. Reconcile before trusting any of the frontend analysis.
🔍 Read-only.

### 6c. Confirm Netlify deployed exactly that commit

In the Netlify dashboard → **Deploys** → current **Published** deploy:
- Read the **commit SHA** and branch of the published production deploy.
- Compare to `origin/main` from 6a.

Or via CLI (read-only):
```bash
netlify status                                  # shows linked site + current state
netlify api listSiteDeploys --data '{"site_id":"<YOUR_SITE_ID>"}' \
  | head -c 2000                                 # inspect latest deploy commit_ref
```

✅ Expect: published production deploy's `commit_ref` == `origin/main` SHA, branch
= `main`, state = `ready`.
🛑 STOP: published deploy is from a different SHA/branch, or a deploy is in
progress/failed → the live site is not the code you verified. Do not cut over.
🔍 Read-only (no `netlify deploy`, no env edits).

### 6d. Confirm the deployed bundle carries no `getPublicUrl` (belt-and-suspenders)

```bash
# Against the live site, read-only fetch of the served JS:
curl -s https://<YOUR_PROD_DOMAIN>/supabase-client.js | grep -n 'getPublicUrl' || echo "clean: no getPublicUrl"
```

✅ Expect: `clean: no getPublicUrl`.
🛑 STOP: any hit → a public-URL code path is live; flipping the bucket private
would break those reads. Fix before cutover.
🔍 Read-only.

---

## Overall gate

Bring the raw output of §0–§6 back before any change. The plan advances **only**
if:
- §1 proves Section 20 fully applied live (else STOP — the repo assumption is
  wrong again).
- §2 records the live bucket flag.
- §3/§5 show a single, known, shop-scoped policy generation with **zero**
  unknowns and **zero** shop-predicate-missing policies.
- §4 confirms the helper functions are genuinely shop-scoped in their live source.
- §6 proves deployed site == intended `main`.

Any STOP = reconcile with a human first. Live Supabase is the source of truth;
the repo is only the hypothesis being tested.
