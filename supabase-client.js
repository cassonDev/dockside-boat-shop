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

// Capture the auth-callback URL ONCE, synchronously at module load, BEFORE
// createClient({ detectSessionInUrl: true }) consumes and cleans the hash/query.
// This is the only reliable per-browser-load signal that this visit began from
// an invite or recovery link. It must never be re-derived later.
const _initialUrl = (typeof window !== 'undefined') ? window.location.href : '';
function _detectInitialAuthCallback(href) {
  const out = { type: null, hasCode: false, hasToken: false, isCallback: false };
  if (!href) return out;
  try {
    const u = new URL(href);
    out.hasCode = u.searchParams.has('code');
    const queryType = u.searchParams.get('type');
    const hash = u.hash && u.hash.charAt(0) === '#' ? u.hash.slice(1) : (u.hash || '');
    const hp = new URLSearchParams(hash);
    out.hasToken = hp.has('access_token');
    const hashType = hp.get('type');
    out.type = hashType || queryType || null;
  } catch (e) { /* malformed URL — leave defaults */ }
  out.isCallback = !!(out.type || out.hasCode || out.hasToken);
  return out;
}
// Frozen snapshot of the auth callback for this browser load.
export const initialAuthCallback = _detectInitialAuthCallback(_initialUrl);

// Strips the auth token/code from the address bar without a reload, after the
// invite/recovery session has been consumed.
export function cleanAuthCallbackUrl() {
  if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
  const clean = window.location.origin + window.location.pathname;
  try { window.history.replaceState({}, document.title, clean); } catch (e) { /* ignore */ }
}

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
// Password recovery uses Supabase's native flow. The caller always shows a
// neutral message regardless of the result, so this never reveals whether an
// email is registered.
export async function sendPasswordReset(email) {
  const redirectTo = (typeof window !== 'undefined')
    ? window.location.origin + window.location.pathname
    : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
  if (error) throw error;
}

// Sets a new password for the user during an active (recovery) session.
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
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
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return data ? profileFromRow(data) : null;
}

// ---------- mappers: db row (snake_case) <-> app shape (camelCase) ----------
function profileFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone || '',
    name: row.full_name || row.email,
    role: row.role,
    active: !!row.active,
    outOfOffice: !!row.out_of_office,
    availabilityStatus: row.availability_status || 'available',
    oooStart: row.out_of_office_start || '',
    oooEnd: row.out_of_office_end || '',
    availabilityNote: row.availability_note || '',
    activeShopId: row.active_shop_id || null,
  };
}

