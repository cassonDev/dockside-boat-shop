// ===========================================================================
// document-display.js — Step 5D: display and configuration integration.
//
//   Pure module: imports nothing, references no global, no module-scope side
//   effects, so `node --test` imports it directly.
//
//   THE SHAPE CONTRACT (revision 109's defect, fixed here)
//   The UI never sees database rows. The approved data layer converts them:
//
//     photoFromRow   -> photoType, customerVisible, documentCaptureId,
//                       documentPageNumber, thumbUrl, url, categories
//     activityFromRow-> activityType, aiGenerated, documentCaptureId,
//                       commentSequence, authorName, createdAt
//
//   Realtime is converted too: `subscribeToActivities` calls
//   `activityFromRow(payload.new)` before handing the row over
//   (supabase-client.js:469), so both delivery paths are camelCase.
//
//   Every field access in this module therefore goes through ONE named
//   accessor, camelCase first, raw row accepted as a fallback so a future
//   unconverted payload degrades instead of silently failing a security gate.
//   No fallback expression is written anywhere else in the file.
//
//   FOUR RULES THAT ARE NOT NEGOTIABLE
//   1. A document photo is STAFF-ONLY, whatever any visibility flag says.
//   2. The AI badge follows the row's own AI flag alone; other activity types'
//      badge behaviour is untouched.
//   3. The author is the reviewing human. Never the model, never a tier.
//   4. The feature is on only when `features.document_transcription === true`.
// ===========================================================================

export const DOCUMENT_ACTIVITY_TYPE = 'document_transcription';
export const DOCUMENT_PHOTO_TYPE = 'document';
export const DOCUMENT_PHOTO_CATEGORY = 'Document';
export const DOCUMENT_FEATURE_KEY = 'document_transcription';

// ---------------------------------------------------------------------------
// Named accessors — the ONLY place a field name appears
// ---------------------------------------------------------------------------

const pick = (row, camel, snake) => {
  if (!row) return undefined;
  return row[camel] !== undefined ? row[camel] : row[snake];
};

export const photoTypeOf = (p) => pick(p, 'photoType', 'photo_type') || 'general';
export const photoCaptureIdOf = (p) => pick(p, 'documentCaptureId', 'document_capture_id') || null;
export const photoPageNumberOf = (p) => {
  const n = pick(p, 'documentPageNumber', 'document_page_number');
  return n == null ? null : n;
};
// `photoFromRow` writes `customerVisible: row.customer_visible !== false`, so an
// absent flag means visible for ordinary photos. Only an explicit false hides
// one — and a document photo is hidden by TYPE, never by this flag.
export const photoCustomerVisible = (p) => pick(p, 'customerVisible', 'customer_visible') !== false;
export const photoThumbUrlOf = (p) => pick(p, 'thumbUrl', 'thumb_url') || '';

export const activityTypeOf = (a) => pick(a, 'activityType', 'activity_type') || '';
export const activityAiGenerated = (a) => pick(a, 'aiGenerated', 'ai_generated') === true;
export const activityCaptureIdOf = (a) => pick(a, 'documentCaptureId', 'document_capture_id') || null;
export const activitySequenceOf = (a) => {
  const n = pick(a, 'commentSequence', 'comment_sequence');
  return n == null ? null : n;
};
export const activityCreatedAtOf = (a) => pick(a, 'createdAt', 'created_at') || '';
export const activityAuthorNameOf = (a) => pick(a, 'authorName', 'author_name') || '';

// Strips the recognized raw aliases so a normalized row owns EXACTLY ONE
// spelling of each field. Leaving both meant a later merge could carry
// `activity_type` beside a different `activityType`, and any consumer not yet
// converted would read the stale one.
const RAW_ACTIVITY_ALIASES = ['activity_type', 'ai_generated', 'document_capture_id',
  'comment_sequence', 'created_at', 'author_name'];
const RAW_PHOTO_ALIASES = ['photo_type', 'customer_visible', 'document_capture_id',
  'document_page_number', 'thumb_url'];

const without = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

export function normalizeActivity(a) {
  if (!a) return a;
  // Accessors read the ORIGINAL object, so camelCase still wins over a raw
  // alias when the two disagree; the alias is then dropped.
  return {
    ...without(a, RAW_ACTIVITY_ALIASES),
    id: a.id,
    activityType: activityTypeOf(a),
    aiGenerated: activityAiGenerated(a),
    documentCaptureId: activityCaptureIdOf(a),
    commentSequence: activitySequenceOf(a),
    createdAt: activityCreatedAtOf(a),
    authorName: activityAuthorNameOf(a),
  };
}

