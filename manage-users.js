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
    .select('role, active')
    .eq('id', callerId)
    .single();
  if (profErr || !callerProfile || callerProfile.role !== 'shop_owner' || !callerProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Only an active shop owner may manage users.' }) };
  }

  try {
    switch (body.action) {
      case 'invite_mechanic': {
        const { email, fullName, role } = body;
        if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email is required' }) };
        const grantedRole = ['mechanic', 'service_advisor'].includes(role) ? role : 'mechanic';
        // inviteUserByEmail creates the auth user and emails them a signup/reset link.
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: { full_name: fullName || '' },
        });
        if (error) throw error;
        const newUserId = data.user && data.user.id;
        // Set role/active via app_metadata (service-role-only) so the profiles
        // trigger provisions this account as an active mechanic or service
        // advisor explicitly.
        if (newUserId) {
          await admin.auth.admin.updateUserById(newUserId, { app_metadata: { role: grantedRole, active: true } });
        }
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, userId: newUserId }) };
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
        if (!userId || !['shop_owner', 'service_advisor', 'mechanic'].includes(role)) {
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
