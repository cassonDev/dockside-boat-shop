# Deploy — Easy Instructions (Private Storage)

Frozen release. Follow in order. Nothing here deletes photos. **Back up first.**

---

## 0. Back up (required)
Supabase Dashboard → Database → Backups → **create on-demand backup**. Note the time.

## 1. Run the SQL
Supabase Dashboard → **SQL Editor** → paste the **entire** `section-21-storage.sql` → **Run**.
- ⚠️ Use `section-21-storage.sql`, **NOT** the full `supabase-schema.sql` (that one re-runs Section 20 and fails on the missing `slug` column).
- The **preflight** at the top must show every row `ok = true`. If any is false, **STOP** — don't run the rest.
- The **verification** at the bottom should return **3 / 4 / 6 / 1** rows (helpers / policies / columns / view).

## 2. Keep the bucket PUBLIC
Do nothing to the bucket yet. It stays public until the app is deployed and tested.

## 3. Deploy the app
Push/deploy the site as usual (Netlify). No function changes needed.

## 4. Test while still public
Open a job → photos load. DevTools → Network: requests say **`/object/sign/`** (not `/object/public/`). Check gallery, lightbox, serial photos, print.

## 5. Two-shop check
Sign in as Shop A and Shop B in separate sessions. A sees only A's photos. Switch shop / log out → old photos gone.

## 6. Flip to PRIVATE (only after 4 & 5 pass)
SQL Editor → run:
```sql
update storage.buckets set public = false where id = 'work-order-photos';
```

## 7. Re-test
Repeat steps 4–5 in fresh sessions. Also confirm an **old `/object/public/…` URL now fails (400/404)**.

## Rollback
- Images break after flip? → `update storage.buckets set public = true where id='work-order-photos';` (instant).
- Cross-tenant leak? → **keep it private**, don't reopen; investigate.

Full detail: `DEPLOYMENT-PLAYBOOK.md`.
