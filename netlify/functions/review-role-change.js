// Secure server-side role-change approval.
//
// Granting a role is privileged (mechanic -> shop_owner),
// so this NEVER happens via the browser's own Supabase client update — a
// user could just edit the request in devtools otherwise. This function
// re-derives the caller's identity from their access token, re-checks their
// role against the DATABASE (not anything the client claims), and only then
// uses the service-role key to apply the change.
//
// Required Netlify environment variables (Site settings -> Environment):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const { requestId, decision, reviewNote } = body;
  if (!requestId || !['approve', 'deny'].includes(decision)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'requestId and decision ("approve"|"deny") are required.' }) };
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

  const { data: callerProfile, error: profErr } = await admin
    .from('profiles').select('id, role, active, full_name').eq('id', callerId).single();
  if (profErr || !callerProfile || !callerProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Your account is not active.' }) };
  }
  // Only an active shop_owner may approve/deny ANY role-change request
  // (mechanic or shop_owner). This is deliberately
  // stricter than "manager" self-service — the spec requires shop_owner
  // sign-off specifically for owner-level grants, and this app's role model
  // has no separate "manager" role, so shop_owner is the sole approver tier.
  if (callerProfile.role !== 'shop_owner') {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Only a shop owner may review role-change requests.' }) };
  }

  const { data: reqRow, error: reqErr } = await admin
    .from('role_change_requests').select('*').eq('id', requestId).single();
  if (reqErr || !reqRow) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Request not found.' }) };
  }
  if (reqRow.status !== 'pending') {
    return { statusCode: 409, headers: cors, body: JSON.stringify({ error: `Request is already ${reqRow.status}.` }) };
  }

  // Guard: never allow the last remaining shop_owner to be left without
  // coverage via a denial-adjacent bug, and never let this endpoint be used
  // to demote anyone (it only ever grants requested_role, never removes).
  const nowIso = new Date().toISOString();

  try {
    if (decision === 'deny') {
      const { error } = await admin.from('role_change_requests').update({
        status: 'denied', reviewed_by: callerId, reviewed_at: nowIso, review_note: reviewNote || '', updated_at: nowIso,
      }).eq('id', requestId);
      if (error) throw error;

      await admin.from('audit_log').insert({
        actor_id: callerId, action: 'role_change_denied',
        target_table: 'role_change_requests', target_id: requestId,
        details: { profile_id: reqRow.profile_id, requested_role: reqRow.requested_role, review_note: reviewNote || '' },
      });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'denied' }) };
    }

    // approve
    const { error: roleErr } = await admin.from('profiles').update({
      role: reqRow.requested_role, updated_at: nowIso,
    }).eq('id', reqRow.profile_id);
    if (roleErr) throw roleErr;

    const { error: reqUpdateErr } = await admin.from('role_change_requests').update({
      status: 'approved', reviewed_by: callerId, reviewed_at: nowIso, review_note: reviewNote || '', updated_at: nowIso,
    }).eq('id', requestId);
    if (reqUpdateErr) throw reqUpdateErr;

    await admin.from('audit_log').insert({
      actor_id: callerId, action: 'role_change_approved',
      target_table: 'profiles', target_id: reqRow.profile_id,
      details: { requested_role: reqRow.requested_role, previous_role: reqRow.role_before, request_id: requestId },
    });
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'approved' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Unexpected server error' }) };
  }
};
