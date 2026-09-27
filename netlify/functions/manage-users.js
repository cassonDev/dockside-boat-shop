// Secure server-side user-management function.
//
// A shop owner uses this to invite staff (new or existing logins) into THEIR
// OWN shop. Runs with the Supabase SERVICE ROLE key, which lives only in
// Netlify environment variables — never in client code.
//
// Reachable at /.netlify/functions/manage-users once deployed.
//
// Required Netlify environment variables (Site settings → Environment):
//   SUPABASE_URL              your Supabase project URL (Project Settings → API)
//   SUPABASE_SERVICE_ROLE_KEY the "service_role" secret key (Project Settings → API)
//
// The caller must send their own Supabase session access token in the
// Authorization header; this function verifies it belongs to an active
// shop_owner before doing anything privileged.
//
// Retired actions (2026-09): set_active, set_role and delete_user accepted any
// user id without checking that person belonged to the caller's shop, and no
// screen used them — they now answer "Unknown action". Staff on/off and owner
// mechanic toggles go through shop-scoped database functions instead. The
// first-owner "bootstrap" is also retired: new shops are set up by invitation.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Loaded on first use (same pattern as lib/verify-shop-member.js) so tests can
// swap in a fake client.
const deps = {
  createClient: (url, key, options) => require('@supabase/supabase-js').createClient(url, key, options),
};

// A plain email address: something@something.something, with no spaces and none
// of the characters that act as search wildcards (% * \).
function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@%*\\]+@[^\s@%*\\]+\.[^\s@%*\\]+$/.test(email);
}