function roleChangeRequestFromRow(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    currentRole: row.role_before,
    requestedRole: row.requested_role,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || '',
    createdAt: row.created_at,
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
    customerEmail: row.customer_email || '',
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
    customerConcern: row.customer_concern || '',
    originalTranscript: row.original_transcript || '',
    originalCustomerConcern: row.original_customer_concern || '',
    originalExtraction: row.original_extraction || null,
    active: row.active !== false,
    locationId: row.location_id || null,
    shopId: row.shop_id || null,
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
    entries: (row.entries || []).map(e => ({
      timestamp: new Date(e.timestamp).getTime(),
      findings: e.findings || '',
      fix: e.fix || '',
      timeSpent: e.timeSpent || '',
      materials: e.materials || '',
      rawNotes: e.rawNotes || '',
      // Work-log entries reference photos from the unified gallery by id —
      // they never own their own image data. `photos` (legacy inline array)
      // is read as a fallback only for rows written before this migration.
      photoIds: e.photoIds || [],
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

// Every staff profile regardless of role — used for the Mechanic Profile
// page's Manage Role feature, so a shop_owner can look up (and, via the
// secure update-staff-role Function, change the role of) a fellow
// shop_owner, not just accounts already role='mechanic'. RLS
// still governs what actually comes back: a non-owner viewer only ever
// gets their own row via the "profiles: self read" policy.
export async function fetchStaffRoster() {
  const { data, error } = await supabase.from('profiles').select('*').order('full_name');
  if (error) throw error;
  return (data || []).map(profileFromRow);
}

// RLS already restricts rows to the caller's current shop; the optional
// locationId is an in-shop operational filter, not a security boundary.
export async function fetchJobs({ locationId } = {}) {
  let q = supabase.from('work_orders').select('*').eq('active', true);
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q.order('created_at', { ascending: false });
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

// Live sync so a comment posted from one device (e.g. a laptop) shows up
// immediately on another device already viewing the same job (e.g. a phone),
// instead of only appearing the next time that device reopens the job.
// Returns the channel — call supabase.removeChannel(channel) when leaving
// the job's screen or on unmount.
export function subscribeToComments(workOrderId, onInsert) {
  const channel = supabase
    .channel(`comments-${workOrderId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'work_order_comments', filter: `work_order_id=eq.${workOrderId}` }, (payload) => {
      onInsert(commentFromRow(payload.new));
    })
    .subscribe();
  return channel;
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
    customer_email: job.customerEmail || '',
    issue: job.issue,
    photos: job.photos || [],
    size: job.size,
    priority: job.priority,
    // null = Unassigned (column is nullable; RLS insert only checks created_by).
    assigned_mechanic: job.assignedMechanic || null,
    status: job.status,
    intake_raw_notes: job.intakeRawNotes || '',
    customer_concern: job.customerConcern || '',
    original_transcript: job.originalTranscript || '',
    original_customer_concern: job.originalCustomerConcern || '',
    original_extraction: job.originalExtraction || null,
    entries: [],
    created_by: createdByUserId || null,
    // shop_id is stamped server-side by the set_shop_id trigger (never trusted
    // from the client); location_id defaults to the shop's primary location if
    // omitted, and is validated against the shop by set_wo_location.
    location_id: job.locationId || null,
  };
  const { data, error } = await supabase.from('work_orders').insert(row).select().single();
  if (error) throw error;
  return jobFromRow(data);
}

export async function updateJobStatus(id, status) {
  const { error } = await supabase.from('work_orders').update({ status }).eq('id', id);
  if (error) throw error;
}

// Full work-order/customer-details edit (Edit Job Details modal). Never
// touches id, created_at, or created_by — the QR/job code and provenance
// stay stable across edits. RLS + the guard_work_order_edits trigger decide
// who is actually permitted to change which columns. Two-role model: any
// active staff member (mechanic or shop_owner) may edit these fields on any
// job in the shop — tenant isolation, not assignment, is the boundary.
export async function updateWorkOrder(id, patch) {
  const row = {};
  if (patch.customerName !== undefined) row.customer_name = patch.customerName;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.customerEmail !== undefined) row.customer_email = patch.customerEmail;
  if (patch.boatYear !== undefined) row.boat_year = patch.boatYear;
  if (patch.boatMake !== undefined) row.boat_make = patch.boatMake;
  if (patch.boatModel !== undefined) row.boat_model = patch.boatModel;
  if (patch.boatYear !== undefined || patch.boatMake !== undefined || patch.boatModel !== undefined) {
    row.boat_make_model = composeBoatMakeModel(patch.boatYear, patch.boatMake, patch.boatModel);
  }
  if (patch.issue !== undefined) row.issue = patch.issue;
  if (patch.size !== undefined) row.size = patch.size;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.assignedMechanic !== undefined) row.assigned_mechanic = patch.assignedMechanic || null;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.intakeRawNotes !== undefined) row.intake_raw_notes = patch.intakeRawNotes;
  if (patch.customerConcern !== undefined) row.customer_concern = patch.customerConcern;
  row.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('work_orders').update(row).eq('id', id).select().single();
  if (error) throw error;
  return jobFromRow(data);
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

// ---------- activities (unified work-order timeline) ----------
// One row per event on a job — work-log entries, inspections, AI summaries,
// private mechanic notes, public customer notes, status changes, photos,
// and the financial/parts trail (quote/approval/invoice/payment/parts).
// Every row is append-only EXCEPT customer_note, which may be edited by its
// author or a shop owner — each edit writes the prior
// version to activity_history before overwriting, so nothing is ever lost.
export const ACTIVITY_TYPES = [
  'work_log', 'inspection', 'ai_summary', 'mechanic_note', 'customer_note',
  'status_change', 'photo_added', 'quote_sent', 'approval_received',
  'invoice_generated', 'payment_received', 'part_ordered', 'part_received',
];
// Types whose body/meta may be edited in place after creation (audit-trailed).
export const EDITABLE_ACTIVITY_TYPES = ['customer_note', 'work_log'];

function activityFromRow(row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    activityType: row.activity_type,
    visibility: row.visibility,
    body: row.body || '',
    meta: row.meta || {},
    attachments: row.attachments || [],
    aiGenerated: !!row.ai_generated,
    authorId: row.author_id,
    authorName: row.author_name || '',
    authorRole: row.author_role || '',
    parentActivityId: row.parent_activity_id || null,
    version: row.version || 1,
    editedBy: row.edited_by || null,
    editedByName: row.edited_by_name || '',
    editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    active: row.active !== false,
  };
}

export async function fetchActivities(workOrderId) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .eq('work_order_id', workOrderId)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(activityFromRow);
}

// Realtime inserts only (edits are reflected via editActivity's own return
// value in the caller, same pattern as comments).
export function subscribeToActivities(workOrderId, onInsert) {
  const channel = supabase
    .channel(`activities-${workOrderId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activities', filter: `work_order_id=eq.${workOrderId}` },
      (payload) => onInsert(activityFromRow(payload.new)))
    .subscribe();
  return channel;
}

export async function createActivity(workOrderId, activity, author) {
  const row = {
    work_order_id: workOrderId,
    activity_type: activity.activityType,
    visibility: activity.visibility || (activity.activityType === 'customer_note' ? 'public' : 'private'),
    body: activity.body || '',
    meta: activity.meta || {},
    attachments: activity.attachments || [],
    ai_generated: !!activity.aiGenerated,
    author_id: author && author.id,
    author_name: author && author.name || '',
    author_role: author && author.role || '',
    parent_activity_id: activity.parentActivityId || null,
  };
  const { data, error } = await supabase.from('activities').insert(row).select().single();
  if (error) throw error;
  return activityFromRow(data);
}

// Edits a customer_note (only editable type). Writes the current body/meta
// to activity_history as the prior version, then updates the row in place
// with the new body/meta, bumped version, and editor/timestamp — so the
// card can show "Edited by X" while the full chain of prior versions stays
// queryable via fetchActivityHistory.
export async function editActivity(activityId, patch, editor, changeReason) {
  const { data: current, error: fetchErr } = await supabase.from('activities').select('*').eq('id', activityId).single();
  if (fetchErr) throw fetchErr;

  const historyRow = {
    activity_id: activityId,
    version: current.version || 1,
    previous_body: current.body || '',
    previous_meta: current.meta || {},
    edited_by: editor && editor.id,
    edited_by_name: editor && editor.name || '',
    change_reason: changeReason || '',
  };
  const { error: histErr } = await supabase.from('activity_history').insert(historyRow);
  if (histErr) throw histErr;

  const nowIso = new Date().toISOString();
  const updateRow = {
    body: patch.body !== undefined ? patch.body : current.body,
    meta: patch.meta !== undefined ? patch.meta : current.meta,
    version: (current.version || 1) + 1,
    edited_by: editor && editor.id,
    edited_by_name: editor && editor.name || '',
    edited_at: nowIso,
    updated_at: nowIso,
  };
  const { data, error } = await supabase.from('activities').update(updateRow).eq('id', activityId).select().single();
  if (error) throw error;
  return activityFromRow(data);
}

export async function fetchActivityHistory(activityId) {
  const { data, error } = await supabase
    .from('activity_history')
    .select('*')
    .eq('activity_id', activityId)
    .order('version', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    version: r.version,
    previousBody: r.previous_body,
    previousMeta: r.previous_meta || {},
    editedBy: r.edited_by,
    editedByName: r.edited_by_name || '',
    editedAt: new Date(r.edited_at).getTime(),
    changeReason: r.change_reason || '',
  }));
}

// Manager-only soft delete (RLS only permits this via the shop_owner-full-
// access policy since deactivating isn't a plain body/meta edit).
export async function deactivateActivity(activityId) {
  const { error } = await supabase.from('activities').update({ active: false, updated_at: new Date().toISOString() }).eq('id', activityId);
  if (error) throw error;
}

export async function setMechanicOOO(id, outOfOffice) {
  const { error } = await supabase.from('profiles').update({ out_of_office: outOfOffice, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// Availability: a mechanic may update only their own row; a shop_owner
// may update anyone's (both enforced by RLS on profiles, not just by hiding the UI).
// Setting anything other than 'available' also flips the legacy out_of_office
// boolean so existing at-risk / OOO-badge logic elsewhere keeps working unchanged.
export async function updateAvailability(id, { status, start, end, note }) {
  const row = {
    availability_status: status,
    out_of_office_start: start || null,
    out_of_office_end: end || null,
    availability_note: note || '',
    out_of_office: status !== 'available',
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('profiles').update(row).eq('id', id).select().single();
  if (error) throw error;
  return profileFromRow(data);
}

// ---------- role-change requests ----------
export async function fetchRoleChangeRequests({ profileId, allPending } = {}) {
  let q = supabase.from('role_change_requests').select('*').order('created_at', { ascending: false });
  if (profileId) q = q.eq('profile_id', profileId);
  if (allPending) q = q.eq('status', 'pending');
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(roleChangeRequestFromRow);
}

export async function createRoleChangeRequest(profileId, currentRole, requestedRole, reason) {
  const { data, error } = await supabase.from('role_change_requests').insert({
    profile_id: profileId, role_before: currentRole, requested_role: requestedRole, reason,
  }).select().single();
  if (error) throw error;
  return roleChangeRequestFromRow(data);
}

// Approval/denial is privileged (grants roles) so it never runs from the
// browser's own Supabase client — it goes through the review-role-change
// Netlify Function, which re-validates the caller server-side with the
// service-role key before touching profiles.role.
export async function reviewRoleChangeRequest(requestId, decision, reviewNote) {
  return callReviewRoleChange({ requestId, decision, reviewNote });
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

// ---------- unified work-order photo gallery ----------
// Every photo lives in ONE place per work order — the work_order_photos
// table + the 'work-order-photos' Storage bucket — tagged with categories
// instead of being duplicated into separate intake/log-work JSON blobs.
// Only metadata + storage paths are ever kept in Postgres/JSON; image bytes
// live in Storage, so this scales to hundreds of photos per job without
// bloating rows, and thumb/full-res are separate objects for lazy loading.
export const PHOTO_CATEGORIES = ['Intake', 'Before Repair', 'During Repair', 'After Repair', 'Damage', 'Parts', 'Warranty', 'Serial Number', 'Other'];
const PHOTO_BUCKET = 'work-order-photos';

// ---------- signed-URL layer (private-bucket conversion, Phase B) ----------
// The database stores ONLY object paths (storage_path / thumb_path). We never
// persist a signed or public URL anywhere (DB, localStorage, IndexedDB). URLs
// are minted on demand via createSignedUrl and held ONLY in this in-memory
// cache for the current session/shop. clearPhotoUrlCache() wipes it on sign-out
// and shop-switch so a previous tenant's URLs can never be reused.
//
// TTL rationale: 1h (3600s) balances not re-signing on every render against
// keeping the exposure window short once the bucket is private (a leaked URL
// dies within the hour). Print/invoice re-signs on entry (see refreshPhotoUrls)
// so a long-open job never prints broken images. If a future workflow needs a
// URL to outlive an hour (e.g. emailing a customer a link), mint that one
// deliberately with a longer TTL at that call site — do NOT raise this default.
export const SIGNED_URL_TTL_SECONDS = 3600;
const SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000; // re-sign 5 min before expiry
const _signedUrlCache = new Map(); // path -> { url, expiresAt }

// Clears all in-memory signed URLs. MUST be called on sign-out and shop-switch.
export function clearPhotoUrlCache() {
  _signedUrlCache.clear();
}

// Batch-signs a list of object paths in one round trip, using cached URLs that
// are still comfortably in-date. Returns a plain { path: url } map. A path that
// fails to sign maps to '' (caller renders its own broken/placeholder state).
async function signPaths(paths) {
  const out = {};
  const now = Date.now();
  const need = [];
  for (const p of paths) {
    if (!p) continue;
    const hit = _signedUrlCache.get(p);
    if (hit && hit.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS > now) out[p] = hit.url;
    else if (!need.includes(p)) need.push(p);
  }
  if (need.length) {
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(need, SIGNED_URL_TTL_SECONDS);
    if (error) throw error;
    const expiresAt = now + SIGNED_URL_TTL_SECONDS * 1000;
    for (const entry of (data || [])) {
      const url = entry.signedUrl || '';
      out[entry.path] = url;
      if (url) _signedUrlCache.set(entry.path, { url, expiresAt });
    }
  }
  return out;
}

// Fills .url / .thumbUrl on a list of photo objects from their stored paths.
// Exported so callers can re-sign an already-loaded list before printing.
export async function signPhotos(photos) {
  const list = photos || [];
  const paths = [];
  for (const p of list) { if (p.storagePath) paths.push(p.storagePath); if (p.thumbPath) paths.push(p.thumbPath); }
  let map = {};
  try { map = await signPaths(paths); } catch (e) { console.error('Failed to sign photo URLs', e); }
  return list.map(p => ({ ...p, url: map[p.storagePath] || '', thumbUrl: map[p.thumbPath] || '' }));
}
// Alias used by the UI when refreshing URLs on print/invoice entry.
export const refreshPhotoUrls = signPhotos;

function photoFromRow(row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    // Only the paths come from the DB; url/thumbUrl are filled by signPhotos().
    storagePath: row.storage_path,
    thumbPath: row.thumb_path,
    url: '',
    thumbUrl: '',
    width: row.width || null,
    height: row.height || null,
    caption: row.caption || '',
    categories: row.categories || [],
    displayOrder: row.display_order || 0,
    customerVisible: row.customer_visible !== false,
    includeOnInvoice: row.include_on_invoice === true,
    activityId: row.activity_id || null,
    photoType: row.photo_type || 'general',
    extractedText: row.extracted_text || '',
    extractionConfidence: row.extraction_confidence != null ? Number(row.extraction_confidence) : null,
    createdAt: new Date(row.created_at).getTime(),
    createdBy: row.created_by,
    // Soft-delete + retention/purge lifecycle (Phase C). These describe WHY an
    // object still exists in storage even after the row is inactive; nothing
    // here deletes bytes — permanent purge is a separate server-side release.
    active: row.active !== false,
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
    archivedBy: row.archived_by || null,
    purgeApprovedAt: row.purge_approved_at ? new Date(row.purge_approved_at).getTime() : null,
    purgeApprovedBy: row.purge_approved_by || null,
    purgeAfter: row.purge_after ? new Date(row.purge_after).getTime() : null,
    storageDeletedAt: row.storage_deleted_at ? new Date(row.storage_deleted_at).getTime() : null,
    replacedByPhotoId: row.replaced_by_photo_id || null,
  };
}

export async function fetchWorkOrderPhotos(workOrderId) {
  const { data, error } = await supabase
    .from('work_order_photos')
    .select('*')
    .eq('work_order_id', workOrderId)
    .eq('active', true)
    .order('display_order')
    .order('created_at');
  if (error) throw error;
  return signPhotos((data || []).map(photoFromRow));
}

// blobOrig / blobThumb: already-enhanced JPEG Blobs produced client-side
// (rotation + brightness/contrast/saturation baked in via canvas) — this
// function only handles the upload + row insert, never touches pixels.
export async function uploadWorkOrderPhoto(workOrderId, photo, userId) {
  const photoId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const origPath = `${workOrderId}/${photoId}-orig.jpg`;
  const thumbPath = `${workOrderId}/${photoId}-thumb.jpg`;

  const upOrig = await supabase.storage.from(PHOTO_BUCKET).upload(origPath, photo.blobOrig, { contentType: 'image/jpeg', upsert: false });
  if (upOrig.error) throw upOrig.error;
  const upThumb = await supabase.storage.from(PHOTO_BUCKET).upload(thumbPath, photo.blobThumb, { contentType: 'image/jpeg', upsert: false });
  if (upThumb.error) throw upThumb.error;

  const row = {
    id: photoId,
    work_order_id: workOrderId,
    storage_path: origPath,
    thumb_path: thumbPath,
    width: photo.width || null,
    height: photo.height || null,
    mime_type: 'image/jpeg',
    size_bytes: photo.blobOrig ? photo.blobOrig.size : null,
    caption: photo.caption || '',
    categories: photo.categories || [],
    customer_visible: photo.customerVisible !== false,
    include_on_invoice: !!photo.includeOnInvoice,
    activity_id: photo.activityId || null,
    photo_type: photo.photoType || 'general',
    extracted_text: photo.extractedText || '',
    extraction_confidence: photo.extractionConfidence != null ? photo.extractionConfidence : null,
    created_by: userId || null,
  };
  const { data, error } = await supabase.from('work_order_photos').insert(row).select().single();
  if (error) throw error;
  const [signed] = await signPhotos([photoFromRow(data)]);
  return signed;
}

// Patches apply immediately to Supabase — callers never hold a selection
// (e.g. "include on invoice") only in local state; this always returns the
// saved row so the caller can sync it back into state precisely.
export async function updateWorkOrderPhoto(photoId, patch) {
  const row = {};
  if (patch.caption !== undefined) row.caption = patch.caption;
  if (patch.categories !== undefined) row.categories = patch.categories;
  if (patch.customerVisible !== undefined) row.customer_visible = patch.customerVisible;
  if (patch.includeOnInvoice !== undefined) row.include_on_invoice = patch.includeOnInvoice;
  if (patch.activityId !== undefined) row.activity_id = patch.activityId;
  if (patch.displayOrder !== undefined) row.display_order = patch.displayOrder;
  if (patch.extractedText !== undefined) row.extracted_text = patch.extractedText;
  if (patch.extractionConfidence !== undefined) row.extraction_confidence = patch.extractionConfidence;
  const { data, error } = await supabase.from('work_order_photos').update(row).eq('id', photoId).select().single();
  if (error) throw error;
  const [signed] = await signPhotos([photoFromRow(data)]);
  return signed;
}

// Thin, explicit wrapper for the one action the invoice-selection UI needs —
// persists immediately to Supabase, never held only in frontend state.
export async function setPhotoInvoiceInclusion(photoId, include) {
  return updateWorkOrderPhoto(photoId, { includeOnInvoice: !!include });
}

// Single "Show to Customer" control used consistently across photos,
// serial numbers, and activity — persists immediately, no separate
// "include on invoice" flag.
export async function setPhotoCustomerVisible(photoId, visible) {
  return updateWorkOrderPhoto(photoId, { customerVisible: !!visible });
}

// SOFT DELETE ONLY. This flips the row inactive and records who/when; it never
// touches storage bytes. The object is deliberately preserved for audit,
// dispute, warranty, insurance, and recovery. Permanent removal is a separate,
// approval-gated, server-side purge (see supabase-schema.sql §21 + the
// scripts/storage-inventory-and-classify.js report), never a browser action.
export async function deleteWorkOrderPhoto(photoId, userId) {
  const { error } = await supabase.from('work_order_photos').update({
    active: false, archived_at: new Date().toISOString(), archived_by: userId || null,
  }).eq('id', photoId);
  if (error) throw error;
}

// ---------- shop-configured serial-number labels ----------
function serialLabelFromRow(row) {
  return {
    id: row.id,
    shopId: row.shop_id || null,
    label: row.label,
    sortOrder: row.sort_order || 0,
    isActive: row.is_active !== false,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// Every active user reads this (needed for the scan-review dropdown);
// callers filter to isActive themselves when building that dropdown so a
// disabled label still resolves for records that already reference it.
export async function fetchSerialLabelOptions() {
  const { data, error } = await supabase.from('shop_serial_label_options').select('*').order('sort_order');
  if (error) throw error;
  return (data || []).map(serialLabelFromRow);
}

export async function createSerialLabelOption(label, sortOrder) {
  const { data, error } = await supabase.from('shop_serial_label_options')
    .insert({ label: label.trim(), sort_order: sortOrder != null ? sortOrder : 0 }).select().single();
  if (error) throw error;
  return serialLabelFromRow(data);
}

export async function updateSerialLabelOption(id, patch) {
  const row = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) row.label = patch.label.trim();
  if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  const { data, error } = await supabase.from('shop_serial_label_options').update(row).eq('id', id).select().single();
  if (error) throw error;
  return serialLabelFromRow(data);
}

// Persists a full reordering in one round trip — callers pass the list in
// its new display order; sort_order is just each item's index.
export async function reorderSerialLabelOptions(orderedIds) {
  await Promise.all(orderedIds.map((id, i) => updateSerialLabelOption(id, { sortOrder: i })));
}

// ---------- serial-number records (multiple per work order) ----------
function serialNumberRowToRecord(row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    label: row.label,
    serialNumber: row.serial_number || '',
    photoId: row.photo_id || null,
    extractionConfidence: row.extraction_confidence != null ? Number(row.extraction_confidence) : null,
    showToCustomer: row.show_to_customer === true,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export async function fetchSerialNumbers(workOrderId) {
  const { data, error } = await supabase.from('work_order_serial_numbers')
    .select('*').eq('work_order_id', workOrderId).eq('active', true).order('created_at');
  if (error) throw error;
  return (data || []).map(serialNumberRowToRecord);
}

// Single write path for a new serial-number record: upload the photo
// (tagged photo_type='serial_number' so it never lands as an unclassified
// gallery photo), then insert the record pointing at it. If the record
// insert fails after the photo succeeds, the photo is still a valid gallery
// photo (just not yet linked to a record) rather than being silently lost.
export async function createSerialNumberRecord(workOrderId, photoFile, fields, userId) {
  const photo = await uploadWorkOrderPhoto(workOrderId, {
    ...photoFile,
    categories: Array.from(new Set([...(photoFile.categories || []), 'Serial Number'])),
    photoType: 'serial_number',
    extractedText: fields.serialNumber || '',
    extractionConfidence: fields.extractionConfidence != null ? fields.extractionConfidence : null,
  }, userId);

  const { data, error } = await supabase.from('work_order_serial_numbers').insert({
    work_order_id: workOrderId,
    label: fields.label.trim(),
    serial_number: (fields.serialNumber || '').trim(),
    photo_id: photo.id,
    extraction_confidence: fields.extractionConfidence != null ? fields.extractionConfidence : null,
    show_to_customer: !!fields.showToCustomer,
    created_by: userId || null,
  }).select().single();
  if (error) throw error;
  return { record: serialNumberRowToRecord(data), photo };
}

// Manual edits (label, value, visibility). Correcting serial_number here
// also updates the linked photo's extracted_text so the two never drift
// apart, same guarantee as before, now per-record instead of per-job.
export async function updateSerialNumberRecord(id, patch) {
  const row = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) row.label = patch.label.trim();
  if (patch.serialNumber !== undefined) row.serial_number = patch.serialNumber.trim();
  if (patch.showToCustomer !== undefined) row.show_to_customer = !!patch.showToCustomer;
  const { data, error } = await supabase.from('work_order_serial_numbers').update(row).eq('id', id).select().single();
  if (error) throw error;
  const record = serialNumberRowToRecord(data);
  if (patch.serialNumber !== undefined && record.photoId) {
    await updateWorkOrderPhoto(record.photoId, { extractedText: record.serialNumber });
  }
  return record;
}

// Replacing/rescanning a record's photo: uploads the NEW photo to a fresh
// generated path, points the record at it only after the upload succeeds, and
// KEEPS the prior object + row (never deleted) as recoverable evidence during
// the retention period. Lineage: the prior photo row is stamped with
// replaced_by_photo_id = new photo, so the supersede chain is queryable.
export async function replaceSerialNumberPhoto(id, workOrderId, photoFile, reviewedValue, confidence, userId) {
  // Capture the outgoing photo id BEFORE we repoint the record.
  const { data: existing } = await supabase.from('work_order_serial_numbers').select('photo_id').eq('id', id).single();
  const priorPhotoId = existing && existing.photo_id;

  const photo = await uploadWorkOrderPhoto(workOrderId, {
    ...photoFile,
    categories: Array.from(new Set([...(photoFile.categories || []), 'Serial Number'])),
    photoType: 'serial_number',
    extractedText: reviewedValue || '',
    extractionConfidence: confidence != null ? confidence : null,
  }, userId);
  const { data, error } = await supabase.from('work_order_serial_numbers').update({
    photo_id: photo.id, serial_number: (reviewedValue || '').trim(),
    extraction_confidence: confidence != null ? confidence : null, updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throw error;
  // Best-effort lineage + soft-archive of the superseded photo. A failure here
  // must not lose the new photo/record, so it only logs.
  if (priorPhotoId && priorPhotoId !== photo.id) {
    const { error: linErr } = await supabase.from('work_order_photos').update({
      replaced_by_photo_id: photo.id, active: false,
      archived_at: new Date().toISOString(), archived_by: userId || null,
    }).eq('id', priorPhotoId);
    if (linErr) console.error('Failed to record serial-photo replacement lineage', linErr);
  }
  return { record: serialNumberRowToRecord(data), photo };
}

export async function deleteSerialNumberRecord(id) {
  const { error } = await supabase.from('work_order_serial_numbers').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
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

// Invite (or add an existing user as) staff. Roles are restricted server-side
// to mechanic|shop_owner; shop_id is derived from the inviter's active shop on
// the server and can't be set here. Returns the raw result including `status`
// so the UI can branch (invited | added_existing_user | already_member |
// inactive_member | requires_confirmation) instead of treating business
// responses as thrown errors.
export async function inviteStaff(email, fullName, role, opts = {}) {
  const session = await getSession();
  if (!session) throw new Error('Not signed in.');
  const res = await fetch(MANAGE_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      action: 'invite_staff', email, fullName, role: role || 'mechanic',
      addExistingUser: !!opts.addExistingUser,
      locationId: opts.locationId || null,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, httpStatus: res.status, status: json.status || null, userId: json.userId || null, error: json.error || null };
}

// One-release compatibility alias for older callers.
export async function inviteMechanic(email, fullName) {
  return inviteStaff(email, fullName, 'mechanic');
}
export async function setUserActive(userId, active) {
  return callManageUsers('set_active', { userId, active });
}
// Shop-level enable/disable: flips shop_memberships.is_active for ONE member in
// ONE shop, via the set_membership_active() SECURITY DEFINER RPC (section-23).
// The RPC derives the shop from current_user_shop_id(), requires the caller be
// an owner of that shop, protects the last active owner, and writes ONLY
// is_active — never profiles.active. No shop_id param, so it can't be pointed
// at another tenant. (Direct table UPDATE is intentionally NOT used: staging has
// no owner UPDATE policy on shop_memberships, so it would be RLS-blocked.)
export async function setMembershipActive({ profileId, active }) {
  const { data, error } = await supabase.rpc('set_membership_active', {
    p_profile_id: profileId,
    p_active: active,
  });
  if (error) throw error;
  return data;
}
export async function setUserRole(userId, role) {
  return callManageUsers('set_role', { userId, role });
}

async function callReviewRoleChange(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');
  const res = await fetch('/.netlify/functions/review-role-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
export async function deleteUserAccount(userId) {
  return callManageUsers('delete_user', { userId });
}

// Promote/demote a staff member's role from the Mechanic Profile page's
// Manage Role section. Deliberately routed through its own Netlify Function
// (not manage-users' set_role, which skips the last-owner/active-account
// safety checks) — see netlify/functions/update-staff-role.js.
async function callUpdateStaffRole(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');
  const res = await fetch('/.netlify/functions/update-staff-role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
export async function updateStaffRole(targetUserId, newRole) {
  return callUpdateStaffRole({ targetUserId, newRole });
}

// ===========================================================================
// Multi-tenant: shops, locations, memberships, active-shop context
// (schema section 20). The tenant boundary is enforced by RLS + the
// current_user_shop_id() helper server-side; these functions drive the UI.
// ===========================================================================
function shopFromRow(r) {
  return {
    id: r.id, name: r.name, legalName: r.legal_name || '', phone: r.phone || '',
    email: r.email || '', timezone: r.timezone || '', isActive: r.is_active !== false,
    address: [r.address_line1, r.address_line2, r.city, r.region, r.postal_code].filter(Boolean).join(', '),
    addressLine1: r.address_line1 || '', addressLine2: r.address_line2 || '',
    city: r.city || '', region: r.region || '', postalCode: r.postal_code || '', country: r.country || '',
    settings: r.settings || {},
  };
}
function locationFromRow(r) {
  return {
    id: r.id, shopId: r.shop_id, name: r.name, locationCode: r.location_code || '',
    phone: r.phone || '', email: r.email || '', timezone: r.timezone || '',
    isPrimary: r.is_primary === true, isActive: r.is_active !== false,
    address: [r.address_line1, r.address_line2, r.city, r.region, r.postal_code].filter(Boolean).join(', '),
    settings: r.settings || {},
  };
}
function membershipFromRow(r) {
  return {
    id: r.id, profileId: r.profile_id, shopId: r.shop_id, role: r.role,
    isActive: r.is_active !== false, defaultLocationId: r.default_location_id || null,
    shop: r.shops ? shopFromRow(r.shops) : null,
  };
}

// Every shop the signed-in user actively belongs to (drives the shop switcher).
export async function fetchMyMemberships() {
  const session = await getSession();
  const uid = session && session.user && session.user.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from('shop_memberships').select('*, shops(*)')
    .eq('profile_id', uid).eq('is_active', true);
  if (error) throw error;
  return (data || []).map(membershipFromRow);
}

// Switch active shop. Validated server-side (set_active_shop only accepts a
// shop the caller is an active member of) then persisted on profiles. The
// CALLER is responsible for clearing all tenant-scoped UI state and reloading
// so no rows from the previous shop remain visible.
export async function setActiveShop(shopId) {
  const { error } = await supabase.rpc('set_active_shop', { p_shop_id: shopId });
  if (error) throw error;
  return shopId;
}

export async function fetchShop(shopId) {
  const { data, error } = await supabase.from('shops').select('*').eq('id', shopId).single();
  if (error) throw error;
  return shopFromRow(data);
}

export async function updateShop(shopId, patch) {
  const row = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.legalName !== undefined) row.legal_name = patch.legalName;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.addressLine1 !== undefined) row.address_line1 = patch.addressLine1;
  if (patch.addressLine2 !== undefined) row.address_line2 = patch.addressLine2;
  if (patch.city !== undefined) row.city = patch.city;
  if (patch.region !== undefined) row.region = patch.region;
  if (patch.postalCode !== undefined) row.postal_code = patch.postalCode;
  if (patch.country !== undefined) row.country = patch.country;
  if (patch.settings !== undefined) row.settings = patch.settings;
  const { data, error } = await supabase.from('shops').update(row).eq('id', shopId).select().single();
  if (error) throw error;
  return shopFromRow(data);
}

// Locations for the active shop (RLS scopes automatically); pass a shopId only
// when reading a specific shop you belong to.
export async function fetchLocations(shopId) {
  let q = supabase.from('shop_locations').select('*').eq('is_active', true);
  if (shopId) q = q.eq('shop_id', shopId);
  // NOTE: do NOT order by is_primary — that column is not in the live schema
  // (schema drift, see SCHEMA-RECONCILIATION.md), and ordering by it returns
  // HTTP 400. Order by name only.
  const { data, error } = await q.order('name');
  if (error) throw error;
  return (data || []).map(locationFromRow);
}

export async function createLocation(shopId, fields) {
  const { data, error } = await supabase.from('shop_locations').insert({
    shop_id: shopId, name: (fields.name || '').trim(), location_code: fields.locationCode || null,
    phone: fields.phone || null, email: fields.email || null, timezone: fields.timezone || null,
    is_primary: !!fields.isPrimary,
  }).select().single();
  if (error) throw error;
  return locationFromRow(data);
}

export async function updateLocation(id, patch) {
  const row = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.locationCode !== undefined) row.location_code = patch.locationCode;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.isPrimary !== undefined) row.is_primary = patch.isPrimary;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  const { data, error } = await supabase.from('shop_locations').update(row).eq('id', id).select().single();
  if (error) throw error;
  return locationFromRow(data);
}

// Owner-only: staff roster for the active shop, joined with their membership
// role. Read via the "memberships: self read" (owner branch) policy.
// Canonical team-roster loader. RLS still governs visibility (owner sees all
// members of the shop; a non-owner only ever gets their own row). Pass
// includeInactive:true to also return deactivated/removed memberships (needed
// so the roster can show an "Inactive" status, not just silently drop them).
export async function fetchShopMembers(shopId, { includeInactive = false } = {}) {
  let q = supabase.from('shop_memberships').select('*, profiles(*)').eq('shop_id', shopId);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(r => ({ ...membershipFromRow(r), profile: r.profiles ? profileFromRow(r.profiles) : null }));
}

// Owner team roster. Backed by the get_shop_roster_admin() SECURITY DEFINER
// function (section-24), owner-gated and RLS-independent — the owner reading
// shop_memberships DIRECTLY under RLS returns only their own row in production
// (the is_shop_owner(shop_id) branch of the SELECT policy isn't granting).
// Returns ALL members (active + inactive) so the Inactive filter / reactivate
// keep working. Shaped to match fetchShopMembers() so the roster UI is
// source-agnostic. Non-owners get zero rows from the function.
export async function fetchShopRosterAdmin() {
  const { data, error } = await supabase.rpc('get_shop_roster_admin');
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.profile_id,
    profileId: r.profile_id,
    role: r.role,
    isActive: r.is_active !== false,
    defaultLocationId: r.default_location_id || null,
    shop: null,
    profile: { id: r.profile_id, name: r.full_name || '', email: r.email || '', role: r.role, active: r.is_active !== false },
  }));
}

// Non-owner (mechanic) team-directory read. Backed by the get_team_roster()
// SECURITY DEFINER function (section-22), which returns ONLY the whitelisted
// roster columns for the caller's current shop and ACTIVE coworkers — no
// email/phone/availability/admin fields, and no shop_id parameter to
// manipulate. Shaped to match fetchShopMembers() so the roster UI is
// source-agnostic.
export async function fetchTeamRosterLimited() {
  const { data, error } = await supabase.rpc('get_team_roster');
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.profile_id,
    profileId: r.profile_id,
    role: r.role,
    isActive: r.is_active !== false,
    defaultLocationId: r.default_location_id || null,
    shop: null,
    // Only whitelisted fields are known here; email is intentionally absent.
    profile: { id: r.profile_id, name: r.full_name || '', email: '', role: r.role, active: r.is_active !== false },
  }));
}

// ===========================================================================
// Legal agreements + secure owner onboarding (schema section 25)
//   Acceptance rows are NEVER written directly from the client — the DB has no
//   client insert policy on legal_acceptances. accept_legal_agreement() and
//   create_shop_as_owner() are SECURITY DEFINER RPCs bound to auth.uid(); the
//   canonical agreement text/version is stored server-side, not sent up here.
// ===========================================================================
function legalAgreementFromRow(r) {
  return {
    id: r.id, kind: r.kind, version: r.version, title: r.title,
    body: r.body, contentHash: r.content_hash, isCurrent: r.is_current === true,
    publishedAt: r.published_at ? new Date(r.published_at).getTime() : null,
  };
}

// The single current agreement of a kind (default: the pilot agreement the
// onboarding screen shows). RLS lets any signed-in user read agreements.
export async function fetchCurrentLegalAgreement(kind = 'pilot_agreement') {
  const { data, error } = await supabase
    .from('legal_agreements')
    .select('*')
    .eq('kind', kind)
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw error;
  return data ? legalAgreementFromRow(data) : null;
}

// Record acceptance of a specific agreement version for the current user. The
// client sends only WHICH agreement it displayed (kind + version); the RPC
// copies the canonical text/hash server-side. Idempotent.
export async function acceptLegalAgreement(kind, version) {
  const { data, error } = await supabase.rpc('accept_legal_agreement', {
    p_kind: kind,
    p_version: version,
  });
  if (error) throw error;
  return data; // agreement id
}

// Atomic owner onboarding. No profile/owner/shop id is sent — identity is
// auth.uid() server-side. The RPC verifies the current pilot agreement was
// accepted, then creates shop + first location + active owner membership, sets
// the active shop, and writes an audit-log entry, all in one transaction.
export async function createShopAsOwner(shopName, locationName) {
  const { data, error } = await supabase.rpc('create_shop_as_owner', {
    p_shop_name: shopName,
    p_location_name: locationName,
  });
  if (error) throw error;
  return data; // new shop id
}

// Section 25.5 — existing-user agreement gate. Read-only: returns the current
// agreement of a kind and whether the CURRENT authenticated user has already
// accepted THAT version. Identity is resolved server-side (RLS on
// legal_acceptances only exposes the caller's own rows via profile_id =
// auth.uid()); no profile id is sent from the client. `accepted` is true only
// when a current agreement exists AND the caller has an acceptance row for it,
// so a newer published version flips `accepted` back to false and re-gates.
export async function fetchAgreementGateStatus(kind = 'pilot_agreement') {
  const agreement = await fetchCurrentLegalAgreement(kind);
  if (!agreement) return { agreement: null, accepted: true, rows: [], uid: null }; // nothing to gate on
  // Resolve the CURRENT user from the authenticated session (auth.uid()), and
  // scope the acceptance lookup to that user explicitly. This is required for
  // correctness, not just tidiness: the legal_acceptances self-read RLS is
  // `profile_id = auth.uid() OR is_platform_admin()`, so a PLATFORM ADMIN would
  // otherwise read EVERY user's acceptance rows and a single other user's
  // acceptance of the current version would make `accepted` wrongly true —
  // hiding the gate. Filtering by the caller's own id makes the check per-user.
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess && sess.session && sess.session.user && sess.session.user.id;
  if (!uid) throw new Error('No authenticated user for agreement check');
  const { data, error } = await supabase
    .from('legal_acceptances')
    .select('id, profile_id, agreement_id, version')
    .eq('agreement_id', agreement.id)
    .eq('profile_id', uid)
    .limit(1);
  if (error) throw error;
  return { agreement, accepted: (data || []).length > 0, rows: data || [], uid };
}

// ===========================================================================
// Read-only platform administration (schema section 25)
//   All three reads are SECURITY DEFINER functions gated by is_platform_admin()
//   inside the DB — a non-admin gets zero rows. There are NO cross-tenant table
//   queries here; the client only ever calls these whitelisted RPCs.
// ===========================================================================

// Is the signed-in user a platform admin? Drives whether the Platform Admin
// nav entry/area is offered. Authorization is still enforced in the DB — the
// UI flag is convenience only, never the security boundary.
export async function fetchIsPlatformAdmin() {
  const { data, error } = await supabase.rpc('is_platform_admin');
  if (error) throw error;
  return data === true;
}

function platformShopFromRow(r) {
  return {
    shopId: r.shop_id,
    name: r.shop_name || '',
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
    isActive: r.is_active !== false,
    ownerName: r.owner_name || '',
    ownerEmail: r.owner_email || '',
    locationCount: Number(r.location_count || 0),
    userCount: Number(r.user_count || 0),
    agreementStatus: r.agreement_status || 'not accepted',
    lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).getTime() : null,
  };
}

export async function fetchPlatformShops() {
  const { data, error } = await supabase.rpc('get_platform_shops');
  if (error) throw error;
  return (data || []).map(platformShopFromRow);
}

export async function fetchPlatformShopDetails(shopId) {
  const { data, error } = await supabase.rpc('get_platform_shop_details', { p_shop_id: shopId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? platformShopFromRow(row) : null;
}

export async function fetchPlatformShopMembers(shopId) {
  const { data, error } = await supabase.rpc('get_platform_shop_members', { p_shop_id: shopId });
  if (error) throw error;
  return (data || []).map(r => ({
    profileId: r.profile_id,
    name: r.full_name || '',
    email: r.email || '',
    role: r.role,
    isActive: r.is_active !== false,
    joinedAt: r.joined_at ? new Date(r.joined_at).getTime() : null,
  }));
}
