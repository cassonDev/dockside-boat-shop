# Verifier Report — Private-Storage Cutover

**Verifier scope limitation (read first).** This verification ran in an
environment with access to the **working tree only**. I have **no git access**
and **no connection to the live Supabase project**. Therefore:

- Stage A (commit hash / match to `main`), Stage B & C (live schema, live
  storage, live policies, bucket flag), and Stages E/F (runtime + negative
  tests against a deployed app) **cannot be executed here**.
- I did fully verify **working-tree correctness** and **doc↔code consistency**
  with line-level evidence, and I did a static **Stage G** reliability review.

Items I cannot execute are marked **CANNOT VERIFY HERE (needs git/live)** — that
is a limitation of this environment, **not** a FAIL of the implementation. A
human or a git/Supabase-connected agent must run those before cutover.

---

## 1. PASS / FAIL summary

| Stage | Result |
|---|---|
| A — Git | CANNOT VERIFY HERE (needs git). Working tree is internally complete & consistent (evidence §7). |
| B — Live Supabase | CANNOT VERIFY HERE (needs live). SQL **source** defines all documented objects (evidence §7). |
| C — Live storage | CANNOT VERIFY HERE (needs live). Read-only classifier is present & correct for the task. |
| D — Deploy readiness | Static gates PASS; live/git gates deferred (table below). |
| E — Runtime | NOT APPLICABLE yet (not deployed). |
| F — Security negative tests | CANNOT VERIFY HERE (needs live). Policy **logic** reviewed statically (§4). |
| G — Reliability | Reviewed; findings in §3/§4. No data-exposure defects found in code. |

**No blocking issue found in the code or docs.** Blocking status for deployment
rests entirely on the un-run live/git gates.

---

## 2. Deployment-readiness gates (VERIFICATION.md §A)

| Gate | Verdict here | Evidence / why |
|---|---|---|
| Working tree matches `main` | CANNOT VERIFY HERE | no git access; cannot read SHA |
| No unexpected local mods / missing files / partial apply | PASS (working tree) | all documented symbols present, §7; page loads with no console errors |
| Live schema — Section 20 healthy | CANNOT VERIFY HERE | needs live; queries provided in STORAGE-PRIVACY.md §7 |
| Existing storage inventory exported | CANNOT VERIFY HERE | needs service-role key; script ready |
| Existing records classified | CANNOT VERIFY HERE | needs live; classifier ready |
| New policies apply without replacing unrelated | PASS (static) | §21 touches only `wop:*` + its own helpers/columns/view; idempotent guards, §7 |
| Signed URL authorized (Shop A) | NOT APPLICABLE yet | runtime, post-deploy |
| Cross-tenant signing blocked | CANNOT VERIFY HERE | runtime; logic reviewed §4 |
| Direct public URL before flip works | CANNOT VERIFY HERE | runtime |
| Direct public URL after flip fails | CANNOT VERIFY HERE | runtime |
| App surfaces render post-flip | NOT APPLICABLE yet | runtime |
| Cache isolation on switch/logout | PASS (code path) | `clearPhotoUrlCache` wired to both, §7; unique path keys |
| Rollback executable | PASS (documented) | policy drops + `set public=true` documented, §21/STORAGE-PRIVACY §8 |

**Do not proceed past any CANNOT-VERIFY gate without running it live.**

---

## 3. Findings by severity

### Blocking deployment issues
None found in code/docs. The *only* blockers are process gates that must be run
live: **(a)** confirm working tree == intended `main` SHA; **(b)** confirm live
DB is on Section 20 and apply §21; **(c)** the cross-tenant / post-flip
isolation runtime tests (VERIFICATION.md §F). Until those produce PASS, treat
deployment as **not proven**.

### High-priority (reliability, not security)
- **H1 — No retry/failed state for signing.** On partial signing failure the
  affected photos render as broken `<img>` with no retry affordance
  (`signPhotos` maps failures to `''`). Confirmed in code. UX gap only.
- **H2 — Print does not gate on sign success.** `printPage` re-signs, waits
  ~60 ms, then prints regardless — failed photos print broken. Confirmed
  (`index.html` ~2399–2405). No data exposure.

