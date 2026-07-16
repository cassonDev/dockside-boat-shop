# Dockside — Supabase Auth + RLS Setup

## 0. What's in this deployment
- `index.html` — the live app (Supabase Auth, roles, RLS-backed data, comments,
  archive/restore, audit log). Kept in sync with the design source — no
  hand-editing needed before deploy.
- `supabase-client.js` — auth + data access. Reads its Supabase URL/key from
  `window.__SUPABASE_CONFIG__`, which is generated at **build time** by
  `scripts/generate-config.js` from your Netlify environment variables —
  no value is ever committed to the repo.
- `netlify/functions/manage-users.js` — privileged user management
  (bootstrap first shop owner, invites, role/active changes) using the
  service_role key.
- `netlify/functions/ai-extract.js` — server-side AI extraction for the
  New Job Intake and Log Work dictation flows (see section 7).

## 1. Supabase project config
In the Supabase dashboard, go to **Project Settings → API** and copy:
- **Project URL**
- **anon / publishable key**

You'll set both as Netlify environment variables in section 3 — nothing
Supabase-related is hardcoded anywhere in this repo.

Then:
1. **SQL Editor → New query** → paste all of `supabase-schema.sql` → Run.
   This creates `profiles`, `work_orders`, `work_order_comments`, `audit_log`,
   every trigger/function, and RLS policies. Safe to re-run.
2. **Authentication → Providers** → confirm Email provider is enabled.
3. **Authentication → URL Configuration** → set Site URL to your deployed
   Netlify URL (needed for invite/reset email links to land correctly).
4. **Authentication → Emails** → customize the "Invite user" template if
   you want shop branding (optional).

## 2. Create the first shop_owner (secure one-time bootstrap)
No manual SQL needed. The app has a self-disabling bootstrap flow:

1. Set a `SHOP_OWNER_BOOTSTRAP_CODE` env var in Netlify (any strong random
   string) and share it out-of-band (text/Slack/1Password) with whoever is
   setting up the shop — never commit it to source.
2. On the sign-in screen, click **"First time setting up this shop? Create
   the owner account"**, fill in name/email/password + the setup code, submit.
3. The Netlify Function checks the `profiles` table for any existing
   `role = 'shop_owner'` row. If none exists **and** the code matches, it
   creates the account with `role: 'shop_owner'` set via Supabase
   `app_metadata` (service-role only — a regular signup can never set this
   itself). If a shop owner already exists, the endpoint refuses — even
   with the correct code — so it can only ever be used once.
4. From then on the link disappears from the sign-in screen (the app checks
   bootstrap status on load) and the endpoint permanently 403s. There's
   nothing to manually "turn off" — you may still rotate/remove the
   `SHOP_OWNER_BOOTSTRAP_CODE` env var afterwards as extra hygiene.

Every account after that must be a mechanic invited from the Mechanics
screen (shop_owner only) or a new shop_owner promoted via `set_role` by an
existing shop_owner — never created by hand or by public signup.

## 3. Netlify deployment
1. Deploy the `netlify-deploy/` folder as your site root (it includes
   `netlify.toml`, `scripts/generate-config.js`, and
   `netlify/functions/{manage-users,ai-extract}.js`).
