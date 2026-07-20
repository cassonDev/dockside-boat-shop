# Multi-Tenant Foundation — Section 20

Turns the single-shop deployment into a true multi-tenant platform. **Nothing
here is deployed automatically. No production data is deleted or truncated.**
Read this end-to-end before running anything.

---

## 1. Tenant security model (plain language)

```
platform (this database)
  └─ shop            = a subscribing business/company     ← THE TENANT
       └─ shop_location   = a physical branch of that shop
            └─ shop_membership = a person's role in a shop (shop_owner | mechanic)
                 └─ tenant records (work orders, activities, photos, serials …)
```

- **The tenant boundary is `shop_id`.** Every tenant-owned row carries one, and
  every RLS policy independently requires `shop_id = current_user_shop_id()`.
  Two shops can coexist in the same database and never see each other's data.
- **A location is NOT a tenant.** It is an operational subdivision of a shop
  (a branch/marina/yard). Work orders belong to one shop *and* one location.
  In this first phase a mechanic can work every job in their shop regardless of
  location — location is a *filter*, not an access wall. That wall remains
  possible later without reshaping the schema.
- **The active shop is explicit and server-verified.** It lives in
  `profiles.active_shop_id`. A trigger blocks pointing it at a shop you don't
  actively belong to, and `current_user_shop_id()` re-verifies membership on
  every call — a shop id sent by the browser is never trusted on its own. If a
  user has no explicit active shop, it resolves deterministically to their
  (single) active membership.
- **Roles are per shop.** `shop_memberships.role` is the RLS authority.
  `profiles.role` is *kept* during a staged migration (the app UI still reads
  it) and held in sync by the server functions; it is dropped only in a later
  migration once no executable code depends on it.
- **Platform admin is not a shop role.** It lives in its own `platform_admins`
  table with **zero client RLS policies** — readable/writable only by the
  service-role key from a secure server process. It is deliberately NOT a
  blanket bypass baked into tenant policies.
- **Clients cannot forge `shop_id`.** A `before insert` trigger stamps it from
  `current_user_shop_id()`; a `before update` trigger forbids moving a row
  between shops; and every `WITH CHECK` re-asserts the current shop.

---

## 2. Files changed this pass

| File | Change |
|------|--------|
| `supabase-schema.sql` | **Section 20 (20A–20H)** — new tables, helpers, backfill, tenant columns, RLS rewrite, indexes, verification queries, notes. |
| `supabase-client.js` | `activeShopId` on profile; `locationId`/`shopId` on jobs; `fetchJobs({locationId})`; new: `fetchMyMemberships`, `setActiveShop`, `fetchShop`, `updateShop`, `fetchLocations`, `createLocation`, `updateLocation`, `fetchShopMembers`. |
| `index.html` | Boot loads memberships + active shop; shop switcher in the hamburger menu (only when >1 membership); switching calls `setActiveShop` then does a **full reload** so no previous-shop state lingers. |
| `netlify/functions/update-staff-role.js` | After updating `profiles.role`, syncs `shop_memberships.role` in the caller's active shop. |
| `netlify/functions/manage-users.js` | `set_role` syncs membership role; `invite_staff` (formerly `invite_mechanic`, kept as an alias) derives `shop_id` from the inviter's active shop and creates the membership explicitly — assignable roles are mechanic or shop_owner only. |
| `netlify/functions/review-role-change.js` | On approval, syncs `shop_memberships.role` in the request's shop. |

---

## 3. Deployment order (exact)

1. **Back up the database** (Supabase dashboard → Database → Backups, or
   `pg_dump`). Non-negotiable — this migration alters every tenant table.
2. **Run `supabase-schema.sql`** in the SQL Editor. Section 20 is idempotent
   and fails loudly if any row would be left unassigned. If 20C raises
   *"expects 0 or 1 pre-existing shop"*, stop — you have an unexpected state;
   migrate by hand.
3. **Run the section 20G verification queries** (below / inline in the file).
   Every one must return zero rows (or the stated expectation) before you
   proceed.
4. **Reload the API schema cache:** `notify pgrst, 'reload schema';`
5. **Deploy the site + functions** (push to `main` / Netlify). The functions
   redeploy with the site.
6. **Smoke test** signed in as the existing owner: dashboard loads, a job
   opens, intake creates a job (lands in the primary location), a serial number
   saves, staff roster + audit log load. A single-shop user sees **no** shop
   switcher.

---

## 4. Verification & isolation tests (section 20G)

Run these in the SQL Editor after step 2. Each should return **0 rows** unless
noted:

1. No tenant row with a null `shop_id` (union across all 8 tenant tables).
2. No work order whose `location_id` belongs to another shop.
3. Every active profile has an active membership.
4. Every profile's `active_shop_id` is one of its active memberships.
5. No duplicate `(profile_id, shop_id)` membership (also enforced by a unique
   constraint).
6. Exactly one primary location per shop.

**Cross-tenant negative tests** — create a second test shop `B` and a test user
who belongs only to `B`, then sign in as a shop-`A` member and confirm:

