// Secure server-side user-management function.
//
// Handles every privileged operation the spec requires to stay OFF the
// frontend: inviting/creating mechanic accounts, assigning roles, and
// disabling/reactivating access. Runs with the Supabase SERVICE ROLE key,
// which lives only in Netlify environment variables — never in client code.
//
// Deploy: this file lives at netlify-deploy/netlify/functions/manage-users.js
// and is reachable at /.netlify/functions/manage-users once deployed.
//
// Required Netlify environment variables (Site settings → Environment):
//   SUPABASE_URL              your Supabase project URL (Project Settings → API)
//   SUPABASE_SERVICE_ROLE_KEY the "service_role" secret key (Project Settings → API)
//
// The caller must send their own Supabase session access token in the
// Authorization header; this function verifies it belongs to an active
// shop_owner before doing anything privileged.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// One-time bootstrap secret for creating the very first shop_owner account.
// Set this in Netlify env vars, share it out-of-band with whoever is setting
// up the shop, and remove/rotate it once the first owner exists — the
// endpoint also self-disables permanently as soon as any shop_owner exists.
const BOOTSTRAP_CODE = process.env.SHOP_OWNER_BOOTSTRAP_CODE;

// Actions that are reachable WITHOUT an existing session (bootstrap only).
const PUBLIC_ACTIONS = new Set(['bootstrap_status', 'bootstrap_shop_owner']);

// Resolve an existing auth-user id for an email WITHOUT relying on
// inviteUserByEmail's existing-email behavior. profiles mirrors auth.users
// 1:1 (fast, indexed); fall back to a bounded authoritative auth scan.
async function findUserIdByEmail(admin, email) {
  const target = (email || '').toLowerCase();
  if (!target) return null;
  const { data: prof } = await admin.from('profiles').select('id').ilike('email', email).limit(1);
  if (prof && prof[0] && prof[0].id) return prof[0].id;
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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- bootstrap: only reachable while zero shop_owner rows exist ----
  if (PUBLIC_ACTIONS.has(body.action)) {
    const { count, error: countErr } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'shop_owner');
    if (countErr) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: countErr.message }) };
    }
    const ownerExists = (count || 0) > 0;

    if (body.action === 'bootstrap_status') {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ needsBootstrap: !ownerExists }) };
    }

    // action === 'bootstrap_shop_owner'
    if (ownerExists) {
      return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'A shop owner already exists. Ask them to invite you instead.' }) };
    }
    if (!BOOTSTRAP_CODE) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Bootstrap is not configured (missing SHOP_OWNER_BOOTSTRAP_CODE).' }) };
    }
    if (!body.bootstrapCode || body.bootstrapCode !== BOOTSTRAP_CODE) {
      return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Incorrect setup code.' }) };
    }
    const { email, password, fullName } = body;
    if (!email || !password) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email and password are required' }) };
    }
    try {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
        app_metadata: { role: 'shop_owner', active: true }, // service-role-only field; drives the profiles trigger
      });
      if (error) throw error;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, userId: data.user && data.user.id }) };
    } catch (e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Could not create shop owner.' }) };
    }
  }

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
          const { data: mem, error: memErr } = await admin.from('shop_memberships')
            .select('id, is_active').eq('profile_id', existingId).eq('shop_id', shopId).maybeSingle();
          if (memErr) throw memErr;
          if (mem) {
            if (mem.is_active) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'already_member', userId: existingId }) };
            return inactiveMember;
          }
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

      case 'set_active': {
        const { userId, active } = body;
        if (!userId || typeof active !== 'boolean') {
          return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'userId and boolean active are required' }) };
        }
        const { error } = await admin.from('profiles').update({ active, updated_at: new Date().toISOString() }).eq('id', userId);
        if (error) throw error;
        // Also block sign-in at the auth layer while disabled.
        await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
      }

      case 'set_role': {
        const { userId, role } = body;
        if (!userId || !['shop_owner', 'mechanic'].includes(role)) {
          return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'userId and valid role are required' }) };
        }
        const { error } = await admin.from('profiles').update({ role, updated_at: new Date().toISOString() }).eq('id', userId);
        if (error) throw error;
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
      }

      case 'delete_user': {
        const { userId } = body;
        if (!userId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'userId is required' }) };
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
      }

      default:
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action: ' + body.action }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Unexpected server error' }) };
  }
};
