# Private-Storage Conversion — Implementation Package

**Status: LOCAL IMPLEMENTATION ONLY. Nothing deployed. No migration run. Live
bucket unchanged (still `public = true`). No photo object deleted.**

This package was built against the **current working tree**, which I cannot
prove matches GitHub `main` or production. Verifying live Section 20 state, the
live bucket privacy flag, and live storage policies (§7 below) is a **deploy
prerequisite**, done immediately before cutover — not a blocker to this code.

---

## 1. Changed / added files

| File | Change |
|---|---|
| `supabase-client.js` | Signed-URL layer; `photoFromRow` stores paths only; sign on fetch/upload/serial; soft-delete + purge field mapping; replacement lineage; `clearPhotoUrlCache`. Removed all `getPublicUrl`. |
| `index.html` | Re-sign photos on invoice/print entry; clear signed-URL cache + tenant photo state on sign-out and shop-switch. |
| `supabase-schema.sql` | New **Section 21**: DB-authoritative storage policies (SELECT/INSERT/UPDATE/DELETE), retention/purge columns, replacement-lineage column, purge-candidate view. Bucket **not** flipped. |
| `scripts/storage-inventory-and-classify.js` | New. Read-only inventory + 7-state classification; orphan & purge-candidate reports; deletes nothing. |
| `STORAGE-PRIVACY.md` | This document. |

No Netlify **function** changes were needed: `ai-extract.js` and
`extract-serial-number.js` never touch storage (OCR receives a base64 data URL
and stores nothing). The future purge worker is **not** created (deferred to a
later controlled release, per instructions); its contract is specified in §5.

---

## 2. SQL & storage-policy changes (Phase A + C) — `supabase-schema.sql` §21

**Bucket left public deliberately.** The `SELECT` policy is inert on a public
bucket and becomes the enforcement point the instant the bucket is flipped
private (a deploy step, not run here).

**Authoritative, not path-trusting.** Every policy resolves the work order
through `public.work_orders` and checks `row_in_current_shop(wo.shop_id)` +
active membership via helpers `storage_wo_in_current_shop(name)` /
`storage_wo_owned_in_current_shop(name)`. A path whose first segment does not
match a real WO row resolves to nothing and is denied — the path text alone
never authorizes.

- **SELECT** — active member of the WO's shop.
- **INSERT** — active member of the WO's shop **and** name matches
  `^[^/]+/[^/]+-(orig|thumb)\.jpg$` (`storage_name_is_valid_photo`), blocking
  arbitrary key creation.
- **UPDATE** — `USING` pins the object to the current shop; `WITH CHECK`
  re-validates the (possibly renamed) key against a WO **in the same shop** and
  the required name shape → an object can never be renamed/moved into another
  work order or shop.
- **DELETE** — **shop_owner of the WO's shop only** (defense in depth).
  Mechanics have **no** storage-delete permission. The app never deletes bytes
  from the browser; real purge runs server-side with the service-role key.

**Retention columns** added to `work_order_photos` (smallest coherent model —
reuses existing `archived_at`/`archived_by` as deleted_at/deleted_by):
`purge_approved_at`, `purge_approved_by`, `purge_after`, `storage_deleted_at`,
`storage_delete_error`, `replaced_by_photo_id`. Three states are distinct:
**inactive** (`active=false`), **approved-for-purge** (`purge_approved_at` +
`purge_after`), **purged** (`storage_deleted_at`). Plus a read-only
`work_order_photos_purge_candidates` view and a partial index for the worker.

All of §21 is idempotent (`drop policy if exists`, `add column if not exists`,
`create or replace`).

---

## 3. Signed-URL design (Phase B) — `supabase-client.js`

- **DB stores only paths** (`storage_path`, `thumb_path`). No signed or public
  URL is ever persisted to the DB, localStorage, or IndexedDB.