7. `select count(*) from work_orders;` → only shop A's rows.
8. Insert a work order with `shop_id = <B>` → trigger rewrites it to A (or
   `WITH CHECK` blocks it); it never lands in B.
9. `update work_orders set shop_id = <B>` → `forbid_shop_change` raises.
10. As a mechanic, `update shop_memberships set role='shop_owner' where
    profile_id = auth.uid()` → blocked (owner-only policy).
11. As a shop owner, `insert into platform_admins …` → blocked (no client policy).
12. Deactivate a membership, re-run test 7 → 0 rows (tenant access lost).

A ready-to-paste version of 1–6 is in the commented block at the end of
section 20G in `supabase-schema.sql`.

### Manual UI tests

**Desktop:** sign in as owner → dashboard, open job, edit fields, add activity,
add photo, save serial number, staff roster, promote a mechanic to owner then
confirm they gain Shop Config/Audit access, audit log, archive/restore.
**Mobile (narrow):** hamburger menu opens; Shop Config / Audit / Archive live
inside it; if the account belongs to >1 shop the **SWITCH SHOP** list appears —
switching reloads and the previous shop's jobs are gone; QR-scanned job opens
only if you belong to that job's shop.

---

## 5. Rollback considerations

- **Structural rollback is destructive of the new model, not of your data.**
  The safe rollback is *restore the pre-migration backup* (step 1). Prefer that.
- If you must partially revert without a restore: the new SELECT policies can be
  dropped and the pre-section-20 policies recreated from git history; the added
  `shop_id`/`location_id` columns and new tables can be left in place (they are
  additive and don't break the old single-shop code paths, since RLS falls back
  to the single resolved shop). Do **not** `drop table shops cascade` — the FKs
  use `on delete restrict`/`cascade` deliberately and a cascade would delete
  memberships.
- `profiles.role` is intentionally still present, so reverting the frontend to a
  pre-20 build keeps working against the migrated DB.

---

## 6. RLS policy checklist (every policy reviewed)

Rewritten to add an explicit `row_in_current_shop(shop_id)` predicate:

- `work_orders`: read / insert / update / delete (owner) — **replaced**.
- `work_order_comments`: read / insert / owner-update — **replaced**.
- `work_order_photos`: read / insert / update — **replaced**; dropped the
  stale `photos: uploader update own` (section 5) that had no shop scope.
- `activities`: read / insert / author-or-owner-update — **replaced**.
- `activity_history`: read / insert — **replaced** (scoped via parent activity).
- `work_order_serial_numbers`: read / insert / update — **replaced**.
- `shop_serial_label_options`: owner-manage / read — **replaced**.
- `role_change_requests`: owner-manage / self-read / self-insert — **replaced**.
- `audit_log`: owner-read — **replaced** (now `+ row_in_current_shop`).
- `profiles`: owner now manages only profiles sharing their shop — **replaced**;
  self read / self-update-limited retained.
- `shops`, `shop_locations`, `shop_memberships`, `platform_admins` — **new**.
- `storage.objects` (work-order-photos): insert / owner-manage — **replaced**,
  scoped through the work order's shop.

Helpers redefined so all section 1–19 owner/active checks became shop-scoped
automatically: `is_shop_owner()`, `is_active_user()`, plus new
`current_user_shop_id`, `current_user_membership_role`, `is_active_shop_member`,
`is_shop_owner(uuid)`, `is_platform_admin`, `row_in_current_shop`.

---

## 7. Codebase scan (as requested)

- **`profiles.role` in executable code:** still referenced throughout
  `index.html` (role display + owner gating via `profile.role`) and read by the
  three Netlify functions. **Intentional** — the staged migration keeps
  `profiles.role` live and in sync with `shop_memberships.role`. Do not drop it
  until a follow-up migration migrates these reads to membership role.
- **Direct client-provided `shop_id`:** none. The client never sends `shop_id`
  on insert; the DB trigger stamps it. `insertJob` may send `location_id`
  (validated server-side against the shop).
- **Unscoped tenant queries:** the client's `fetch*` queries don't add a
  `shop_id` filter, but RLS scopes them to the current shop server-side. This is
  safe; an explicit `shop_id` filter is a clarity/perf nicety, added where a
  location filter already exists (`fetchJobs`).
- **Hard-coded initial-shop identifiers:** none. 20C resolves the shop by
  deterministic lookup and creates `'Lessard Marine Works'` only if absent — no
  literal UUIDs anywhere.
- **Permissive pre-existing policies:** the one gap found (`photos: uploader
  update own`) is now dropped.

---

## 8. Assumptions & unresolved risks

1. **Public photo bucket.** `work-order-photos` is `public = true`, so image
   *bytes* are reachable by anyone who has the object path via the CDN,
   bypassing the SELECT policy. Cross-tenant isolation of image bytes is
   therefore **not** enforced yet (this matches the prior single-shop design).
   Fix: make the bucket private and serve via signed URLs. Tracked, out of scope
   here.
