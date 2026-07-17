// Secure server-side staff role change (Manage Role, Mechanic Profile page).
//
// This NEVER happens via the browser's own Supabase client update — granting
// or revoking shop_owner is the single highest-blast-radius action in the
// app, so it must be re-verified against the DATABASE (not anything the
// client claims) before the service-role key touches profiles.role.
//
// Required Netlify environment variables (Site settings -> Environment):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The app's profiles.role check constraint only allows these three today —
// do not accept arbitrary strings from the client. If a fourth tier
// ("manager") is ever added to the schema, add it here too.
const ALLOWED_ROLES = ['mechanic', 'service_advisor', 'shop_owner'];

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
  const { targetUserId, newRole } = body;
  if (!targetUserId || !ALLOWED_ROLES.includes(newRole)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'targetUserId and a valid newRole are required.' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Missing Authorization bearer token.' }) };

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }
  const callerId = userData.user.id;

  const { data: callerProfile, error: callerErr } = await admin
    .from('profiles').select('id, role, active, full_name').eq('id', callerId).single();
  if (callerErr || !callerProfile || !callerProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Your account is not active.' }) };
  }
  // Only an active shop_owner may change ANYONE's role from this endpoint.
  // (There is no per-tenant/shop table yet — see note near the bottom — so
  // "same shop" today just means "the one shop this deployment serves".)
  if (callerProfile.role !== 'shop_owner') {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Only a shop owner may change a staff member\'s role.' }) };
  }

  const { data: targetProfile, error: targetErr } = await admin
    .from('profiles').select('id, role, active, full_name').eq('id', targetUserId).single();
  if (targetErr || !targetProfile) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Staff member not found.' }) };
  }

  if (targetProfile.role === newRole) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `${targetProfile.full_name} already has this role.` }) };
  }

  // Safety rule: inactive/disabled accounts cannot be promoted (or have
  // their role changed at all) until reactivated.
  if (!targetProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'This account is disabled. Reactivate it before changing its role.' }) };
  }

  // Safety rule: never leave the shop with zero active shop_owners, whether
  // the target is demoting themselves or is being demoted by someone else.
  if (targetProfile.role === 'shop_owner' && newRole !== 'shop_owner') {
    const { count, error: countErr } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'shop_owner')
      .eq('active', true);
    if (countErr) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: countErr.message }) };
    }
    if ((count || 0) <= 1) {
      return { statusCode: 409, headers: cors, body: JSON.stringify({ error: "This account is the shop's only active owner. Promote another owner before changing this role." }) };
    }
  }

  const nowIso = new Date().toISOString();

  try {
    const { data: updated, error: updateErr } = await admin
      .from('profiles')
      .update({ role: newRole, updated_at: nowIso })
      .eq('id', targetUserId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    // Append-only audit trail — never editable/deletable from the frontend
    // (audit_log has no client-facing insert/update/delete RLS policy at all).
    await admin.from('audit_log').insert({
      actor_id: callerId,
      actor_name: callerProfile.full_name || '',
      actor_role: callerProfile.role || '',
      action: 'staff_role_changed',
      table_name: 'profiles',
      record_id: targetUserId,
      old_value: { role: targetProfile.role, full_name: targetProfile.full_name },
      new_value: { role: newRole, changed_by: callerProfile.full_name },
    });

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        profile: {
          id: updated.id,
          role: updated.role,
          active: updated.active,
          fullName: updated.full_name,
        },
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Unexpected server error' }) };
  }
};

// ---------------------------------------------------------------------------
// Future-ready tenant note (spec item 10): once shop_memberships(shop_id,
// user_id, role, is_active) exists, this function's three read/write points
// on public.profiles above should become read/write points on that table,
// scoped additionally by `and shop_memberships.shop_id = callerMembership.shop_id`
// so the "same tenant/shop" check is enforced here, not just assumed.
// ---------------------------------------------------------------------------
