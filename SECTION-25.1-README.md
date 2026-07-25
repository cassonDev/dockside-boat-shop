# Section 25.1 — Shop Config prepopulation fix (frontend-only)

**Change scope:** `goShopConfig()` load path in `index.html` only. No SQL, RPC,
RLS, onboarding, Team, Platform Admin, or save-path change.

## What changed

The Shop Config loader previously ran serial labels + shop + locations in one
`Promise.all` with a single shared `catch`, so any one failure left
`shopInfoDraft` null and blanked every field (including Shop Name). Now:

- Each fetch has its **own fallback**: serial labels → prior/empty; `fetchShop`
  → `null`; locations → prior/empty.
- If `fetchShop()` fails, the shop record **falls back to the already-loaded
  `s.shop`** from boot, so Shop Info / branding still populate.
- A serial-label or locations failure can no longer prevent `shopInfoDraft`,
  branding, features, or other shop fields from populating.

## Staging test checklist

- [ ] Open **Shop Configuration** → **Shop Name** is prefilled ("Lessard Marine Works").
- [ ] Legal name, phone, email, and address populate when saved data exists.
- [ ] **Locations** and **Features** tabs still load.
- [ ] Temporarily simulate a **locations** or **serial-label** failure (e.g. force those calls to reject in a staging build) → **Shop Info still populates**.
- [ ] Save one harmless field (e.g. phone), **refresh**, confirm it persists.
- [ ] Regression: Team, Platform Admin, onboarding, and shop switching unchanged.

## Files

- `index.html` (only `goShopConfig()` touched)
