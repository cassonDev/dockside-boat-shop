# Deployment Playbook — Private-Storage Cutover (`work-order-photos`)

**Operator runbook. Implementation is FROZEN. Execute top to bottom. Do not skip
a hard stop. Nothing here deletes photo objects.**

Legend: `[ ]` = do / confirm · **HARD STOP** = get explicit go before continuing.
Keep every query output, screenshot, and file named in this doc as an evidence
pack (folder `cutover-evidence/<date>/`).

---

## Phase 1 — Pre-deployment (capture evidence BEFORE any change)

- [ ] **1.1** Confirm branch: `git branch --show-current` → intended release branch.
- [ ] **1.2** Record commit: `git rev-parse HEAD` → save the SHA in the evidence pack.
- [ ] **1.3** Working tree clean & matches release: `git status` (no unexpected
      modified/untracked files) and `git fetch && git log --oneline origin/main -1`
      matches the intended SHA.
- [ ] **1.4** Back up the database (Supabase Dashboard → Database → Backups →
      on-demand backup, **or** `pg_dump`). Record backup id/time.
- [ ] **1.5** Export complete Storage inventory:
      `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/storage-inventory-and-classify.js --json cutover-evidence/<date>/before.json`
- [ ] **1.6** Record current bucket settings:
      `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id='work-order-photos';`
      (expect `public = true` now.)
- [ ] **1.7** Record existing storage policies:
      `select policyname, cmd, qual, with_check from pg_policies where schemaname='storage' and tablename='objects';`
      Save output — this is the rollback reference.
- [ ] **1.8** Archive 1.1–1.7 evidence. **HARD STOP — do not proceed without a
      verified backup and inventory.**

---

## Phase 2 — Read-only verification (change nothing)

Run each; confirm the expected result.

- [ ] **2.1 Section 20 tables**
  ```sql
  select table_name from information_schema.tables
  where table_schema='public' and table_name in
    ('shops','shop_locations','shop_memberships','platform_admins');
  ```
  Expected: **4 rows**.
- [ ] **2.2 Helper functions (20 + active-shop)**
  ```sql
  select proname from pg_proc where proname in
   ('current_user_shop_id','is_active_shop_member','is_shop_owner',
    'is_active_user','row_in_current_shop','current_user_membership_role');
  ```
  Expected: all present.