export function normalizePhoto(p) {
  if (!p) return p;
  return {
    ...without(p, RAW_PHOTO_ALIASES),
    photoType: photoTypeOf(p),
    customerVisible: photoCustomerVisible(p),
    documentCaptureId: photoCaptureIdOf(p),
    documentPageNumber: photoPageNumberOf(p),
    thumbUrl: photoThumbUrlOf(p),
  };
}

// ---------------------------------------------------------------------------
// Activity type lists
// ---------------------------------------------------------------------------

// The approved data layer (revision 96, binding Edit 1) already appends
// `document_transcription` to `ACTIVITY_TYPES` and `EDITABLE_ACTIVITY_TYPES`.
// 5D does not restate that list — it audits it, so a list that drifts is caught
// by a test rather than by a mechanic seeing a raw badge.
export const ACTIVITY_META_ADDITIONS = {
  document_transcription: { label: 'DOCUMENT', color: '#1F6F78', icon: '\u2637' },
  serial_number_captured: { label: 'SERIAL NUMBER', color: '#D97706', icon: '\u2317' },
};

export const REQUIRED_ACTIVITY_TYPES = ['document_transcription', 'serial_number_captured'];
export const REQUIRED_EDITABLE_TYPES = ['document_transcription'];

// Every consumer of the type list in one check: the data layer's whitelist, the
// editable list, and the badge map must agree.
//
// SCOPE: this audits whatever lists it is HANDED. Pointing it at the real
// `ACTIVITY_TYPES` / `EDITABLE_ACTIVITY_TYPES` exports is an integration step
// (STEP5D-REVIEW §6) — the approved data layer already contains both entries,
// so 5D must not restate them.
export function auditActivityTypes({ activityTypes, editableTypes, activityMeta: metaMap }) {
  const types = activityTypes || [];
  const meta = { ...ACTIVITY_META_ADDITIONS, ...(metaMap || {}) };
  return {
    missingFromActivityTypes: REQUIRED_ACTIVITY_TYPES.filter((t) => !types.includes(t)),
    missingFromEditable: REQUIRED_EDITABLE_TYPES.filter((t) => !(editableTypes || []).includes(t)),
    missingMeta: types.filter((t) => !meta[t]),
    ok: REQUIRED_ACTIVITY_TYPES.every((t) => types.includes(t))
      && REQUIRED_EDITABLE_TYPES.every((t) => (editableTypes || []).includes(t))
      && types.every((t) => !!meta[t]),
  };
}

// ---------------------------------------------------------------------------
// Feature state
// ---------------------------------------------------------------------------

// `=== true`, NOT the `!== false` default-on convention of the other flags.
export function isDocumentTranscriptionEnabled(shop) {
  const features = shop && shop.settings && shop.settings.features;
  return !!features && features[DOCUMENT_FEATURE_KEY] === true;
}

export const FEATURE_CARD = {
  key: DOCUMENT_FEATURE_KEY,
  title: 'Document Photo Transcription',
  description: 'Photograph handwritten or printed documents and turn them into reviewed work-order notes.',
};

// Owner only. The payload merges into existing settings so unrelated
// configuration and branding survive — no schema column, no data rewrite.
export function buildFeatureTogglePayload(shop, enabled, actorRole) {
  if (actorRole !== 'shop_owner') return { allowed: false, reason: 'owner_only' };
  const settings = (shop && shop.settings) || {};
  const features = settings.features || {};
  return {
    allowed: true,
    patch: { settings: { ...settings, features: { ...features, [DOCUMENT_FEATURE_KEY]: enabled === true } } },
  };
}

// Disabling stops new AI calls and new finalizations; nothing already saved is
// hidden or altered, and no read path below consults the flag.
export function disablingAffectsSavedRecords() { return false; }

// ---------------------------------------------------------------------------
// Timeline: badges, filters, ordering
// ---------------------------------------------------------------------------

export const isDocumentActivity = (a) => activityTypeOf(a) === DOCUMENT_ACTIVITY_TYPE;

export function activityMeta(type, existingMeta) {
  const entry = (existingMeta && existingMeta[type]) || ACTIVITY_META_ADDITIONS[type];
  return entry || { label: String(type || '').toUpperCase().replace(/_/g, ' '), color: '#16283D', icon: '' };
}

export function filterCounts(activities, knownTypes) {
  const known = new Set([...(knownTypes || []), ...Object.keys(ACTIVITY_META_ADDITIONS)]);
  const counts = { all: 0 };
  for (const t of known) counts[t] = 0;
  for (const a of activities || []) {
    counts.all += 1;
    const t = activityTypeOf(a);
    counts[t] = (counts[t] || 0) + 1;      // an unknown type is counted, never dropped
  }
  return counts;
}

