// Supabase connection + data + auth access for the Dockside job tracker.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Config comes from window.__SUPABASE_CONFIG__, which is generated at BUILD
// TIME (see scripts/generate-config.js + netlify.toml) from the Netlify
// environment variables SUPABASE_URL / SUPABASE_ANON_KEY. Nothing is
// hardcoded here or committed to the repo — this keeps real values out of
// source control and out of Netlify's secret scanner.
const _cfg = (typeof window !== 'undefined' && window.__SUPABASE_CONFIG__) || {};
const SUPABASE_URL = _cfg.url || '';
const SUPABASE_ANON_KEY = _cfg.anonKey || '';

// The Netlify Function that performs privileged user-management actions.
// Same-origin relative path — works once deployed to Netlify; during local
// preview it will simply fail with a network error, which callers surface
// as a normal error message.
const MANAGE_USERS_ENDPOINT = '/.netlify/functions/manage-users';

export const configError = (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  ? 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in your Netlify environment variables and redeploy.'
  : null;

export const supabase = configError ? null : createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,      // keeps the user signed in between visits
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// ---------- auth ----------
export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName || '' } }, // role defaults to 'mechanic' via DB trigger
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return data.subscription;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function fetchMyProfile() {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session && sessionData.session.user;
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return profileFromRow(data);
}

// ---------- mappers: db row (snake_case) <-> app shape (camelCase) ----------
function profileFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.full_name || row.email,
    role: row.role,
    active: !!row.active,
    outOfOffice: !!row.out_of_office,
  };
}

function jobFromRow(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone,
    boatYear: row.boat_year || '',
    boatMake: row.boat_make || '',
    boatModel: row.boat_model || '',
    // Older rows written before the year/make/model split only have
    // boat_make_model — fall back to it so existing jobs still display fine.
    boatMakeModel: (row.boat_year || row.boat_make || row.boat_model)
      ? [row.boat_year, row.boat_make, row.boat_model].map(v => (v || '').trim()).filter(Boolean).join(' ')
      : (row.boat_make_model || ''),
    issue: row.issue,
    photos: row.photos || [],
    size: row.size,
    priority: row.priority,
    assignedMechanic: row.assigned_mechanic,
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    intakeRawNotes: row.intake_raw_notes || '',
    active: row.active !== false,
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
    entries: (row.entries || []).map(e => ({
      timestamp: new Date(e.timestamp).getTime(),
      findings: e.findings || '',
      fix: e.fix || '',
      timeSpent: e.timeSpent || '',
      materials: e.materials || '',
      rawNotes: e.rawNotes || '',
      photos: e.photos || [],
    })),
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    authorName: row.author_name,
    authorRole: row.author_role,
    body: row.body,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ---------- reads ----------
// "mechanics" for the roster/filters/assignment UI = active profiles with role='mechanic'.
// shop_owner accounts are excluded from the assignable-mechanic list but the
// shop_owner themself can still see everything via the work_orders queries below.
export async function fetchMechanics() {
  const { data, error } = await supabase.from('profiles').select('*').eq('role', 'mechanic').order('full_name');
  if (error) throw error;
  return (data || []).map(profileFromRow);
}

export async function fetchJobs() {
  const { data, error } = await supabase.from('work_orders').select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(jobFromRow);
}

export async function fetchArchivedJobs() {
  const { data, error } = await supabase.from('work_orders').select('*').eq('active', false).order('archived_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(jobFromRow);
}

export async function fetchComments(workOrderId) {
  const { data, error } = await supabase.from('work_order_comments').select('*').eq('work_order_id', workOrderId).eq('active', true).order('created_at');
  if (error) throw error;
  return (data || []).map(commentFromRow);
}

// ---------- writes ----------
export function newJobCode(existingIds) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let k = 0; k < 5; k++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (existingIds.includes(code));
  return code;
}

// Boat details are captured as three separate columns (year / make / model)
// so the AI extractor and the review form never have to guess how to split
// a combined string back apart. boat_make_model is kept as a derived,
// human-readable column (populated here, and used as a fallback by
// jobFromRow for any pre-migration rows that only ever had that column).
function composeBoatMakeModel(year, make, model) {
  return [year, make, model].map(v => (v || '').trim()).filter(Boolean).join(' ');
}

export async function insertJob(job, createdByUserId) {
  const row = {
    id: job.id,
    customer_name: job.customerName,
    phone: job.phone,
    boat_year: job.boatYear || '',
    boat_make: job.boatMake || '',
    boat_model: job.boatModel || '',
    boat_make_model: job.boatMakeModel || composeBoatMakeModel(job.boatYear, job.boatMake, job.boatModel),
    issue: job.issue,
    photos: job.photos || [],
    size: job.size,
    priority: job.priority,
    assigned_mechanic: job.assignedMechanic,
    status: job.status,
    intake_raw_notes: job.intakeRawNotes || '',
    entries: [],
    created_by: createdByUserId || null,
  };
  const { data, error } = await supabase.from('work_orders').insert(row).select().single();
  if (error) throw error;
  return jobFromRow(data);
}

export async function updateJobStatus(id, status) {
  const { error } = await supabase.from('work_orders').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function appendJobEntry(id, entries, statusOverride) {
  const payload = { entries: entries.map(e => ({ ...e, timestamp: new Date(e.timestamp).toISOString() })) };
  if (statusOverride) payload.status = statusOverride;
  const { error } = await supabase.from('work_orders').update(payload).eq('id', id);
  if (error) throw error;
}

export async function archiveJob(id, archivedByUserId) {
  const { error } = await supabase.from('work_orders').update({
    active: false, archived_at: new Date().toISOString(), archived_by: archivedByUserId || null,
  }).eq('id', id);
  if (error) throw error;
}

export async function restoreJob(id) {
  const { error } = await supabase.from('work_orders').update({ active: true, archived_at: null, archived_by: null }).eq('id', id);
  if (error) throw error;
}

export async function addComment(workOrderId, body, author) {
  const row = {
    work_order_id: workOrderId,
    author_id: author.id,
    author_name: author.name,
    author_role: author.role,
    body,
  };
  const { data, error } = await supabase.from('work_order_comments').insert(row).select().single();
  if (error) throw error;
  return commentFromRow(data);
}

export async function setMechanicOOO(id, outOfOffice) {
  const { error } = await supabase.from('profiles').update({ out_of_office: outOfOffice, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function fetchAuditLog(limit) {
  const { data, error } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit || 200);
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id,
    actorName: r.actor_name,
    actorRole: r.actor_role,
    action: r.action,
    tableName: r.table_name,
    recordId: r.record_id,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

// ---------- one-time shop-owner bootstrap (no session required) ----------
export async function checkBootstrapStatus() {
  const res = await fetch(MANAGE_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bootstrap_status' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return !!json.needsBootstrap;
}

export async function bootstrapShopOwner(email, password, fullName, bootstrapCode) {
  const res = await fetch(MANAGE_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bootstrap_shop_owner', email, password, fullName, bootstrapCode }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------- privileged user-management (routed through the Netlify Function) ----------
async function callManageUsers(action, payload) {
  const session = await getSession();
  if (!session) throw new Error('Not signed in.');
  const res = await fetch(MANAGE_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export async function inviteMechanic(email, fullName) {
  return callManageUsers('invite_mechanic', { email, fullName });
}
export async function setUserActive(userId, active) {
  return callManageUsers('set_active', { userId, active });
}
export async function setUserRole(userId, role) {
  return callManageUsers('set_role', { userId, role });
}
export async function deleteUserAccount(userId) {
  return callManageUsers('delete_user', { userId });
}
