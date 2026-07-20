# Verification Package — Private-Storage Cutover

**For the independent verifier (Claude Sonnet). This is a verification runbook,
not an implementation pass. No code is changed by following it.**

Companion to `STORAGE-PRIVACY.md`. That file is the implementation; this file is
the gate checklist, the exact live sequence, the evidence format, and the
pre-deploy risk to inspect.

---

## A. Gate results table (fill in with evidence)

| Gate | Required result | Evidence to capture | Pass? |
|---|---|---|---|
| Working tree | Matches intended GitHub `main` commit | `git rev-parse HEAD` == expected SHA; `git status` clean | |
| Live schema | Section 20 exists and healthy | §7(c) helper + table queries return all rows; §20G verification queries return 0 | |
| Existing storage | Bucket inventory exported | `report.json` from classifier saved & archived | |
| Existing records | Every current path classified | classifier cat totals; cat 3/5/7 lists reviewed | |
| New policies | Apply without replacing unrelated policies | §B step 6 diff of `pg_policies` before/after — only `wop:*` change | |
| Signed URLs | Authorized Shop A access succeeds | screenshot: A gallery renders; network 200 on `/object/sign/` | |
| Cross-tenant signing | Shop A cannot sign Shop B photo | signing call for B path → error/empty; screenshot | |
| Direct public URL BEFORE flip | Still works (expected) | GET legacy `/object/public/...` → 200 | |
| Direct public URL AFTER flip | Fails | same GET → 400/404 | |
| Application surfaces | All render after private cutover | each surface screenshot (list in §C.16) | |
| Cache isolation | Shop switch/logout removes prior-shop images | after switch A→B, no A image; after logout, none | |
| Rollback | Tested or fully executable | §B rollback commands dry-run confirmed | |

Record for each gate: **PASS / FAIL / N-A**, plus the artifact (screenshot,
query output, or command transcript). A single FAIL on an isolation gate
(cross-tenant signing, direct URL after flip, cache isolation) **blocks cutover**.

---

## B. Critical live sequence (do NOT flip private right after deploy)

1. Confirm the exact Git commit (`git rev-parse HEAD`).
2. Back up the database (dump / PITR checkpoint).
3. Export the entire bucket inventory:
   `node scripts/storage-inventory-and-classify.js --json before.json`
4. Run read-only Section 20 + photo-path verification (`STORAGE-PRIVACY.md` §7 a–g).
5. Run the classifier; save output (step 3 covers this — keep `before.json`).
6. Apply Section 21 additive SQL + policies. **Capture `pg_policies` before/after**
   and confirm only the six `wop:*` policies changed.
   - Rollback: `drop policy "wop: …"` (×4) + drop added columns/view/index.
7. Keep the bucket **public**.
8. Deploy the signed-URL application changes.
9. Test every photo surface (§C.16) — bucket still public.
10. Confirm **no runtime request uses `/object/public/`** (DevTools Network,
    filter `object/public`; expect zero; `object/sign` instead).
11. Test signed-URL creation across **two shops** (A signs A ✓; A signs B ✗).
12. Test a **disabled membership** (deactivate A-mechanic → their queries and
    signing return nothing).
13. Flip private: `update storage.buckets set public=false where id='work-order-photos';`
    - Rollback: `set public=true`.
14. Test **legacy `/object/public/` URLs → must now fail** (400/404).
15. Re-test all photo surfaces in **fresh browser sessions**.
16. Test **mobile camera upload, gallery selection, serial replacement, invoice
    preview, and print**.
17. Leave all existing objects untouched.

**The decisive post-cutover assertion:** a photo returned through **Shop A's
authorized DB query renders**, while the **same object cannot be obtained** by
Shop B, a logged-out browser, or a copied old `/object/public/` URL.

---

## C.16 Application surfaces to screenshot (each must render post-flip)

intake staged (pre-upload, local) · job gallery · thumbnails · lightbox · log
photo picker · activity feed photos · serial-number images · customer preview ·
invoice preview · print output · archived/historical views · QR-opened job.

---

## D. Pre-deploy risk to inspect — partial signed-URL failure (current behavior)

Findings from the shipped code (`supabase-client.js` `signPaths`/`signPhotos`,
`index.html` `printPage`). The verifier should reproduce, not assume:

| Question | Current behavior | Verify by |
|---|---|---|
| 10 rows load, 2 fail to sign — whole screen fails? | **No.** `signPhotos` fills `''` for failures; render continues. | Throttle/deny 2 paths; confirm 8 render. |
| Remaining 8 render? | **Yes.** | same |
| Visible retry state? | **No retry UI today.** Broken entries stay broken until next load. | observe; note as UX gap |
| Stale signed URL reused from another shop? | **No.** Cache keyed by globally-unique path; cleared on switch/logout. | switch shops; inspect no reuse |
| Total signing failure (call throws)? | All thumbs blank, **no crash**; error logged. | block `createSignedUrls`; confirm no crash |
| Print — waits or prints broken? | **Prints regardless** after re-sign + 60 ms; failed photos print broken. | fail one path; print; inspect |

**Conclusion:** security/isolation is correct; the practical weak point is the
**absence of a retry/failed-state UX** and **print not gating on sign success**.
This is a candidate for the *next* controlled release (a small, isolated UX
change) — explicitly out of scope for this verification/cutover pass.

---

## E. What this package deliberately does NOT do

No code changes; no deploy; no migration executed; no bucket flip; no object
deleted; no purge worker built. Those remain the human-approved deploy steps.
