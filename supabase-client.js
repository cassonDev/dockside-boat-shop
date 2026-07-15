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
    phone: row.phone || '',
    name: row.full_name || row.email,
    role: row.role,
    active: !!row.active,
    outOfOffice: !!row.out_of_office,
    availabilityStatus: row.availability_status || 'available',
    oooStart: row.out_of_office_start || '',
    oooEnd: row.out_of_office_end || '',
    availabilityNote: row.availability_note || '',
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
    active: row.active !== false,
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

// Full work-order/customer-details edit (Edit Job Details modal). Never
// touches id, created_at, or created_by — the QR/job code and provenance
// stay stable across edits. RLS + the guard_work_order_edits trigger decide
// who is actually permitted to change which columns (shop_owner and
// service_advisor: everything; mechanic: none of these fields, only status
// via updateJobStatus above).
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
// author, a service advisor, or a manager — each edit writes the prior
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

// Availability: a mechanic may update only their own row; shop_owner/service_advisor
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

function publicPhotoUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
  return data && data.publicUrl;
}

function photoFromRow(row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    url: publicPhotoUrl(row.storage_path),
    thumbUrl: publicPhotoUrl(row.thumb_path),
    width: row.width || null,
    height: row.height || null,
    caption: row.caption || '',
    categories: row.categories || [],
    displayOrder: row.display_order || 0,
    customerVisible: row.customer_visible !== false,
    includeOnInvoice: row.include_on_invoice === true,
    activityId: row.activity_id || null,
    createdAt: new Date(row.created_at).getTime(),
    createdBy: row.created_by,
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
  return (data || []).map(photoFromRow);
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
    created_by: userId || null,
  };
  const { data, error } = await supabase.from('work_order_photos').insert(row).select().single();
  if (error) throw error;
  return photoFromRow(data);
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
  const { data, error } = await supabase.from('work_order_photos').update(row).eq('id', photoId).select().single();
  if (error) throw error;
  return photoFromRow(data);
}

// Thin, explicit wrapper for the one action the invoice-selection UI needs —
// persists immediately to Supabase, never held only in frontend state.
export async function setPhotoInvoiceInclusion(photoId, include) {
  return updateWorkOrderPhoto(photoId, { includeOnInvoice: !!include });
}

export async function deleteWorkOrderPhoto(photoId, userId) {
  const { error } = await supabase.from('work_order_photos').update({
    active: false, archived_at: new Date().toISOString(), archived_by: userId || null,
  }).eq('id', photoId);
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

export async function inviteMechanic(email, fullName, role) {
  return callManageUsers('invite_mechanic', { email, fullName, role: role || 'mechanic' });
}
export async function setUserActive(userId, active) {
  return callManageUsers('set_active', { userId, active });
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
