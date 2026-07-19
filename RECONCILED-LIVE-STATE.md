# Reconciled Live State — Storage Security Workstream

**Date:** 2026-07-19 · **Source of truth: LIVE production Supabase** (verified
read-only via `LIVE-VERIFICATION-READONLY.md`). The repo is only a hypothesis;
where they disagree, live wins.

---

## A. Headline finding (UPDATED 2026-07-19 — Section 20 IS applied)

**Section 20 (multi-tenant foundation) is FULLY APPLIED and VERIFIED in
production as of 2026-07-19.** One of the Phase 6 runs previously believed to
have rolled back actually **committed**. Live-state verification on 2026-07-19
confirmed the tenant foundation is present, complete, and consistent:

- **4 tenant tables** live (`shops`, `shop_locations`, `shop_memberships`,
  `platform_admins`).
- **7 tenant helper functions** present (`current_user_shop_id`,
  `is_active_shop_member`, `row_in_current_shop`, `set_active_shop`,
  `set_tenant_shop_id`, `set_tenant_shop_id_lenient`, `enforce_active_shop_id`;
  plus the redefined shop-scoped `is_active_user`/`is_shop_owner`).
- **9 stamp/guard triggers** installed.
- **11 shop-isolation policies** active (verified count = 11).
- **Strict `shop_id` columns are `NOT NULL`** on all six strict tenant tables
  (`work_orders`, `work_order_photos`, `work_order_comments`, `activities`,
  `work_order_serial_numbers`, `role_change_requests`) — proving block 20E ran,
  i.e. the transaction reached the end and committed.
- **Backfill complete:** zero unstamped rows on strict tables (guaranteed by the
  `NOT NULL` locks).
- **Old permissive pre-tenant policies are gone**; replaced by the new
  shop-scoped isolation policies.
- **All backfill-disabled user triggers were successfully re-enabled** (20D-4);
  zero triggers left in the disabled state.

**Correction:** the earlier conclusion in this workstream that *both* failed
Phase 6 attempts rolled back completely was **incorrect** — one run committed.
Production is in the good, fully-applied state, not a partial one.

**What remains:** Phases 1–7 are effectively done. Remaining work is the Phase 8
two-shop isolation test (staging, incl. the id-enumeration test), the Phase 9
live smoke test, and the Phase 10 hard stop / Section 21 go/no-go. §21 is still
blocked pending that review.

> The pre-tenant findings in sections B–D below are RETAINED AS HISTORICAL
> RECORD of the 2026-07-18 read-only baseline (the state before the migration
> committed). They describe the DB as it WAS, not as it is now. Section A above
> is the current authoritative state.

---

## B. Verified live facts (with evidence)

### Foundation (§1)
- **Tenant tables absent:** `shops`, `shop_locations`, `shop_memberships`,
  `platform_admins` all `present = false`.
- **Tenant helpers absent:** `current_user_shop_id`, `is_active_shop_member`,
  `row_in_current_shop`, `is_platform_admin` all absent.
- **Pre-tenant helpers present:** `is_active_user` = true, `is_shop_owner` = true.
  (§4 source read still outstanding — but every policy body proves they are
  shop-agnostic in effect.)
- **No shop-stamping:** only trigger on `work_order_photos` is
  `audit_work_order_photos` (audit, not shop stamping). No `shop_id` enforcement.
- **RLS enabled** on all app tables (`rls_enabled = true`, none `forced`). So
  policies ARE enforced — but they enforce *no shop scope*.

### Bucket (§2)
- One bucket: `work-order-photos`, **`public = true`**, `file_size_limit = null`,
  `allowed_mime_types = null`. Created 2026-07-11. Bytes are CDN-reachable by
  anyone with a path; no size cap; no MIME allow-list.