- [ ] **2.3 Section 21 helper functions**
  ```sql
  select proname from pg_proc where proname in
   ('storage_wo_in_current_shop','storage_wo_owned_in_current_shop',
    'storage_name_is_valid_photo');
  ```
  Expected: 3 present **after** Phase 4.1 (before it: 0 — that's fine pre-apply).
- [ ] **2.4 Triggers on work_order_photos**
  ```sql
  select tgname from pg_trigger where tgrelid='public.work_order_photos'::regclass and not tgisinternal;
  ```
  Expected: `set_shop_id`, `audit_work_order_photos` present.
- [ ] **2.5 RLS policies — work_order_photos (table)**
  ```sql
  select policyname, cmd from pg_policies where schemaname='public' and tablename='work_order_photos';
  ```
  Expected: `photos: shop read / shop insert / shop update` (Section 20 set).
- [ ] **2.6 RLS policies — storage.objects (after Phase 4.2)**
  ```sql
  select policyname, cmd from pg_policies where schemaname='storage' and tablename='objects'
  and policyname like 'wop:%';
  ```
  Expected (post-apply): `wop: select shop member`, `wop: insert shop member`,
  `wop: update shop member noshopmove`, `wop: delete owner only` — **4 rows**.
- [ ] **2.7 Indexes**
  ```sql
  select indexname from pg_indexes where schemaname='public' and tablename='work_order_photos';
  ```
  Expected includes `work_order_photos_shop_idx`, `work_order_photos_wo_idx`,
  and (post-apply) `work_order_photos_purge_ready_idx`.
- [ ] **2.8 Bucket configuration** — `select id, public from storage.buckets where id='work-order-photos';`
  Expected: `public = true` (until Phase 4.9).
- [ ] **2.9 Tenant columns**
  ```sql
  select column_name from information_schema.columns
  where table_schema='public' and table_name='work_order_photos'
    and column_name in ('shop_id','storage_path','thumb_path','active','archived_at','archived_by');
  ```
  Expected: all present.
- [ ] **2.10 Retention columns (after Phase 4.1)**
  ```sql
  select column_name from information_schema.columns
  where table_schema='public' and table_name='work_order_photos'
    and column_name in ('purge_approved_at','purge_approved_by','purge_after',
                        'storage_deleted_at','storage_delete_error','replaced_by_photo_id');
  ```
  Expected (post-apply): **6 rows**.
- [ ] **2.11 Purge view (after Phase 4.1)**
  ```sql
  select table_name from information_schema.views
  where table_schema='public' and table_name='work_order_photos_purge_candidates';
  ```
  Expected (post-apply): 1 row.
- [ ] **2.12 Data health (paths)**
  ```sql
  -- blank paths (expect 0)
  select count(*) from public.work_order_photos where storage_path is null or storage_path='' or thumb_path is null or thumb_path='';
  -- malformed paths (expect 0)
  select id, storage_path from public.work_order_photos
  where storage_path !~ '^[^/]+/[^/]+-orig\.jpg$' or thumb_path !~ '^[^/]+/[^/]+-thumb\.jpg$';
  -- duplicate paths (expect 0)
  select p, count(*) from (select storage_path p from public.work_order_photos
    union all select thumb_path from public.work_order_photos) q group by p having count(*)>1;
  ```
- [ ] **2.13** **HARD STOP** — if any expected result differs (esp. Section 20
      missing/unhealthy, or non-zero in 2.12), stop and reconcile before Phase 4.

---

## Phase 3 — Storage verification (read-only; delete nothing)

- [ ] **3.1** Review `before.json` from 1.5. Record: object count, cat totals.
- [ ] **3.2** Review **orphan report** (cat 5 — objects with no DB row). Decide
      per item: keep for now (default) or note for a later reviewed cleanup.
      **Do not delete.**
- [ ] **3.3** Review **records-missing-object** (cat 3). Investigate any row
      whose object is absent (possible prior failed upload).
- [ ] **3.4** Review **purge candidates** (cat 6). Expected now: **0** (purge
      workflow not yet in use).
- [ ] **3.5** Review **ambiguous/bad-name/duplicate** (cat 7). Confirm no
      unexpected object paths. Investigate any entry.
- [ ] **3.6** **HARD STOP** — proceed only if cat 3/5/7 are understood and
      accepted. Nothing is deleted at cutover.

---

## Phase 4 — Deployment (order fixed; hard stop after each)

- [ ] **4.1 Apply SQL changes** — run `supabase-schema.sql` Section 21 additive
      block (helpers, retention columns, purge index, purge view). Idempotent.
      Re-run 2.3/2.10/2.11 → expected present. **HARD STOP.**
- [ ] **4.2 Storage policies** — the four `wop:*` policies (in the same §21
      block). Re-run 2.6 → 4 rows. Diff against 1.7 evidence: **only `wop:*`
      changed; no unrelated policy replaced.** **HARD STOP.**
- [ ] **4.3 Keep bucket PUBLIC** — do nothing. Confirm 2.8 still `public=true`.
- [ ] **4.4 Deploy Netlify functions** — **not required** (no function changed).
      Confirm no diff in `netlify/functions/`. Skip. **HARD STOP (confirm skip).**
- [ ] **4.5 Deploy frontend** — deploy the release build (signed-URL
      `supabase-client.js` + `index.html`). Confirm build green.
- [ ] **4.6 Verify signed URLs** — sign in as a Shop A user, open a job with
      photos. DevTools → Network: requests use **`/object/sign/`** (signed), and
      **zero** requests to **`/object/public/`**. Gallery renders. **HARD STOP.**
- [ ] **4.7 Verify every photo surface** — Phase 5 checklist, bucket still public.
      **HARD STOP.**
- [ ] **4.8 Verify two-shop isolation** — Phase 6 negative tests that are
      testable while public (cross-shop signing must already fail via SELECT
      policy once private; note which require the flip). **HARD STOP — this is
      the go/no-go input for 4.9.**
- [ ] **4.9 Flip bucket PRIVATE**
      `update storage.buckets set public=false where id='work-order-photos';`
      Confirm 2.8 → `public=false`. **HARD STOP.**
- [ ] **4.10 Re-run verification** — Phase 5 (all surfaces, fresh sessions) **and**
      Phase 6 (full negative suite, incl. old public URL now fails). **HARD STOP.**
- [ ] **4.11 Monitor** — watch logs for signing failures, broken-image reports,
      400/404 spikes, for an agreed window (e.g. 24–48 h).

---

## Phase 5 — Runtime validation (test each; fresh sessions after 4.9)

Test as a **mechanic** and a **shop owner** where roles differ.

- [ ] **Intake** — capture/stage photos, save job; staged previews show; photos upload.
- [ ] **Job Details** — open job; photos load (signed).
- [ ] **Gallery** — thumbnails + open full-res in lightbox.
- [ ] **Activity Log** — activity-attached photos render.
- [ ] **Serial Photos** — serial thumbnails render; scan/review flow works.
- [ ] **Customer Preview** — customer-visible photos render; hidden ones excluded.
- [ ] **Print** — invoice/print shows images (re-signed on entry); no broken tiles.
- [ ] **QR workflow** — scan/open a job via QR/`/job/<code>`; photos load.
- [ ] **Mobile upload** — camera capture on a phone; upload + render.
- [ ] **Desktop upload** — file-picker upload; upload + render.
- [ ] **Shop switch** — switch A→B; only B images visible; no A leftovers.
- [ ] **Logout** — sign out; return via back button shows no prior images.
- [ ] **Disabled membership** — deactivate a member; their access + signing yield
      nothing.

---

## Phase 6 — Security validation (negative tests)

| # | Test | Expected result | Pass |
|---|---|---|---|
| 1 | Shop A user requests/signs a **Shop B** object path | Denied / empty (SELECT policy) | [ ] |
| 2 | **Logged-out** browser hits an app photo | No access (no session) | [ ] |
| 3 | **Expired** signed URL re-fetched | 400/403; app re-signs on next load | [ ] |
| 4 | **Forged upload path** (nonexistent WO prefix) | Insert denied (no WO row) | [ ] |
| 5 | **Malformed key** upload (bad name shape) | Insert denied (name check) | [ ] |
| 6 | **Forged shop id** in any storage call | Ignored; shop derived from WO row | [ ] |
| 7 | **Cross-shop delete** (A object as B / as A-mechanic) | Denied (owner-of-shop only) | [ ] |
| 8 | **Cross-shop rename/move** (A object → B WO prefix) | Denied (UPDATE WITH CHECK) | [ ] |
| 9 | **Old `/object/public/` URL AFTER flip** | 400/404 (bucket private) | [ ] |
| 10 | **Cross-shop signed URL** reuse across sessions | Not obtainable; unique keys | [ ] |
| 11 | **Cross-shop serial photo** access | Denied (same SELECT policy) | [ ] |

**Decisive assertion:** a Shop A photo renders via A's authorized query, while
the **same object** is unobtainable by Shop B, a logged-out browser, or a copied
old public URL. All must be **Pass** before sign-off.

---

## Phase 7 — Rollback (when to stop, and how)

For each condition: **what failed · rollback required? · evidence to collect first.**

- **R1 — SQL apply error (4.1).** Failed: §21 didn't apply cleanly. Rollback:
  **immediate** — `drop policy` the four `wop:*`, `drop view … purge_candidates`,
  drop the added columns/index (all reversible; no data change). Evidence: full
  error text + `pg_policies`/column state.
- **R2 — Policy diff shows unrelated policy changed (4.2).** Rollback:
  **immediate** — restore from 1.7 reference. Evidence: before/after `pg_policies`.
- **R3 — Frontend still calls `/object/public/` (4.6).** Failed: wrong build.
  Rollback: **redeploy previous frontend** (reads still work on public bucket);
  do **not** flip private. Evidence: Network HAR.
- **R4 — A photo surface broken while public (4.7).** Rollback: redeploy previous
  frontend; do not flip. Evidence: which surface, console + Network.
- **R5 — Two-shop isolation fails (4.8/4.10).** Failed: cross-tenant access
  possible. Rollback: **do not flip / if already flipped, this is data exposure —
  keep private and disable affected access; investigate policies.** Evidence:
  exact request, response, actor shop, target object.
- **R6 — Broken images after flip (4.10).** If widespread: **`update
  storage.buckets set public=true …`** (instant CDN restore), then diagnose
  signing. Evidence: signing-call responses, affected paths.
- **R7 — Error spike during monitoring (4.11).** If isolation-related: keep
  private, mitigate. If availability-only and severe: `set public=true` to
  restore, then fix forward. Evidence: log window, rates.

Golden rule: **isolation failure → never re-open the bucket to “fix” it;**
availability-only failure → re-opening (public=true) is the fast, safe revert.

---

## Phase 8 — Go / No-Go (single page)

Flip the bucket private **only if every box is checked:**

- [ ] Commit SHA confirmed == intended release (1.2/1.3).
- [ ] Verified DB backup exists (1.4).
- [ ] Storage inventory exported and cat 3/5/7 reviewed (1.5, 3.x).
- [ ] Section 20 present & healthy (2.1–2.2).
- [ ] §21 applied: helpers, 4 `wop:*` policies, retention columns, purge view,
      index (2.3/2.6/2.7/2.10/2.11).
- [ ] Policy diff clean — only `wop:*` changed (4.2).
- [ ] Data health 2.12 all zero.
- [ ] Frontend deployed; **no `/object/public/` requests**; signed URLs work (4.6).
- [ ] All Phase 5 surfaces pass while public (4.7).
- [ ] Phase 6 tests testable-while-public all pass (4.8).
- [ ] Rollback commands staged and understood (Phase 7).

**Decision:**

- ✅ **READY — flip bucket private** (proceed 4.9), then Phase 5 + full Phase 6
  re-run in fresh sessions, then monitor.
- ❌ **STOP** — any box above unchecked, any Phase 6 isolation test failed, or any
  HARD STOP unresolved. Do not flip. Collect evidence per Phase 7 and escalate.

---

*Post-flip note: permanent purge remains a separate, retention-gated,
service-role release. This playbook leaves all existing objects untouched.*