- `photoFromRow` returns `storagePath`/`thumbPath` with empty `url`/`thumbUrl`.
  `signPhotos(photos)` batch-mints URLs via `createSignedUrls` (one round trip)
  and fills `url`/`thumbUrl`. `fetchWorkOrderPhotos`, `uploadWorkOrderPhoto`,
  `updateWorkOrderPhoto`, and both serial-photo paths sign before returning.
- **Every photo surface is covered** because all of them render from
  `jobPhotos` (loaded via `fetchWorkOrderPhotos`) or from the signed object
  returned by an upload: intake staged (local object URLs, pre-upload — no
  storage), job gallery, thumbnails, lightbox, log photo picker, activity feed,
  serial-number images, customer preview, print output, archived/historical
  views, and QR-opened work orders (QR opens a job → same load path).
- **Async handled:** signing is awaited inside the async load/upload functions,
  so the synchronous render mappers see already-signed URLs. A path that fails
  to sign yields `''`, and the existing broken-image/fallback UI handles it.
- **TTL = 3600s (1h).** Documented in code. Balances re-sign frequency against a
  short leak window once private. Invoice/print **re-sign on entry**
  (`goToInvoice`, `printPage`) so a long-open job never prints broken images.
  In-date cached URLs are reused (no network). A margin of 5 min forces re-sign
  before actual expiry. If a workflow ever needs a URL to outlive an hour (e.g.
  emailing a customer), mint that single URL deliberately with a longer TTL at
  that call site — do not raise the default.
- **No `getPublicUrl` fallback in the cutover code.** It was removed entirely
  (see §11). Signed URLs function on a still-public bucket, so no temporary
  fallback is needed to keep reads working before the flip.

---

## 4. Deletion & retention (Phase C)

- User-facing delete stays a **DB soft delete** (`deleteWorkOrderPhoto`:
  `active=false` + `archived_at`/`archived_by`). It **never** removes bytes.
- Bytes are **not** deleted synchronously from the browser, and an object is
  **not** deleted merely because its row is inactive. Inactive, orphaned, and
  approved-for-purge are three separate states (§2).
- During private-bucket conversion **all existing objects are preserved**.

---

## 5. Future server-side purge contract (design only — NOT built)

A later controlled release adds a service-role worker (Netlify scheduled
function or CLI) that, per candidate from `work_order_photos_purge_candidates`:

1. Re-reads the photo row fresh.
2. Verifies `purge_approved_at is not null`.
3. Verifies `purge_after <= now()` (retention elapsed).
4. Verifies the caller/scheduled process is authorized (service role; approval
   recorded by a shop_owner in `purge_approved_by`).
5. Removes **both** orig and thumb objects via the Storage API.
6. Stamps `storage_deleted_at` on success, or `storage_delete_error` on failure.
7. Leaves the row (audit trail preserved) and writes an audit-log entry.

It must **never** accept a browser-supplied path. Category-6 rows are the only
ones it may act on; categories 3/5/7 are report-only.

---

## 6. Service-worker / cache findings (Phase E)

- **No service worker, no PWA manifest, no `CacheStorage`/Workbox** exists in
  the project (verified by search). So no global PWA cache can retain private
  images — the main PWA risk does not apply here.
- **App-level clearing added:** `clearPhotoUrlCache()` wipes the in-memory
  signed-URL map on **sign-out** and **shop-switch**; sign-out also drops
  `jobPhotos`/`serialNumbers`/`selectedJobId`, and shop-switch does a full
  `location.reload()`. No signed URL is written to localStorage/IndexedDB.
- **What cannot be revoked before expiry:** the browser's normal HTTP disk
  cache and any already-open `<img>` may retain fetched image **bytes** until
  the signed URL expires; a URL already copied elsewhere also works until
  expiry. This is exactly why the TTL is kept short (1h). Longer-term mitigation
  if needed: shorter TTL, and/or `Cache-Control` tuning on storage responses.

---

## 7. Live verification package (run before deploy)

