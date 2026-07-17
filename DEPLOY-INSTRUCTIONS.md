# Deploy Instructions — Two-Role Model Update (2026-07)

This zip contains the updated app with the simplified role model:
**mechanic** and **shop_owner** only. Service Advisor is removed.
`platform_admin` is not a shop role and never appears in any shop UI.

## What changed
- `index.html` — Manage Role / Role Request show only Mechanic and Shop Owner (with explanatory text); mechanics can edit any job's details, photos, and serials, and use Archive; Shop Config, Audit Log, staff activation, and role controls remain owner-only.
- `supabase-schema.sql` — new migration **section 19** (bottom of file): data migration, role constraints, shop-wide mechanic RLS policies, activity-edit guard, drops advisor policies/helper.
- `netlify/functions/update-staff-role.js`, `manage-users.js`, `review-role-change.js` (and their root mirrors) — accept only mechanic/shop_owner; invites always start as mechanic.
- `supabase-client.js` — updated permission comments.

## Deploy steps
1. **Database first.** In the Supabase SQL Editor, run section 19 of
   `supabase-schema.sql` (everything from `-- 19. Two-role model` to the end).
   It is idempotent — safe to re-run. It:
   - converts existing service_advisor accounts to mechanic
   - tightens the `profiles.role` and `role_change_requests.requested_role`
     check constraints to two values
   - replaces assignment-scoped mechanic policies with shop-wide ones
2. **Reload the API schema cache.** Still in the SQL Editor, run:
   `notify pgrst, 'reload schema';`
   Dropping columns (section 19 removes `work_order_photos.equipment_id`,
   `is_primary_serial_photo`, and `work_orders.serial_number`) can leave
   PostgREST's cache stale, which surfaces in the app as
   *"Could not find the '…' column of '…' in the schema cache"*.
3. **Then deploy the site.** Push these files to the repo (or drag-deploy to
   Netlify). The Netlify functions redeploy automatically with the site.
   ⚠ The live build at boatshop.netlify.app that predates this package still
   sends `equipment_id` when saving a serial number — that's exactly the
   schema-cache error above. Deploying this package fixes it; no data is lost.
4. **Verify.**
   - Sign in as a mechanic: can open/edit ANY job, upload photos, edit
     serials, archive; no Shop Config or Audit Log in the nav.
   - Sign in as a shop owner: Manage Role card shows only MECHANIC and
     SHOP OWNER; selecting one shows its description.
   - Attempt to demote the last active owner: blocked with an error.
   - Scan a serial number on any job → choose a label → SAVE SERIAL NUMBER:
     saves cleanly (no schema-cache error), appears under SERIAL NUMBERS and
     as a tagged photo in the gallery.

## Order matters
Run the SQL **before** deploying the frontend. If the old constraint still
allows `service_advisor` while the new functions reject it, nothing breaks —
but if the new SQL runs after users keep writing advisor roles, you'd need to
re-run the data migration line. Running section 19 twice is harmless.

## Platform admin note
Do not add `platform_admin` to `profiles.role` or any dropdown. When you
build platform-level administration, store it in a separate table/claim and
grant it only via a secure server-side process (service role key), never
from the browser.
