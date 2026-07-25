# Section 25.5 — Existing-User Agreement Acceptance Gate

Existing production users (owners **and** mechanics, incl. platform admins) who
pre-date Section 25, or who haven't accepted the **current** agreement version,
must accept it before using the app — **without** losing their shop, membership,
role, jobs, or data.

## No SQL required

Reuses the existing `accept_legal_agreement` RPC and `legal_acceptances` table
(Section 25). The acceptance check is a read using the existing self-read RLS on
`legal_acceptances` (a user only ever sees their own acceptance rows), so
identity is resolved server-side from `auth.uid()` — no profile id is sent and
no schema change is needed. **Deliverable: frontend only.**

## Changed files

- `supabase-client.js` — new read-only `fetchAgreementGateStatus(kind)` →
  `{ agreement, accepted }`. `accepted` is true only when a current agreement
  exists **and** the caller has an acceptance row for that exact version, so a
  newly published version flips it back to false and re-gates.
- `index.html` — boot check + agreement-gate screen + accept handler.

## Boot order (updated)

```
authenticated session
  → load profile
  → load memberships + platform-admin status + current agreement + acceptance
  → if NO membership → existing owner onboarding (agreement + create shop)   [unchanged]
  → else if current agreement exists AND not accepted → AGREEMENT GATE        [25.5, new]
        → accept → reload → boot resumes existing shop/session
  → else → normal app load
```

The gate returns early **before** any tenant load and, on accept, calls
`accept_legal_agreement` then reloads — boot then re-runs, finds the acceptance,
and proceeds into the user's existing shop. The "create your shop" step remains
**only** for users who genuinely have no membership after accepting.

## Design guarantees (maps to the requirements)

- Applies to existing owners, mechanics, and platform admins (universal boot check).
- Never creates/modifies a shop, location, profile, membership, role, or
  active-shop selection — it only writes an acceptance row via the existing RPC.
- Identity is `auth.uid()` (server-side); no client-supplied profile id.
- Platform admins are **not** exempt (no documented reason to exempt them).
- Already-accepted users skip the gate; a newer current version re-gates everyone.

## Staging tests

- [ ] **Existing owner, no acceptance** → sees agreement, accepts, lands in existing shop with owner role intact.
- [ ] **Existing mechanic, no acceptance** → sees agreement, accepts, lands in existing shop as mechanic.
- [ ] **Existing accepted user** → does **not** see the agreement; goes straight to the app.
- [ ] **Fresh user (no shop)** → still goes to owner onboarding (agreement + create shop); unaffected.
- [ ] **No duplication** → after accepting, no new shop / location / membership / profile is created (verify row counts unchanged except one new `legal_acceptances` row).
- [ ] **New version** → publish `pilot_agreement` v2 as current; previously-accepted users are re-gated and must accept v2.
- [ ] **Isolation & roles** → tenant isolation, roles, and active-shop selection unchanged before and after.
- [ ] **Platform admin** → also gated; after accepting, Platform Admin area still works.

## Marc (concrete path)

Marc signs in with his existing account → the app stops him at the agreement
page → he accepts → he's dropped back into **Lessard Marine Works** with his
existing owner role and data intact. No removal, no re-onboarding.

## Rollback

Frontend-only: redeploy the previous `index.html` + `supabase-client.js`. The
`legal_acceptances` rows already recorded remain valid (no schema change to undo).