2. **Site settings → Environment variables**, add:
   - `SUPABASE_URL` — your Supabase project URL (section 1)
   - `SUPABASE_ANON_KEY` — the anon/publishable key (section 1). Read into
     the browser bundle at build time by `scripts/generate-config.js` —
     never committed to source. `netlify.toml` exempts this and
     `SUPABASE_URL` from Netlify's secret scanner via
     `SECRETS_SCAN_OMIT_KEYS`, since both are meant to be public
     (Row Level Security, not secrecy, is what protects your data) —
     nothing else is exempted.
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role`
     secret key. **Never** put this in frontend code or commit it.
   - `SHOP_OWNER_BOOTSTRAP_CODE` — a strong random string used once to
     create the first shop_owner (see section 2). Safe to remove/rotate
     after the first shop owner exists.
3. Deploy. The function is reachable at `/.netlify/functions/manage-users`
   and is called only by `supabase-client.js`'s `inviteMechanic`,
   `setUserActive`, `setUserRole`, `deleteUserAccount` helpers — the
   frontend never touches the service role key.
4. Netlify's build needs to install the function's dependency
   (`@supabase/supabase-js`) — a `package.json` is included in
   `netlify/functions/`; Netlify installs it automatically at build time.

Note: `netlify-deploy/index.html` and `netlify-deploy/supabase-client.js` are
kept in sync with the design source on every update — this is what you
deploy as-is, no manual copying needed. The Netlify build step
(`node scripts/generate-config.js`, wired in `netlify.toml`) writes
`config.js` from your environment variables on every deploy — it is
`.gitignore`d and never committed.

## 7. AI extraction (voice/typed intake & log work)
Both the New Job Intake and Log Work screens let a mechanic dictate or type
free-form notes and extract structured fields with one click. In the deployed
app this calls `netlify/functions/ai-extract.js`, which uses your own OpenAI
key server-side — no AI key ever reaches the browser.

1. Set `OPENAI_API_KEY` in Netlify env vars (Site settings → Environment).
2. Optionally set `OPENAI_MODEL` (defaults to `gpt-4o-mini`).
3. That's it — the client calls `/.netlify/functions/ai-extract` automatically.

(While iterating on the design inside this tool's own preview, extraction
falls back to the tool's built-in AI helper if the Netlify function isn't
reachable yet — this fallback does nothing once deployed for real users.)

## 4. How auth + roles work
- Login/signup screens use `supabase.auth.signInWithPassword` /
  `signUp` (Supabase Auth v2 JS client). Sessions persist via
  `persistSession: true` (localStorage), so users stay signed in across visits.
- Email/password fields use `autocomplete="username"` /
  `autocomplete="current-password"` (or `new-password` on sign-up) inside a
  real `<form>`, which is what iOS needs to offer Face ID–unlocked
  Password AutoFill — no custom biometric code involved.
- A DB trigger (`handle_new_auth_user`) creates a `profiles` row for every
  new `auth.users` row, defaulting to role `mechanic`. Invited users get
  `role: 'mechanic'` set explicitly by the invite function.
- Only two roles exist: `shop_owner` and `mechanic`, enforced by a CHECK
  constraint on `profiles.role`.

## 5. What's enforced server-side (not just in the UI)
- RLS is enabled on every table; there are no anonymous policies anywhere.
- `shop_owner` has full access to `profiles`, `work_orders`,
  `work_order_comments`. `mechanic` can read active work orders/comments,
  but can only **update** a work order assigned to them, and a trigger
  (`enforce_work_order_edits`) blocks mechanics from changing
  reassignment/customer/boat/issue/priority/size/archive fields even on
  their own jobs — only `status`, `entries`, and `photos` are editable.
- `audit_log` has a SELECT policy for `shop_owner` only and **no**
  insert/update/delete policy for any client role — every row is written
  by a `SECURITY DEFINER` trigger, so the frontend cannot forge, edit, or
  delete audit history.
- Disabling a mechanic (`active = false`) blocks both app-level access
  (RLS checks `is_active_user()`) and sign-in itself (the Netlify function
  also applies an auth-level ban).
- Work orders use soft delete (`active`, `archived_at`, `archived_by`) —
  "Archive" in a job's detail view, "Restore" from the Archive screen —
  so full history is preserved.

## 8. Unified photo gallery (Supabase Storage)
Every photo — from New Job Intake, Log Work, or added directly on a job's
page — lands in ONE gallery per work order instead of being duplicated into
separate intake/log-work blobs:
- `work_order_photos` table (metadata: caption, categories, display order,
  customer visibility, timestamps, and an `annotations` jsonb column
  reserved for future markup) and the `work-order-photos` Storage bucket
  (actual image bytes) are both created by `supabase-schema.sql` section 10
  — re-run that file in the SQL Editor to pick this up if you set the
  project up before this feature existed.
- The bucket is public for reads (fast thumbnails/full-res without signed
  URLs) but writes are RLS-locked to the shop_owner or the mechanic
  assigned to that work order.
- Photos are captured client-side through a canvas-based enhancement step
  (rotate, auto-enhance, brightness/contrast/saturation) before upload —
  a full-resolution JPEG and a small thumbnail are generated and stored;
  the database only ever holds metadata + storage paths, never base64 image
  data, so a work order can hold hundreds of photos without bloating rows.
- Work-log entries reference gallery photos by id (`entries[].photoIds`)
  rather than owning their own images.
No additional Netlify environment variables are needed for this — it uses
the same `SUPABASE_URL` / `SUPABASE_ANON_KEY` already configured in section 3.

## 9. Serial Number Capture
A dedicated workflow — separate from the general photo gallery — for reading
and recording an equipment/hull serial number from a photo:
1. On a job's page, the **SERIAL NUMBER** card shows a **SCAN SERIAL NUMBER**
   button (or **RE-SCAN / CHANGE** once one exists).
2. Camera or photo-library picker opens; after picking a photo the app shows
   "Reading serial number…" while `netlify/functions/extract-serial-number.js`
   (a vision-capable OpenAI call, server-side — no AI key reaches the browser)
   reads the plate.
3. A review screen shows the photo, the detected value in an editable field,
   and a confidence warning when the reading is uncertain. **Nothing saves
   until the user reviews and confirms** — the AI never silently overwrites
   or invents characters; an unreadable plate returns a blank field instead.
4. Saving writes, in order: the photo (tagged `photo_type = 'serial_number'`
   in `work_order_photos`, not a normal gallery photo) → `work_order_photos`
   row with the reviewed `extracted_text` → `work_orders.serial_number`. If
   any step fails, the review screen and typed value are preserved so the
   user can retry — the app never ends up with a serial number and no photo,
   or vice versa (`uploadSerialNumberPhoto` in `supabase-client.js`).
5. The tagged photo shows a **SERIAL NUMBER** badge in the gallery and is
   filterable via the existing category chips ("Serial Number" is one of the
   photo categories). Manually correcting the serial-number field also
   updates the linked photo's `extracted_text` (`correctSerialNumber`), so
   the two never drift apart. A `serial_number_captured` activity is posted
   to the job's timeline, and every capture/correction is recorded in
   `audit_log` automatically via the existing triggers on `work_orders` and
   `work_order_photos`.
6. Re-scanning never deletes the previous photo — it's kept for history and
   demoted from `is_primary_serial_photo`, while the newest reviewed photo
   becomes primary (enforced by a unique partial index, one primary per
   work order/equipment).
7. Schema (section 18 of `supabase-schema.sql`): `work_orders.serial_number`,
   plus `work_order_photos.photo_type` / `extracted_text` /
   `extraction_confidence` / `equipment_id` (reserved for a future
   multi-equipment table — hull/engine/trailer/battery each with their own
   serial — not built yet since no shop has asked for it) / `is_primary_serial_photo`.
   No new RLS policies are needed — the existing `work_order_photos` and
   `work_orders` policies already cover these columns.
8. Optional env var: `OPENAI_VISION_MODEL` (defaults to `gpt-4o-mini`) —
   same `OPENAI_API_KEY` as section 7 is reused.

## 10. Testing checklist
1. Sign up a new email → confirm the confirmation email flow → sign in.
   Confirm a `profiles` row was created with `role = mechanic`.
2. Promote that user to `shop_owner` via SQL, sign in — confirm you now see
   Archive/Audit Log nav items and the invite form on Mechanics.
3. As shop_owner, invite a mechanic by email — confirm they receive an
   email and can set a password and sign in.
4. As the mechanic, confirm you can see jobs, log work, add comments, but
   cannot see Archive/Audit Log nav items or the invite form.
5. Try (via API/devtools) to have the mechanic update a job **not**
   assigned to them — confirm it's rejected.
6. Try to have the mechanic change `assigned_mechanic` or `archived_at` on
   their own job — confirm the trigger rejects it.
7. As shop_owner, disable the mechanic's account — confirm they're signed
   out / blocked on next login, and can't fetch data meanwhile.
8. As shop_owner, archive a job, confirm it disappears from the dashboard
   and appears under Archive; restore it, confirm it comes back with full
   entry/comment history intact.
9. Open Audit Log as shop_owner — confirm the archive/restore/status
   changes above all appear with actor name, role, and UTC timestamp.
10. Confirm a mechanic account gets a 403 if it calls
    `/.netlify/functions/manage-users` directly.
11. Confirm no `service_role` key or secret appears anywhere in browser
    devtools / network tab / page source.
12. Log out; confirm the dashboard is fully inaccessible and the app shows
    the sign-in screen, not stale cached data.
13. On New Job Intake, dictate or type a note and click "Extract with AI" —
    confirm fields populate correctly and no OpenAI key appears in
    devtools/network tab (only your own domain's function call is visible).