### Storage policies on `storage.objects` (§3a)
- `work-order-photos: shop_owner full access` — `ALL`, `is_shop_owner()` only
  (any shop's owner → all objects).
- `work-order-photos: staff insert any job` — `INSERT`, `with_check =
  is_active_user()` only. **Path-trust forge risk, live.**
- **No non-owner SELECT policy exists.** Non-owner reads work today ONLY because
  the bucket is public (direct CDN). Signed-URL reads via RLS SELECT would fail
  for non-owners right now.

### Row-level policies (§3b/§3c/§3d) — every affected table
All PERMISSIVE, `roles = {public}`, and **none** contain `row_in_current_shop`:
- `work_orders`: `mechanic read active` (any active user reads EVERY WO in EVERY
  shop), `staff update shop` (any active user updates any WO), `mechanic insert`,
  `shop_owner full access`.
- `work_order_photos`: `read active` (any active user reads every active photo
  row, all shops), `staff curate any` (any active user updates any photo),
  `staff insert any job`, `uploader update own`, `shop_owner full access`.
- `work_order_comments`, `activities`, `activity_history`,
  `work_order_serial_numbers`, `role_change_requests`, `audit_log`,
  `shop_serial_label_options`, `profiles` — same pattern (self/owner/active-user;
  `profiles` correctly self-scoped).

### Baseline diff (§5)
- **§5c (extras/renames):** none — all live policy names match the known
  §10/§19 baseline. No rogue policies.
- **§5d (broader-than-expected):** **every non-self policy on every tenant table**
  is missing `row_in_current_shop` → the entire row layer is cross-tenant open.
- **§5b (§21 target policies):** all absent (correct — §21 not applied).

### Git/Netlify (§6)
- **Outstanding.** Not yet run. Must confirm deployed site == intended `main`
  before trusting the frontend analysis.

---

## C. Live risk summary (what is actually exposed right now)

1. **Cross-tenant row reads** — any active authenticated user can read every
   shop's work orders, photos metadata, comments, activities, serials. (§3b/c/d)
2. **Cross-tenant object bytes** — public bucket → anyone with a path reads any
   shop's images via CDN, no auth. (§2)
3. **Path-trust forge on insert** — any active user can write objects under any
   WO prefix; no WO-existence / name-shape / shop check. (§3a)
4. **Cross-tenant writes** — `staff update shop` / `staff curate any` let any
   active user modify any shop's WOs and photos. (§3c/§3b)
5. **No size/MIME limits** on the bucket. (§2)
6. **Ordering hazard for the naive fix:** flipping the bucket private *before*
   tenant SELECT policies exist breaks ALL non-owner reads (no SELECT policy
   today). (§3a)

---

## D. Corrected migration order (for approval — nothing applied)

The plan is re-sequenced around live reality. Each stage is additive/reversible
with a hard stop and re-verification after it.

0. **Finish read-only baseline:** run §4 (helper source) and §6 (Git/Netlify).
   Confirm deployed == intended `main`.
1. **Backup / PITR checkpoint.**
2. **Apply Section 20 first** (`section-20-tenant-foundation.sql`): tenant tables,
   helpers, `shop_id` columns + stamping trigger, shop-scoped RLS replacing the
   pre-tenant policies. This is now the primary migration, not a precondition
   assumed done.
3. **Backfill + verify Section 20:** re-run §1 (all pass), §5d (zero rows),
   §3b/c/d (every policy carries `row_in_current_shop`). Verify existing rows got
   a correct `shop_id`. Two-shop cross-tenant test at the ROW layer.
4. **Apply Section 21** (`section-21-storage.sql`): storage helpers
   (`storage_wo_in_current_shop`, `storage_wo_owned_in_current_shop`,
   `storage_name_is_valid_photo`), the four `wop:` policies incl. a **non-owner
   SELECT** policy, retention columns. Bucket stays public.
5. **Deploy signed-URL frontend** (already in `supabase-client.js`); confirm no
   `getPublicUrl` in the served bundle (§6d). Reads keep working on public bucket.
6. **Test every photo surface** while still public, in two shops / two sessions.
   Confirm signing succeeds for authorized, fails cross-tenant.
7. **Flip bucket private** (`public=false`) + set `file_size_limit` /
   `allowed_mime_types`. Rollback = flip back (instant).
8. **Re-test**; monitor signing failures / 400s.
9. Purge worker (service-role) — separate, later, gated release. Existing objects
   untouched throughout.

**STOP here.** No DDL, no bucket change, no deploy. Awaiting your approval of this
re-sequenced plan and the two remaining read-only checks (§4, §6).