### SQL-verifiable (SQL editor / psql)

```sql
-- (a) Bucket privacy flag (expect true now; will be false post-cutover)
select id, public from storage.buckets where id = 'work-order-photos';

-- (b) All policies currently attached to storage.objects
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- (c) Section 20 helpers & tables exist
select proname from pg_proc
where proname in ('current_user_shop_id','is_active_shop_member','is_shop_owner',
                  'is_active_user','row_in_current_shop');
select table_name from information_schema.tables
where table_schema='public' and table_name in
  ('shops','shop_locations','shop_memberships','platform_admins');

-- (d) work_order_photos tenant columns + trigger
select column_name from information_schema.columns
where table_schema='public' and table_name='work_order_photos'
  and column_name in ('shop_id','storage_path','thumb_path','active','archived_at');
select tgname from pg_trigger where tgrelid = 'public.work_order_photos'::regclass;

-- (e) records with missing/blank paths (expect 0)
select count(*) from public.work_order_photos where storage_path is null or storage_path = ''
   or thumb_path is null or thumb_path = '';

-- (f) paths with unexpected format (expect 0)
select id, storage_path from public.work_order_photos
where storage_path !~ '^[^/]+/[^/]+-orig\.jpg$'
   or thumb_path   !~ '^[^/]+/[^/]+-thumb\.jpg$';

-- (g) duplicate path references (expect 0)
select p, count(*) from (
  select storage_path p from public.work_order_photos
  union all select thumb_path from public.work_order_photos
) q group by p having count(*) > 1;
```

### Requires the Supabase Storage API (service-role script)

Run `node scripts/storage-inventory-and-classify.js --json report.json`:

- Complete storage object inventory (export).
- **Category 3** — DB records whose objects are missing.
- **Category 5** — storage objects with no matching DB record (orphans).
- Category 6 — approved-for-purge; Category 7 / bad-name / duplicate — ambiguous.

These cross-checks (DB↔object existence) **cannot** be done in pure SQL because
`storage.objects` metadata is not a reliable byte-level truth — the Storage API
is authoritative. The script deletes nothing.

---

## 8. Deployment sequence (HARD STOP after every stage)

Each stage: perform, verify, **STOP**, get approval, proceed. Rollback per stage.

1. **Confirm working tree == intended GitHub `main` commit.** — Rollback: fix
   the branch; do not proceed on mismatch.
2. **Back up the database** (full dump / PITR checkpoint). — Rollback: none
   needed; this is the safety net.
3. **Export complete storage inventory** (`--json`, archived). — Rollback: n/a.
4. **Verify live Section 20 schema + policies** (§7 a–d). — Rollback: n/a; abort
   if state differs from expected.
5. **Apply §21 additive schema + storage policies.** — Rollback: `drop policy`
   the six `wop:*` policies; drop the added columns/view/index. No data change.
6. **Keep the bucket public** (do nothing). — Rollback: n/a.
7. **Deploy signed-URL frontend + functions.** — Rollback: redeploy previous
   build (reads still work: prior build used public URLs on the public bucket).
8. **Test every photo surface while bucket still public** (§9 matrix). —
   Rollback: redeploy previous build.
9. **Confirm no executable path uses `getPublicUrl`** (§11 search on deployed
   bundle). — Rollback: block cutover until clean.
10. **Confirm signed-URL generation succeeds for authorized users and FAILS
    cross-tenant** (§9). — Rollback: block cutover.
11. **Flip bucket to private:**
    `update storage.buckets set public=false where id='work-order-photos';` —
    **Rollback: `set public=true`** (CDN reads resume instantly).
12. **Re-test in two separate sessions for two shops** (§9). — Rollback: step 11
    rollback.
13. **Monitor errors** (signing failures, broken images, 400s). — Rollback:
    step 11 rollback if widespread.
14. **Leave existing objects untouched.** — n/a.
15. **Introduce permanent purge only in a later controlled release** (§5). — n/a.