// The shared AI-GENERATED badge, unchanged: a property of the row, not of the
// text, the tier, or the confidence.
export const showsAiBadge = (a) => activityAiGenerated(a);

export function authorLabel(a) {
  const name = activityAuthorNameOf(a).trim();
  return name || 'Unknown user';
}

// Comments of one capture are a BLOCK: they hold reviewed order internally, and
// the block sits where its newest row would sit. Timestamps within a capture
// differ by milliseconds and must not reshuffle 1, 2, 3.
export function sortActivitiesForTimeline(activities) {
  const list = [...(activities || [])];
  const time = (a) => Date.parse(activityCreatedAtOf(a)) || 0;
  const groups = new Map();
  list.forEach((a, i) => {
    const cap = isDocumentActivity(a) ? activityCaptureIdOf(a) : null;
    const key = cap ? `cap:${cap}` : `row:${i}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [], anchor: -Infinity, order: i });
    const g = groups.get(key);
    g.rows.push(a);
    g.anchor = Math.max(g.anchor, time(a));   // the block sits at its newest row
  });
  return [...groups.values()]
    .sort((x, y) => (y.anchor - x.anchor) || (x.order - y.order))
    .flatMap((g) => g.rows.sort((x, y) => {
      const sx = activitySequenceOf(x), sy = activitySequenceOf(y);
      if (sx != null && sy != null && sx !== sy) return sx - sy;   // reviewed order wins
      return time(y) - time(x);
    }));
}

// ---------------------------------------------------------------------------
// Realtime: one activity per id, whichever path delivered it
// ---------------------------------------------------------------------------

// `merge` is the APPROVED Step 4 `mergeActivityById` / `mergeActivitiesById`.
// Both inputs are normalized to the converter shape first, so a converted
// optimistic row and a (hypothetically) raw realtime row can never merge into
// one object carrying both spellings of the same field.
export function createActivityStream({ merge, mergeMany }) {
  if (typeof merge !== 'function') throw new Error('createActivityStream requires the approved merge helper.');
  const mergeAll = typeof mergeMany === 'function'
    ? mergeMany
    : (list, incoming) => (incoming || []).reduce(merge, list);

  return {
    applyOptimistic: (list, saved) =>
      sortActivitiesForTimeline(mergeAll(list || [], (saved || []).map(normalizeActivity))),
    applyRealtime: (list, row) =>
      sortActivitiesForTimeline(merge(list || [], row ? normalizeActivity(row) : row)),
  };
}

// ---------------------------------------------------------------------------
// Gallery and customer exposure
// ---------------------------------------------------------------------------

export const isDocumentPhoto = (p) => photoTypeOf(p) === DOCUMENT_PHOTO_TYPE;

export function groupDocumentPages(photos) {
  const byCapture = new Map();
  for (const p of photos || []) {
    if (!isDocumentPhoto(p)) continue;
    const key = photoCaptureIdOf(p) || 'unknown';
    if (!byCapture.has(key)) byCapture.set(key, []);
    byCapture.get(key).push(p);
  }
  return [...byCapture.entries()].map(([documentCaptureId, pages]) => ({
    documentCaptureId,
    pages: pages.slice().sort((a, b) => (photoPageNumberOf(a) || 0) - (photoPageNumberOf(b) || 0)),
  }));
}

// THE GATE. Staff see document photos; every other audience — customer portal,
// print view, invoice — never does, regardless of any visibility flag.
export function photosForAudience(photos, audience) {
  const list = photos || [];
  if (audience === 'staff') return list.slice();
  return list.filter((p) => !isDocumentPhoto(p) && photoCustomerVisible(p));
}

// A public transcription is a public NOTE; its attachments stay staff-only.
export function attachmentsForAudience(activity, photosById, audience) {
  if (!activity || !Array.isArray(activity.attachments)) return [];
  if (audience !== 'staff') return [];
  return activity.attachments.map((id) => photosById.get(id)).filter(Boolean);
}

export function assertNoDocumentPhotos(photos, where) {
  const leaked = (photos || []).filter(isDocumentPhoto);
  if (leaked.length) {
    throw new Error(`${where || 'Customer view'}: ${leaked.length} staff-only document photo(s) would be exposed.`);
  }
  return true;
}

export const printablePhotos = (photos) => photosForAudience(photos, 'print');

export function photoCategories(existing) {
  const list = existing || [];
  return list.includes(DOCUMENT_PHOTO_CATEGORY) ? list.slice() : [...list, DOCUMENT_PHOTO_CATEGORY];
}
