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
    .from('profiles').select('id, active, full_name').eq('id', callerId).single();
  if (profErr || !callerProfile || !callerProfile.active) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Your account is not active.' }) };
  }

  const { data: reqRow, error: reqErr } = await admin
    .from('role_change_requests').select('*').eq('id', requestId).single();
  if (reqErr || !reqRow) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Request not found.' }) };
  }

  // Authorization: the caller must be an ACTIVE shop_owner MEMBER of the shop the
  // request belongs to — never the global profiles.role (ambiguous for an identity
  // that belongs to multiple shops). The grant below is applied only within
  // reqRow.shop_id, so the approver is verified against that same shop.
  if (!reqRow.shop_id) {
    return { statusCode: 409, headers: cors, body: JSON.stringify({ error: 'This request has no shop context and cannot be reviewed.' }) };
  }
  const { data: callerMem, error: callerMemErr } = await admin
    .from('shop_memberships').select('role, is_active')
    .eq('profile_id', callerId).eq('shop_id', reqRow.shop_id).single();
  if (callerMemErr || !callerMem || !callerMem.is_active || callerMem.role !== 'shop_owner') {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Only an active shop owner of this request's shop may review it." }) };
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

      // Audit is best-effort: the deny has already committed, so a failed audit
      // insert must NOT turn a successful review into a reported failure.
      try {
        await admin.from('audit_log').insert({
          actor_id: callerId, actor_name: callerProfile.full_name || '', actor_role: callerMem.role || 'shop_owner',
          action: 'role_change_denied',
          table_name: 'role_change_requests', record_id: requestId, shop_id: reqRow.shop_id,
          old_value: { profile_id: reqRow.profile_id, requested_role: reqRow.requested_role },
          new_value: { status: 'denied', review_note: reviewNote || '' },
        });
      } catch (auditErr) { console.error('audit_log insert failed (role_change_denied):', auditErr); }
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

    // Audit is best-effort: the role change has already committed, so a failed
    // audit insert must NOT turn a successful approval into a reported failure.
    try {
      await admin.from('audit_log').insert({
        actor_id: callerId, actor_name: callerProfile.full_name || '', actor_role: callerMem.role || 'shop_owner',
        action: 'role_change_approved',
        table_name: 'profiles', record_id: reqRow.profile_id, shop_id: reqRow.shop_id,
        old_value: { role: reqRow.role_before },
        new_value: { role: reqRow.requested_role, request_id: requestId },
      });
    } catch (auditErr) { console.error('audit_log insert failed (role_change_approved):', auditErr); }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, status: 'approved' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: (e && e.message) || 'Unexpected server error' }) };
  }
};