### Medium
- **M1 — Working-tree/prod drift unverifiable here.** Must be closed by Stage A.
- **M2 — Pre-existing orphans/bad-name objects** are reported by the classifier
  but unaddressed; review cat 3/5/7 output before/after flip.
- **M3 — Signed-URL total failure = all-blank gallery** with only a console
  error; no user-facing message. Not a crash.

### Low
- **L1 — 60 ms print delay is heuristic**, not a paint guarantee on slow devices.
- **L2 — TTL 3600 s** hard-codes the in-flight leak window; acceptable, tunable.
- **L3 — CORS `*`** on Netlify functions and **OpenAI image egress** — noted in
  original inspection; unrelated to bucket privacy; unchanged.

---

## 4. Static security review (Stage F logic, not executed)

Policy logic in `supabase-schema.sql` §21 is consistent with the documented
design and resists the named attacks *by construction* (must still be proven
live):

- **Forged WO path / arbitrary path:** `storage_wo_in_current_shop` requires a
  real `work_orders` row; `storage_name_is_valid_photo` enforces key shape →
  forged/malformed paths resolve to nothing. ✓ logic
- **Forged shop id:** storage policies never read a client shop id; they derive
  shop from the WO row via `row_in_current_shop(current_user_shop_id())`. ✓
- **Cross-shop upload/select/signing:** all gated on the WO being in the
  caller's current shop. ✓ (signing depends on the SELECT policy, effective only
  once the bucket is private — correctly documented.)
- **Cross-shop delete:** DELETE is owner-of-that-shop only; mechanics none. ✓
- **Cross-shop rename/move:** UPDATE `WITH CHECK` re-validates the new name to
  the same shop + shape. ✓
- **Logged-out / old public URL:** enforced only after `public=false`; correctly
  flagged as a post-flip runtime gate, not provable now.

Client side: DB stores paths only; no signed/public URL persisted; signed URLs
are memory-only and cleared on switch/logout; unique path keys prevent
cross-shop reuse. Confirmed in code (§7).

---

## 5. Recommended deployment decision

**Ready with documented limitations** — *conditional on the live/git gates
passing.* The implementation and documentation are internally complete,
consistent, and free of code-level security defects I can see. It is **not**
"Ready" unconditionally because isolation cannot be proven without the live
environment, and it is **not** "Not ready" because nothing in the working tree
is broken or contradictory. Concretely: run Stage A + Stage B/C + the Stage F
negative tests; if all PASS, deploy per VERIFICATION.md §B (public first, flip
last). Accept H1/H2 as known UX limitations for this release or schedule the
small follow-up.

---

## 6. Evidence appendix (§7)

Working-tree greps (line numbers as of this tree):

- `supabase-client.js`: `clearPhotoUrlCache` export (574); `createSignedUrls`
  (592); `signPhotos` (606) + `refreshPhotoUrls` alias (615); `photoFromRow`
  stores `storagePath`/`thumbPath`, `url:''` (622–624); purge/lineage fields
  mapped (645–649); replacement lineage stamp `replaced_by_photo_id` + archive
  (883–885). No executable `getPublicUrl` anywhere (only a prose comment, 559).
- `index.html`: `clearPhotoUrlCache` on shop-switch (2028) and sign-out (2099);
  sign-out drops tenant photo state (2101); `goToInvoice` re-signs (2390–2395);
  `printPage` re-signs + prints (2399–2405); both wired into render (4408, 4692).
- `supabase-schema.sql` §21: helpers `storage_wo_in_current_shop` (1769),
  `storage_wo_owned_in_current_shop` (1779), `storage_name_is_valid_photo`
  (1791); policies `wop: select/insert/update/delete` (1806/1814/1825/1841);
  retention columns (1854–1860); purge view (1873); **`set public=false` present
  ONLY as a commented deploy note (1886)** — bucket not flipped.
- No service worker / PWA / CacheStorage in project (search: none).
- `scripts/storage-inventory-and-classify.js` present; read-only; deletes
  nothing; emits the 7-category classification + orphan/purge reports.

**No fixes were applied. Verification only, per instruction.**