---

## 9. Cross-tenant test matrix

Sessions: **A-owner, A-mechanic, B-owner** (shops A and B). Bucket **private**
for the isolation rows.

| # | Actor | Action | Expected |
|---|---|---|---|
| 1 | A-mechanic | Open A job, load gallery | Thumbs + full-res render (signed) |
| 2 | A-mechanic | Upload photo to A job | Upload OK; row + object in A; renders |
| 3 | A-mechanic | Lightbox / activity / serial / customer preview / print of A job | All images render; print re-signs |
| 4 | A-mechanic | Attempt `createSignedUrl` for a **B** object path | **Denied** (SELECT policy: WO not in current shop) |
| 5 | A-mechanic | Direct GET of a B object public-style URL | **404 / denied** (bucket private) |
| 6 | A-mechanic | Insert object under a non-existent WO prefix | **Denied** (no WO row) |
| 7 | A-mechanic | Insert object with malformed name | **Denied** (name-shape check) |
| 8 | A-mechanic | Rename/move an A object into a B WO prefix | **Denied** (UPDATE `WITH CHECK`) |
| 9 | A-mechanic | Attempt storage DELETE of an A object | **Denied** (owner-only delete) |
| 10 | A-owner | Storage DELETE of an A object | Allowed by policy (app still never calls it) |
| 11 | B-owner | List/sign any A object | **Denied / empty** |
| 12 | A-mechanic | Soft-delete a photo | Row `active=false`; **object still present** |
| 13 | A-mechanic | Rescan a serial photo | New object+row; prior row `active=false`, `replaced_by_photo_id` set, prior object preserved |
| 14 | any | Leave job open > 1h, then print | Re-sign refreshes URLs; images render |
| 15 | A-mechanic | Sign out, then back button | No prior signed images shown (cache cleared) |
| 16 | A-mechanic | Switch A→B | Full reload; only B images visible |

---

## 10. Remaining risks

1. **In-flight leak window (≤ TTL).** A signed URL / already-fetched bytes stay
   reachable until expiry even after logout — inherent to signed URLs; mitigated
   by the 1h TTL. Shorten further if the threat model requires.
2. **Working tree vs production drift.** Unverified until §7/§8.1. Could mean the
   live DB is on §10/§19 storage policies, not §20 — §21's `drop policy if
   exists` handles either, but confirm before applying.
3. **Existing orphans/bad-name objects.** Pre-existing objects that don't match
   the name shape or lack a row are reported (cat 5/7) but not fixed here; review
   before or after cutover — they don't block private reads of valid photos.
4. **Legacy `work_orders.photos` JSON / entry `photos` arrays.** Older rows may
   still carry inline photo data read as a fallback; those are not storage
   objects and are out of scope for this pass.
5. **Purge worker not yet built.** Approved-for-purge rows accumulate until the
   later release; storage grows until then (acceptable — retention is the point).
6. **CORS `*` on Netlify functions** and **serial images sent to OpenAI** —
   noted in the original inspection; unrelated to bucket privacy, unchanged.

---

## 11. Final executable-code search results

Searched the whole project:

- **`getPublicUrl`** — 0 executable calls. One prose mention in a
  `supabase-client.js` comment only.
- **`/storage/v1/object/public/`** — 0 occurrences.
- **Permanent/public bucket URLs** — none constructed anywhere.
- **Direct browser-side storage deletion** (`.storage.from(...).remove(`) — 0
  occurrences (soft delete only; owner-only DELETE policy is defense in depth).
- **Signed URLs persisted to DB / localStorage / IndexedDB** — none. Signed URLs
  live only in an in-memory `Map` cleared on sign-out and shop-switch; the DB
  stores object paths only.

---

**Stopping here. No deploy, no migration, no bucket change, no photo object
deleted.** Next action is yours: run §7 against live Supabase and confirm the
working tree matches `main`, then walk §8 stage by stage.