2. **JWT claim not yet wired.** Isolation currently rests on
   `profiles.active_shop_id` + membership re-verification, which is solid. For
   defense in depth you may later add a Supabase custom access-token auth hook
   that stamps `shop_id` into the JWT; `current_user_shop_id()` already reads a
   claim first if present.
3. **Fresh-deployment bootstrap.** ✅ Resolved. `bootstrap_shop_owner` now
   creates the shop + primary location + owner membership + `active_shop_id` +
   an audit event in one protected path, and refuses to run once any shop
   exists. Still gated by `SHOP_OWNER_BOOTSTRAP_CODE`.
4. **`profiles.role` dual-write.** Role changes now write both `profiles.role`
   and `shop_memberships.role`. If a future code path writes only one, they can
   drift. The follow-up migration that removes `profiles.role` closes this.
5. **`activity_history` / `audit_log` historical rows** were backfilled to the
   default shop; any pre-existing rows are attributed to it. Correct for a
   single-shop history.

---

## 9. RLS coverage matrix (item 5)

Every tenant table has an explicit answer in every applicable column.
`shop()` = the row's `shop_id` must equal `current_user_shop_id()` (via
`row_in_current_shop`). `owner` = `is_shop_owner()` (shop-scoped). `active` =
`is_active_user()` (active account **and** active member of current shop).
Inserts stamped/validated by the `set_shop_id` trigger; cross-shop moves
blocked by `forbid_shop_change`.

| Table | SELECT | INSERT (WITH CHECK) | UPDATE (USING) | UPDATE (WITH CHECK) | DELETE |
|-------|--------|---------------------|----------------|---------------------|--------|
| work_orders | active + shop | active + shop + `created_by=uid` | active + shop | active + shop | owner + shop |
| work_order_comments | active + active-flag + shop | active + shop + `author_id=uid` | owner + shop | owner + shop | — (soft delete via update) |
| work_order_photos | active + active-flag + shop | active + shop + `created_by=uid` | active + shop | active + shop | — (soft delete) |
| activities | active + active-flag + shop | active + shop + `author_id=uid` | active + shop + (author or owner) | active + shop | — (soft delete) |
| activity_history | via parent activity's shop | `edited_by=uid` + parent shop | — (append-only) | — | — |
| work_order_serial_numbers | active + active-flag + shop | active + shop + `created_by=uid` | active + shop | active + shop | — (soft delete) |
| shop_serial_label_options | active + shop | owner + shop | owner + shop | owner + shop | owner + shop |
| role_change_requests | (self or owner) + shop | self + shop | owner + shop | owner + shop | owner + shop |
| audit_log | owner + shop | — (trigger/service-role only) | — | — | — |
| shops | member of row | — (service-role/bootstrap) | owner of row | owner of row | — |
| shop_locations | member of shop | owner of shop | owner of shop | owner of shop | owner of shop |
| shop_memberships | self or owner-of-shop | owner of shop | owner of shop | owner of shop | owner of shop |
| platform_admins | — (no client policy) | — | — | — | — |
| profiles | self, or owner of shared shop | self or owner | self, or owner of shared shop | self (limited) or owner | — |
| storage.objects (work-order-photos) | *public bucket — see risk #1* | active + WO's shop | owner + WO's shop | owner + WO's shop | owner + WO's shop |

Reading the matrix: the classic RLS crack (reads protected, writes forge
ownership) is closed — every INSERT has a `WITH CHECK` that re-asserts the
current shop, and `created_by`/`author_id`/`edited_by` are pinned to `auth.uid()`
so a caller can't attribute a row to someone else. The one caveat remains the
**public photo bucket** (risk #1) — object bytes are not yet tenant-isolated;
that is the separate private-storage workstream.

## 10. Function-level tenant trust (item 4)

All three privileged Netlify functions derive shop context from the caller's
**authenticated** membership (`profiles.active_shop_id` re-verified against
`shop_memberships`), never from request JSON:

- `update-staff-role`: rejects unless caller is an active **owner** of their
  active shop AND the target is an active member of that same shop; last-active-
  owner guard counts owner *memberships in that shop*; writes membership role
  first, then legacy role.
- `manage-users` `set_role`: same membership-first write, scoped to the caller's
  active shop.
- `manage-users` `invite_staff`: derives `shop_id` =
  caller's active shop (never from request JSON), rejects any role other than
  mechanic/shop_owner, and creates the membership explicitly/idempotently. An
  existing account from another shop is added only after explicit owner
  confirmation, and its `active_shop_id`/other memberships are never touched.
  Public self-signup is removed; onboarding is invitation-only and stays
  separate from creating a brand-new tenant.
- `review-role-change`: applies the grant in the request row's own `shop_id`.

Still to test with live accounts (documented for the verifier / QA): owner
submitting another shop's id (rejected — id is ignored, caller's shop is used);
mechanic calling `update-staff-role` directly (403 — not an owner); disabled
owner inviting (403 — `is_active` check); two-shop owner inviting with the wrong
active shop (invite lands in whichever shop is active — switch first).
