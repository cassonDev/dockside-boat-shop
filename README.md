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

## 6. Testing checklist
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