// Resolve an existing auth-user id for an email WITHOUT relying on
// inviteUserByEmail's existing-email behavior. Only an EXACT (case-insensitive)
// match counts: "_" is escaped so it can't act as a wildcard, and every
// candidate is compared exactly before it is used. Falls back to a bounded
// authoritative auth scan. Callers must pass an email that passed isValidEmail.
async function findUserIdByEmail(admin, email) {
  const target = (email || '').toLowerCase();
  if (!target) return null;
  const pattern = target.replace(/_/g, '\\_');
  const { data: prof } = await admin.from('profiles').select('id, email').ilike('email', pattern).limit(5);
  const exact = (prof || []).find((p) => (p.email || '').toLowerCase() === target);
  if (exact && exact.id) return exact.id;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const users = (data && data.users) || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit.id;
    if (users.length < 200) break;
  }
  return null;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  // The first-owner bootstrap is retired: new shops are set up by invitation.
  // 'bootstrap_status' still answers (always "not needed") so older copies of
  // the app, which ask on the sign-in screen, keep loading cleanly.
  if (body.action === 'bootstrap_status') {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ needsBootstrap: false }) };
  }
  if (body.action === 'bootstrap_shop_owner') {
    return { statusCode: 410, headers: cors, body: JSON.stringify({ error: 'Shop setup is by invitation only.' }) };
  }

  const admin = deps.createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- everything below requires a valid session belonging to an active shop_owner ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  // Verify the caller's token and that they are an active shop_owner.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }
  const callerId = userData.user.id;

  const { data: callerProfile, error: profErr } = await admin
    .from('profiles')
    .select('active, active_shop_id, full_name')
    .eq('id', callerId)
    .single();
  if (profErr || !callerProfile || !callerProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Your account is not active.' }) };
  }
  if (!callerProfile.active_shop_id) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Your account has no active shop context.' }) };
  }
  // Authorization is the caller's MEMBERSHIP role in their active shop — never
  // the global profiles.role, which is ambiguous for an identity that belongs
  // to multiple shops with different roles. Applies to every action below.
  const { data: callerMem, error: callerMemErr } = await admin
    .from('shop_memberships').select('role, is_active')
    .eq('profile_id', callerId).eq('shop_id', callerProfile.active_shop_id).single();
  if (callerMemErr || !callerMem || !callerMem.is_active || callerMem.role !== 'shop_owner') {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Only an active shop owner may manage users.' }) };
  }

  try {
    switch (body.action) {
      case 'invite_staff':
      case 'invite_mechanic': { // invite_mechanic kept as a one-release compatibility alias
        const email = (body.email || '').trim();
        const fullName = body.fullName || '';
        // Role allow-list is EXACTLY mechanic|shop_owner. The legacy alias always
        // means mechanic. platform_admin (and anything else) is rejected outright.
        const role = body.action === 'invite_mechanic' ? 'mechanic' : body.role;
        if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email is required' }) };
        if (!isValidEmail(email)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Enter a valid email address.' }) };
        if (!['mechanic', 'shop_owner'].includes(role)) {
          return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'role must be mechanic or shop_owner' }) };
        }
        // shop_id is ALWAYS derived from the authenticated inviter's active shop,
        // never from the request body — an invite can't be redirected to another tenant.
        const shopId = callerProfile.active_shop_id;
        if (!shopId) return { statusCode: 409, headers: cors, body: JSON.stringify({ error: 'Your account has no active shop context.' }) };

        // Deterministic default location (verified schema has no is_primary flag):
        //   exactly one active location → use it; multiple → only an explicitly
        //   supplied, in-shop active location; otherwise null (a valid state).
        const { data: locs, error: locErr } = await admin
          .from('shop_locations').select('id').eq('shop_id', shopId).eq('is_active', true);
        if (locErr) throw locErr;
        let defaultLocationId = null;
        if ((locs || []).length === 1) defaultLocationId = locs[0].id;
        else if ((locs || []).length > 1 && body.locationId && locs.some((l) => l.id === body.locationId)) defaultLocationId = body.locationId;

        const inactiveMember = { statusCode: 409, headers: cors, body: JSON.stringify({ status: 'inactive_member', error: 'This person was removed from your shop. Reactivate them from Staff, not via invite.' }) };
        const needsConfirm = { statusCode: 409, headers: cors, body: JSON.stringify({ status: 'requires_confirmation', error: 'That email already has an account. Adding them will grant that existing user access to your shop.' }) };
        const cannotAdd = { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'That login can’t be added to a shop.' }) };
        const worksElsewhere = { statusCode: 409, headers: cors, body: JSON.stringify({ status: 'member_of_another_shop', error: 'That person already works at another shop. Each login belongs to one shop — ask them for a different email address.' }) };

        // Platform admin logins stay outside every shop; a shop can never add one.
        const isPlatformAdmin = async (profileId) => {
          const { data, error } = await admin.from('platform_admins')
            .select('profile_id').eq('profile_id', profileId).eq('is_active', true).maybeSingle();
          if (error) throw error;
          return !!data;
        };

        // One shop per login (for now): someone active in ANOTHER shop can't be
        // added here. Being turned off elsewhere doesn't count — they've left.
        const isActiveInAnotherShop = async (profileId) => {
          const { data, error } = await admin.from('shop_memberships')
            .select('shop_id').eq('profile_id', profileId).eq('is_active', true);
          if (error) throw error;
          return (data || []).some((m) => m.shop_id !== shopId);
        };

        // Explicit, authoritative provisioning. Membership is the ONLY grant of
        // tenant access, created here from the server-derived shop only.
        const provisionMembership = async (profileId, isExisting) => {
          const ins = await admin.from('shop_memberships')
            .insert({ profile_id: profileId, shop_id: shopId, role, is_active: true, default_location_id: defaultLocationId });
          if (ins.error) {
            // Concurrent insert won the UNIQUE(profile_id,shop_id) race → re-read,
            // apply the same rules (never a blind role/active overwrite).
            const { data: raced } = await admin.from('shop_memberships')
              .select('id, is_active').eq('profile_id', profileId).eq('shop_id', shopId).maybeSingle();
            if (raced) {
              if (raced.is_active) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'already_member', userId: profileId }) };
              return inactiveMember;
            }
            throw ins.error;
          }
          // Brand-new invited user gets their shop context set. An existing
          // multi-shop user's active_shop_id and other memberships are NEVER touched.
          if (!isExisting) {
            await admin.from('profiles').update({ role, active: true, active_shop_id: shopId, updated_at: new Date().toISOString() }).eq('id', profileId);
          }
          try { await admin.auth.admin.updateUserById(profileId, { app_metadata: { role, active: true, shop_id: shopId } }); } catch (e) { /* token claims are non-authoritative */ }
          // Audit is best-effort: the membership has already committed, so a
          // failed audit insert must NOT fail the invite (retry is idempotent).
          try {
            await admin.from('audit_log').insert({
              actor_id: callerId, actor_name: callerProfile.full_name || '', actor_role: callerMem.role || 'shop_owner',
              action: isExisting ? 'staff_added_existing' : 'staff_invited',
              table_name: 'shop_memberships', record_id: profileId,
              old_value: null, new_value: { email, role }, shop_id: shopId,
            });
          } catch (auditErr) { console.error('audit_log insert failed (staff invite):', auditErr); }
          return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: isExisting ? 'added_existing_user' : 'invited', userId: profileId }) };
        };

        // Decide new-vs-existing by authoritative lookup BEFORE inviting.
        const existingId = await findUserIdByEmail(admin, email);
        if (existingId) {
          if (await isPlatformAdmin(existingId)) return cannotAdd;
          const { data: mem, error: memErr } = await admin.from('shop_memberships')
            .select('id, is_active').eq('profile_id', existingId).eq('shop_id', shopId).maybeSingle();
          if (memErr) throw memErr;
          if (mem) {
            if (mem.is_active) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'already_member', userId: existingId }) };
            return inactiveMember;
          }
          if (await isActiveInAnotherShop(existingId)) return worksElsewhere;
          if (body.addExistingUser !== true) return needsConfirm;
          return await provisionMembership(existingId, true);
        }

        // New identity: create + email the invite, THEN provision membership. If
        // provisioning fails, we return failure and the account stays
        // unprovisioned (no membership = no tenant access); retry is idempotent.
        const invite = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName } });
        if (invite.error) {
          // Racy edge: created between our lookup and now → treat as existing.
          const racedId = await findUserIdByEmail(admin, email);
          if (racedId) {
            if (await isPlatformAdmin(racedId)) return cannotAdd;
            if (await isActiveInAnotherShop(racedId)) return worksElsewhere;
            if (body.addExistingUser !== true) return needsConfirm;
            return await provisionMembership(racedId, true);
          }
          throw invite.error;
        }
        const newUserId = invite.data && invite.data.user && invite.data.user.id;
        if (!newUserId) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Invite created no user id.' }) };
        // Ensure a profile row exists without depending on any auth-insert trigger.
        await admin.from('profiles').upsert({ id: newUserId, email, full_name: fullName || null, active: true }, { onConflict: 'id', ignoreDuplicates: true });
        return await provisionMembership(newUserId, false);
      }

      default:
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action: ' + body.action }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Unexpected server error' }) };
  }
};

// Test hook: swap deps.createClient for a fake; pure helpers exposed for unit tests.
exports._test = { deps, isValidEmail, findUserIdByEmail };
