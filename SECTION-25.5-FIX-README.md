# Section 25.5 — Gate not appearing: root cause & fix

## Root cause (confirmed by code trace)

The acceptance lookup in `fetchAgreementGateStatus()` filtered **only** by
`agreement_id`, not by the current user:

```js
supabase.from('legal_acceptances').select('id').eq('agreement_id', agreement.id).limit(1)
```

The `legal_acceptances` self-read RLS policy is:

```
using (profile_id = auth.uid() OR public.is_platform_admin())
```

So for a **platform admin** (the account used to test — and Marc, who is being
made platform admin), that query is not limited to their own rows: it returns
**every** user's acceptance of the current agreement. If *any other* user has
accepted the current version, `data.length > 0` → `accepted = true` → the gate is
skipped. Deleting the tester's own acceptance row therefore had no effect — the
query never depended on their row. **This is the loose wire.**

Second defect (requirement 5): the boot `catch` did
`gateStatus = { accepted: true }` — i.e. any error verifying acceptance **failed
open** and dropped the user into the app.

Non-causes ruled out: the gate branch *is* reached before tenant boot; column
names (`agreement_id`, `profile_id`) are correct; `fetchCurrentLegalAgreement`
uses `is_current = true` + `maybeSingle()`.

## Smallest fix (frontend only)

1. **Scope the acceptance query to the caller.** Resolve the user from the
   authenticated session (`auth.uid()`, not a client-passed id) and add
   `.eq('profile_id', uid)`. Now a platform admin is evaluated on *their own*
   acceptance, exactly like any other user.
2. **Fail closed.** On any error verifying acceptance, boot now stops with a
   clear "couldn't verify your agreement acceptance" message instead of entering
   the app.
3. **Temporary staging diagnostics** (guarded by `window.__SEC255_DEBUG`, on by
   default; set it to `false` to silence, and remove before production) log:
   auth/profile id, the resolved gate uid, current agreement id/kind/version/
   is_current, the exact acceptance rows returned, the `accepted` result, the
   chosen branch (`SHOW_GATE` / `ALREADY_ACCEPTED` / `NO_CURRENT_AGREEMENT`), and
   on error the full Supabase `code / message / details / hint`.

No SQL change. The RLS policy is intentionally left as-is (platform admins
legitimately need to read all acceptances for the Platform Admin agreement-status
column); the fix is to scope the *gate's* query to the caller.

## Confirm the agreement is current (operator SQL)

```sql
select id, kind, version, is_current
from public.legal_agreements
where kind = 'pilot_agreement'
order by version desc;
```
Expect exactly one row with `is_current = true`. If none is current, the gate is
correctly skipped (nothing to accept) and the diagnostics log
`NO_CURRENT_AGREEMENT` — fix by flagging the intended version current.

## Changed files

- `supabase-client.js` — `fetchAgreementGateStatus()` scoped to `auth.uid()`; returns `{ agreement, accepted, rows, uid }`.
- `index.html` — boot fails closed + temporary diagnostics.

## Staging checklist

- [ ] **Platform-admin owner (Marc), own acceptance deleted** → gate now appears; accept → returns to existing shop, owner role intact.
- [ ] Console shows `branch: SHOW_GATE`, `gateUid` = his profile id, `acceptanceRows: []`.
- [ ] **Non-admin owner, no acceptance** → gate appears; accept → existing shop.
- [ ] **Non-admin mechanic, no acceptance** → gate appears; accept → existing shop.
- [ ] **Already-accepted user** → no gate (`branch: ALREADY_ACCEPTED`, one row for their own id).
- [ ] **Platform admin who HAS accepted** → no gate, even though other users' rows exist (query is now per-user).
- [ ] **Simulate an error** (e.g. temporarily rename the table in a throwaway staging build) → boot shows the agreement-verification error and does **not** enter the app (fail closed).
- [ ] **New version** published current → previously-accepted users re-gated.
- [ ] No shop/location/membership/profile created; roles + isolation unchanged.
- [ ] Remove/disable diagnostics before the production promotion.
