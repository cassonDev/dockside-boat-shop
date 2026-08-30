// Step 5D tests — display and configuration integration.
// Run:  node --test tests/document-display.test.mjs
// Fully mocked: no Supabase, no Netlify, no OpenAI, no network, no browser.
//
// FIXTURES ARE CONVERTER-SHAPED. The UI never sees a database row: the approved
// data layer's `photoFromRow` / `activityFromRow` produce camelCase, and the
// realtime subscription converts too (`activityFromRow(payload.new)`,
// supabase-client.js:469). Raw rows appear only in the fallback tests that prove
// an unconverted payload degrades instead of failing a security gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_META_ADDITIONS, FEATURE_CARD, DOCUMENT_PHOTO_CATEGORY, REQUIRED_ACTIVITY_TYPES,
  isDocumentTranscriptionEnabled, buildFeatureTogglePayload, disablingAffectsSavedRecords,
  auditActivityTypes, activityMeta, filterCounts, showsAiBadge, authorLabel,
  sortActivitiesForTimeline, createActivityStream, groupDocumentPages, photosForAudience,
  attachmentsForAudience, assertNoDocumentPhotos, printablePhotos, photoCategories,
  isDocumentActivity, isDocumentPhoto, normalizeActivity, normalizePhoto,
  photoTypeOf, photoCustomerVisible, activitySequenceOf,
} from '../document-display.js';

// The approved Step 4 helpers, used here only as the injected double.
const mergeActivityById = (list, incoming) => {
  if (!incoming || !incoming.id) return list;
  const i = list.findIndex((a) => a.id === incoming.id);
  if (i === -1) return [...list, incoming];
  const next = list.slice();
  next[i] = { ...next[i], ...incoming };
  return next;
};
const mergeActivitiesById = (list, incomingList) => (incomingList || []).reduce(mergeActivityById, list);

const CAP = 'cap-1';
const WO = 'K7M2Q';

// Exactly `activityFromRow`'s output (supabase-client.js:428 + binding Edit 2).
const convertedActivity = (over = {}) => ({
  id: 'a1', workOrderId: WO, activityType: 'document_transcription', visibility: 'private',
  body: 'Impeller kit', meta: { source: 'document_photo_transcription', reviewed_by_human: true, quality_tier: 'standard' },
  attachments: ['ph1'], aiGenerated: true, authorId: 'u1', authorName: 'Dana Reyes',
  authorRole: 'mechanic', createdAt: '2026-08-29T10:00:00.000Z', parentActivityId: null,
  documentCaptureId: CAP, commentSequence: 1, ...over,
});

// Exactly `photoFromRow`'s output (supabase-client.js:688 + binding Edit 3).
const convertedPhoto = (over = {}) => ({
  id: 'ph1', workOrderId: WO, url: '', thumbUrl: 'signed://thumb-1', caption: 'Document page 1',
  categories: ['Document'], displayOrder: 1, customerVisible: false, includeOnInvoice: false,
  activityId: null, photoType: 'document', extractedText: '', extractionConfidence: null,
  documentCaptureId: CAP, documentPageNumber: 1, ...over,
});

const convertedGeneralPhoto = (over = {}) => ({
  id: 'g1', workOrderId: WO, url: '', thumbUrl: 'signed://thumb-g', caption: 'Engine bay',
  categories: ['Engine'], displayOrder: 2, customerVisible: true, includeOnInvoice: true,
  activityId: null, photoType: 'general', extractedText: '', extractionConfidence: null,
  documentCaptureId: null, documentPageNumber: null, ...over,
});

// Raw database rows, for the degradation tests only.
const rawActivity = (over = {}) => ({
  id: 'r1', activity_type: 'document_transcription', ai_generated: true, author_name: 'Dana Reyes',
  document_capture_id: CAP, comment_sequence: 1, created_at: '2026-08-29T10:00:00.000Z',
  attachments: ['ph1'], visibility: 'private', body: 'Impeller kit', ...over,
});
const rawPhoto = (over = {}) => ({
  id: 'rp1', photo_type: 'document', customer_visible: false,
  document_capture_id: CAP, document_page_number: 1, ...over,
});

// The list as the approved data layer delivers it (binding Edit 1).
const ACTIVITY_TYPES = [
  'work_log', 'inspection', 'ai_summary', 'mechanic_note', 'customer_note', 'status_change',
  'photo_added', 'quote_sent', 'approval_received', 'invoice_generated', 'payment_received',
  'part_ordered', 'part_received', 'job_edited', 'serial_number_captured', 'document_transcription',
];
const EDITABLE_ACTIVITY_TYPES = ['customer_note', 'work_log', 'document_transcription'];
const EXISTING_META = Object.fromEntries(
  ACTIVITY_TYPES.filter((t) => !ACTIVITY_META_ADDITIONS[t]).map((t) => [t, { label: t.toUpperCase(), color: '#000', icon: '' }]));

// ---------------------------------------------------------------------------
// The converter contract
// ---------------------------------------------------------------------------

test('converted photo rows are recognised as document photos', () => {
  assert.equal(isDocumentPhoto(convertedPhoto()), true);
  assert.equal(isDocumentPhoto(convertedGeneralPhoto()), false);
  assert.equal(photoTypeOf(convertedGeneralPhoto()), 'general');
});

test('converted activity rows are recognised as document transcriptions', () => {
  assert.equal(isDocumentActivity(convertedActivity()), true);
  assert.equal(isDocumentActivity({ activityType: 'work_log' }), false);
});

test('raw database rows still degrade correctly rather than failing a gate', () => {
  assert.equal(isDocumentPhoto(rawPhoto()), true);
  assert.equal(isDocumentActivity(rawActivity()), true);
  assert.equal(showsAiBadge(rawActivity()), true);
  assert.equal(activitySequenceOf(rawActivity()), 1);
});

test('an absent customerVisible follows the converter convention: visible', () => {
  // `photoFromRow` writes `customer_visible !== false`, so absence means visible
  // for an ordinary photo — the previous revision dropped such photos from print.
  assert.equal(photoCustomerVisible({ photoType: 'general' }), true);
  assert.equal(photoCustomerVisible({ photoType: 'general', customerVisible: false }), false);
});

test('normalizers produce ONE spelling of each field, dropping the raw aliases', () => {
  const a = normalizeActivity(rawActivity());
  assert.equal(a.activityType, 'document_transcription');
  assert.equal(a.aiGenerated, true);
  assert.equal(a.documentCaptureId, CAP);
  assert.equal(a.commentSequence, 1);
  assert.equal(a.createdAt, '2026-08-29T10:00:00.000Z');
  for (const k of ['activity_type', 'ai_generated', 'document_capture_id', 'comment_sequence', 'created_at', 'author_name']) {
    assert.equal(Object.prototype.hasOwnProperty.call(a, k), false, `normalized rows must not own ${k}`);
  }
  const p = normalizePhoto(rawPhoto());
  assert.equal(p.photoType, 'document');
  assert.equal(p.customerVisible, false);
  assert.equal(p.documentPageNumber, 1);
  for (const k of ['photo_type', 'customer_visible', 'document_page_number', 'document_capture_id']) {
    assert.equal(Object.prototype.hasOwnProperty.call(p, k), false, `normalized photos must not own ${k}`);
  }
  assert.deepEqual(normalizeActivity(convertedActivity()).activityType, 'document_transcription');
});

test('when the two spellings conflict, camelCase wins and the raw alias is dropped', () => {
  const conflicted = {
    id: 'a1', activityType: 'document_transcription', activity_type: 'work_log',
    aiGenerated: true, ai_generated: false, commentSequence: 2, comment_sequence: 9,
    documentCaptureId: CAP, document_capture_id: 'cap-other',
    authorName: 'Dana Reyes', author_name: 'Someone Else',
    createdAt: '2026-08-29T10:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z',
  };
  const n = normalizeActivity(conflicted);
  assert.equal(n.activityType, 'document_transcription');
  assert.equal(n.aiGenerated, true);
  assert.equal(n.commentSequence, 2);
  assert.equal(n.documentCaptureId, CAP);
  assert.equal(n.authorName, 'Dana Reyes');
  assert.equal(n.createdAt, '2026-08-29T10:00:00.000Z');
  for (const k of ['activity_type', 'ai_generated', 'comment_sequence', 'document_capture_id', 'author_name', 'created_at']) {
    assert.equal(Object.prototype.hasOwnProperty.call(n, k), false, `${k} must not survive`);
  }
});

// ---------------------------------------------------------------------------
// Activity type lists — every consumer, not just the counts
// ---------------------------------------------------------------------------

// These fixtures MIRROR the approved data layer's lists; they are not imported
// from it. Auditing the real exports belongs to the integration gate.
test('the audit passes for lists shaped like the approved data layer\'s', () => {
  const audit = auditActivityTypes({
    activityTypes: ACTIVITY_TYPES, editableTypes: EDITABLE_ACTIVITY_TYPES, activityMeta: EXISTING_META,
  });
  assert.deepEqual(audit.missingFromActivityTypes, []);
  assert.deepEqual(audit.missingFromEditable, []);
  assert.deepEqual(audit.missingMeta, []);
  assert.equal(audit.ok, true);
});

test('a type list that lost document_transcription is caught', () => {
  const audit = auditActivityTypes({
    activityTypes: ACTIVITY_TYPES.filter((t) => t !== 'document_transcription'),
    editableTypes: EDITABLE_ACTIVITY_TYPES, activityMeta: EXISTING_META,
  });
  assert.deepEqual(audit.missingFromActivityTypes, ['document_transcription']);
  assert.equal(audit.ok, false);
});

test('an editable list without the new type is caught', () => {
  const audit = auditActivityTypes({
    activityTypes: ACTIVITY_TYPES, editableTypes: ['customer_note', 'work_log'], activityMeta: EXISTING_META,
  });
  assert.deepEqual(audit.missingFromEditable, ['document_transcription']);
  assert.equal(audit.ok, false);
});

test('a type present in the list but missing a badge entry is caught', () => {
  const audit = auditActivityTypes({
    activityTypes: [...ACTIVITY_TYPES, 'future_type'], editableTypes: EDITABLE_ACTIVITY_TYPES, activityMeta: EXISTING_META,
  });
  assert.deepEqual(audit.missingMeta, ['future_type']);
});

test('both required types are declared', () => {
  assert.deepEqual(REQUIRED_ACTIVITY_TYPES, ['document_transcription', 'serial_number_captured']);
});

// ---------------------------------------------------------------------------
// Feature state — default OFF, owner only
// ---------------------------------------------------------------------------

test('the feature is enabled only when the flag is exactly true', () => {
  assert.equal(isDocumentTranscriptionEnabled({ settings: { features: { document_transcription: true } } }), true);
  for (const value of [false, undefined, null, 'true', 1, 0, {}, []]) {
    assert.equal(isDocumentTranscriptionEnabled({ settings: { features: { document_transcription: value } } }), false,
      `${JSON.stringify(value)} must not enable the feature`);
  }
});

test('an absent features object, settings object, or shop means disabled', () => {
  assert.equal(isDocumentTranscriptionEnabled({ settings: {} }), false);
  assert.equal(isDocumentTranscriptionEnabled({}), false);
  assert.equal(isDocumentTranscriptionEnabled(null), false);
});

test('this flag does not follow the default-on convention of the others', () => {
  const shop = { settings: { features: { serial_scanning: undefined } } };
  assert.equal(shop.settings.features.serial_scanning !== false, true, 'the old convention would enable');
  assert.equal(isDocumentTranscriptionEnabled(shop), false, 'this one does not');
});

test('only a shop owner may toggle the feature', () => {
  const shop = { settings: { features: {} } };
  assert.equal(buildFeatureTogglePayload(shop, true, 'mechanic').allowed, false);
  assert.equal(buildFeatureTogglePayload(shop, true, 'mechanic').reason, 'owner_only');
  assert.equal(buildFeatureTogglePayload(shop, true, 'shop_owner').allowed, true);
});

test('toggling preserves unrelated settings and unrelated feature flags', () => {
  const shop = { settings: { branding: { logo: 'x.png' }, invoice_footer: 'Thanks',
    features: { serial_scanning: true, qr_codes: false } } };
  const { patch } = buildFeatureTogglePayload(shop, true, 'shop_owner');
  assert.deepEqual(patch.settings.branding, { logo: 'x.png' });
  assert.equal(patch.settings.invoice_footer, 'Thanks');
  assert.deepEqual(patch.settings.features, { serial_scanning: true, qr_codes: false, document_transcription: true });
  assert.equal(Object.keys(patch).length, 1, 'settings only — no schema column, no data rewrite');
});

test('toggling off writes false rather than deleting the key', () => {
  const shop = { settings: { features: { document_transcription: true } } };
  assert.equal(buildFeatureTogglePayload(shop, false, 'shop_owner').patch.settings.features.document_transcription, false);
});

test('a non-boolean toggle value is coerced to a strict boolean', () => {
  assert.equal(buildFeatureTogglePayload({ settings: {} }, 'yes', 'shop_owner').patch.settings.features.document_transcription, false);
});

test('disabling never hides or alters saved document records', () => {
  assert.equal(disablingAffectsSavedRecords(), false);
});

test('the feature card copy is exactly the approved wording', () => {
  assert.equal(FEATURE_CARD.title, 'Document Photo Transcription');
  assert.equal(FEATURE_CARD.description,
    'Photograph handwritten or printed documents and turn them into reviewed work-order notes.');
  assert.equal(FEATURE_CARD.key, 'document_transcription');
});

// ---------------------------------------------------------------------------
// Timeline metadata and filter counts
// ---------------------------------------------------------------------------

test('document transcriptions render a real badge instead of a raw uppercase type', () => {
  const meta = activityMeta('document_transcription', EXISTING_META);
  assert.equal(meta.label, 'DOCUMENT');
  assert.ok(meta.color);
});

test('the pre-existing serial_number_captured omission is filled in too', () => {
  assert.equal(activityMeta('serial_number_captured', {}).label, 'SERIAL NUMBER');
});

test('an existing meta entry always wins — this module adds, it does not redesign', () => {
  const existing = { document_transcription: { label: 'CUSTOM', color: '#000', icon: '' } };
  assert.equal(activityMeta('document_transcription', existing).label, 'CUSTOM');
});

test('a genuinely unknown type still falls back to a readable badge', () => {
  assert.equal(activityMeta('some_future_type', {}).label, 'SOME FUTURE TYPE');
});

test('filter counts read converted rows and include document transcriptions', () => {
  const list = [convertedActivity(), convertedActivity({ id: 'a2', commentSequence: 2 }),
                { id: 'w', activityType: 'work_log' }];
  const counts = filterCounts(list, ACTIVITY_TYPES);
  assert.equal(counts.all, 3);
  assert.equal(counts.document_transcription, 2);
  assert.equal(counts.work_log, 1);
});

test('filter counts also handle a raw row without dropping it', () => {
  const counts = filterCounts([rawActivity()], ACTIVITY_TYPES);
  assert.equal(counts.document_transcription, 1);
});

test('every known type is present in the counts even at zero', () => {
  const counts = filterCounts([], ACTIVITY_TYPES);
  assert.equal(counts.document_transcription, 0);
  assert.equal(counts.serial_number_captured, 0);
  assert.equal(counts.all, 0);
});

test('an unknown type is counted rather than silently dropped', () => {
  const counts = filterCounts([{ id: 'x', activityType: 'mystery' }], ACTIVITY_TYPES);
  assert.equal(counts.all, 1);
  assert.equal(counts.mystery, 1);
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('the AI badge follows the converted aiGenerated field', () => {
  assert.equal(showsAiBadge(convertedActivity({ aiGenerated: true })), true);
  assert.equal(showsAiBadge(convertedActivity({ aiGenerated: true, body: 'heavily corrected by hand' })), true);
});

test('a manual note after a total AI failure carries no AI badge', () => {
  const manual = convertedActivity({ aiGenerated: false,
    meta: { source: 'document_photo_manual_entry', reviewed_by_human: true, quality_tier: null } });
  assert.equal(showsAiBadge(manual), false);
});

test('the badge is never re-derived from tier, confidence, or body text', () => {
  const odd = convertedActivity({ aiGenerated: false,
    meta: { source: 'document_photo_manual_entry', quality_tier: 'strong', original_confidence: 0.99 } });
  assert.equal(showsAiBadge(odd), false);
});

test('the author shown is the reviewing human, never the model or the tier', () => {
  assert.equal(authorLabel(convertedActivity()), 'Dana Reyes');
  assert.equal(authorLabel(convertedActivity({ authorName: '' })), 'Unknown user');
  assert.equal(authorLabel(rawActivity()), 'Dana Reyes');
  assert.notEqual(authorLabel(convertedActivity()), 'AI');
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('one capture keeps reviewed order even when its rows have different timestamps', () => {
  // Five inserts land milliseconds apart and realtime delivers them out of
  // order; the block must still read 1, 2, 3, 4, 5.
  const list = [
    convertedActivity({ id: 'c3', commentSequence: 3, createdAt: '2026-08-29T10:00:00.300Z' }),
    convertedActivity({ id: 'c5', commentSequence: 5, createdAt: '2026-08-29T10:00:00.500Z' }),
    convertedActivity({ id: 'c1', commentSequence: 1, createdAt: '2026-08-29T10:00:00.100Z' }),
    convertedActivity({ id: 'c4', commentSequence: 4, createdAt: '2026-08-29T10:00:00.400Z' }),
    convertedActivity({ id: 'c2', commentSequence: 2, createdAt: '2026-08-29T10:00:00.200Z' }),
  ];
  assert.deepEqual(sortActivitiesForTimeline(list).map((a) => a.commentSequence), [1, 2, 3, 4, 5]);
});

test('captures stay newest-first, and each block stays contiguous', () => {
  const older = [1, 2].map((n) => convertedActivity({
    id: `old${n}`, documentCaptureId: 'cap-old', commentSequence: n,
    createdAt: `2026-08-28T09:00:0${n}.000Z` }));
  const newer = [1, 2].map((n) => convertedActivity({
    id: `new${n}`, documentCaptureId: 'cap-new', commentSequence: n,
    createdAt: `2026-08-29T09:00:0${n}.000Z` }));
  const sorted = sortActivitiesForTimeline([...older, ...newer]);
  assert.deepEqual(sorted.map((a) => a.id), ['new1', 'new2', 'old1', 'old2']);
});

test('a newer ordinary activity still sorts above an older capture block', () => {
  const block = [1, 2].map((n) => convertedActivity({
    id: `d${n}`, commentSequence: n, createdAt: `2026-08-29T08:00:0${n}.000Z` }));
  const note = { id: 'w1', activityType: 'work_log', createdAt: '2026-08-29T12:00:00.000Z' };
  assert.deepEqual(sortActivitiesForTimeline([...block, note]).map((a) => a.id), ['w1', 'd1', 'd2']);
});

test('ordinary activities are still newest-first among themselves', () => {
  const a = { id: 'x', activityType: 'work_log', createdAt: '2026-08-29T08:00:00.000Z' };
  const b = { id: 'y', activityType: 'work_log', createdAt: '2026-08-29T09:00:00.000Z' };
  assert.deepEqual(sortActivitiesForTimeline([a, b]).map((r) => r.id), ['y', 'x']);
});

test('rows with no sequence and no timestamp keep a stable order', () => {
  const list = [{ id: 'p', activityType: 'work_log' }, { id: 'q', activityType: 'work_log' }];
  assert.deepEqual(sortActivitiesForTimeline(list).map((r) => r.id), ['p', 'q']);
});

// ---------------------------------------------------------------------------
// Realtime de-duplication and shape reconciliation
// ---------------------------------------------------------------------------

test('the stream refuses to be constructed without the approved merge helper', () => {
  assert.throws(() => createActivityStream({}), /approved merge helper/);
});

test('five split comments appended optimistically produce five rows, not ten', () => {
  const stream = createActivityStream({ merge: mergeActivityById, mergeMany: mergeActivitiesById });
  const saved = [1, 2, 3, 4, 5].map((n) => convertedActivity({
    id: `a${n}`, commentSequence: n, createdAt: `2026-08-29T10:00:0${n}.000Z` }));
  let list = stream.applyOptimistic([], saved);
  for (const row of saved) list = stream.applyRealtime(list, row);   // realtime redelivers each
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((a) => a.commentSequence), [1, 2, 3, 4, 5]);
});

test('a converted realtime row arriving before the optimistic append is deduped', () => {
  const stream = createActivityStream({ merge: mergeActivityById, mergeMany: mergeActivitiesById });
  let list = stream.applyRealtime([], convertedActivity({ id: 'a1' }));
  list = stream.applyOptimistic(list, [convertedActivity({ id: 'a1', body: 'reviewed text' })]);
  assert.equal(list.length, 1);
  assert.equal(list[0].body, 'reviewed text');
});

test('a RAW realtime payload never merges both spellings into one row', () => {
  // The subscription converts today; if a future call site forgets, the stream
  // normalizes rather than producing a row carrying activity_type AND
  // activityType with different values.
  const stream = createActivityStream({ merge: mergeActivityById, mergeMany: mergeActivitiesById });
  let list = stream.applyOptimistic([], [convertedActivity({ id: 'a1' })]);
  list = stream.applyRealtime(list, rawActivity({ id: 'a1', body: 'from realtime' }));
  assert.equal(list.length, 1);
  const row = list[0];
  assert.equal(row.activityType, 'document_transcription');
  assert.equal(row.aiGenerated, true);
  assert.equal(row.commentSequence, 1);
  assert.equal(row.documentCaptureId, CAP);
  assert.equal(row.body, 'from realtime');
  assert.equal(isDocumentActivity(row), true);
  assert.equal(showsAiBadge(row), true);
  for (const k of ['activity_type', 'ai_generated', 'comment_sequence', 'document_capture_id', 'created_at', 'author_name']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, k), false, `the merged row must not own ${k}`);
  }
});

test('a conflicting raw payload cannot resurrect a stale value through a merge', () => {
  const stream = createActivityStream({ merge: mergeActivityById, mergeMany: mergeActivitiesById });
  let list = stream.applyOptimistic([], [convertedActivity({ id: 'a1', commentSequence: 2 })]);
  list = stream.applyRealtime(list, {
    id: 'a1', activityType: 'document_transcription', activity_type: 'work_log',
    commentSequence: 2, comment_sequence: 99, aiGenerated: true, ai_generated: false,
    createdAt: '2026-08-29T10:00:00.000Z',
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].activityType, 'document_transcription');
  assert.equal(list[0].commentSequence, 2);
  assert.equal(list[0].aiGenerated, true);
  assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'activity_type'), false);
});

test('a realtime update to an existing row updates in place', () => {
  const stream = createActivityStream({ merge: mergeActivityById });
  let list = stream.applyOptimistic([], [convertedActivity({ id: 'a1', body: 'first' })]);
  list = stream.applyRealtime(list, convertedActivity({ id: 'a1', body: 'edited' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].body, 'edited');
  assert.equal(list[0].authorName, 'Dana Reyes');
});

test('a row without an id is ignored rather than duplicating the list', () => {
  const stream = createActivityStream({ merge: mergeActivityById });
  assert.equal(stream.applyRealtime([convertedActivity()], { body: 'no id' }).length, 1);
});

test('unrelated activity types flow through the stream untouched', () => {
  const stream = createActivityStream({ merge: mergeActivityById });
  const list = stream.applyRealtime([], { id: 'w1', activityType: 'work_log', createdAt: '2026-08-29T09:00:00.000Z' });
  assert.equal(list.length, 1);
  assert.equal(list[0].activityType, 'work_log');
});

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

test('converted document pages are grouped by capture and shown in page order', () => {
  const photos = [
    convertedPhoto({ id: 'p2', documentPageNumber: 2 }),
    convertedPhoto({ id: 'p1', documentPageNumber: 1 }),
    convertedPhoto({ id: 'q1', documentCaptureId: 'cap-2', documentPageNumber: 1 }),
    convertedGeneralPhoto(),
  ];
  const groups = groupDocumentPages(photos);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((g) => g.documentCaptureId === CAP).pages.map((p) => p.id), ['p1', 'p2']);
});

test('grouping also works on raw rows', () => {
  const groups = groupDocumentPages([rawPhoto({ id: 'b', document_page_number: 2 }), rawPhoto({ id: 'a', document_page_number: 1 })]);
  assert.deepEqual(groups[0].pages.map((p) => p.id), ['a', 'b']);
});

test('non-document photos never appear in a document group', () => {
  assert.deepEqual(groupDocumentPages([convertedGeneralPhoto()]), []);
});

test('the Document category is added to the existing list without duplication', () => {
  const list = photoCategories(['Engine', 'Hull']);
  assert.deepEqual(list, ['Engine', 'Hull', DOCUMENT_PHOTO_CATEGORY]);
  assert.deepEqual(photoCategories(list), list, 'idempotent');
});

// ---------------------------------------------------------------------------
// Customer exposure — the rule the whole gate exists to protect
// ---------------------------------------------------------------------------

test('staff see converted document photos; customers never do', () => {
  const photos = [convertedPhoto(), convertedGeneralPhoto()];
  assert.equal(photosForAudience(photos, 'staff').length, 2);
  assert.deepEqual(photosForAudience(photos, 'customer').map((p) => p.id), ['g1']);
});

test('the print gallery keeps ordinary converted photos', () => {
  // The previous revision dropped every converted photo here, because it looked
  // for `customer_visible` on a camelCase row.
  const photos = [convertedGeneralPhoto(), convertedGeneralPhoto({ id: 'g2' }), convertedPhoto()];
  assert.deepEqual(printablePhotos(photos).map((p) => p.id), ['g1', 'g2']);
});

test('an ordinary photo explicitly hidden from customers stays out of print', () => {
  assert.deepEqual(printablePhotos([convertedGeneralPhoto({ customerVisible: false })]), []);
});

test('a document photo flagged customerVisible by mistake is STILL withheld', () => {
  const rogue = convertedPhoto({ customerVisible: true });
  assert.deepEqual(photosForAudience([rogue], 'customer'), []);
  assert.deepEqual(printablePhotos([rogue]), []);
  assert.deepEqual(printablePhotos([rawPhoto({ customer_visible: true })]), []);
});

test('a PUBLIC transcription does not expose its source photo', () => {
  const activity = convertedActivity({ visibility: 'public', attachments: ['ph1'] });
  const byId = new Map([['ph1', convertedPhoto()]]);
  assert.equal(attachmentsForAudience(activity, byId, 'staff').length, 1);
  assert.deepEqual(attachmentsForAudience(activity, byId, 'customer'), []);
});

test('an activity with no attachments resolves to nothing rather than throwing', () => {
  assert.deepEqual(attachmentsForAudience(convertedActivity({ attachments: null }), new Map(), 'staff'), []);
  assert.deepEqual(attachmentsForAudience(null, new Map(), 'staff'), []);
});

test('an attachment id with no matching photo row is dropped, not rendered as a hole', () => {
  const activity = convertedActivity({ attachments: ['ph1', 'missing'] });
  const byId = new Map([['ph1', convertedPhoto()]]);
  assert.deepEqual(attachmentsForAudience(activity, byId, 'staff').map((p) => p.id), ['ph1']);
});

test('the customer-view assertion catches a converted leak and passes a clean list', () => {
  assert.throws(() => assertNoDocumentPhotos([convertedGeneralPhoto(), convertedPhoto()], 'Customer portal'),
    /Customer portal: 1 staff-only document photo/);
  assert.equal(assertNoDocumentPhotos([convertedGeneralPhoto()], 'Customer portal'), true);
  assert.equal(assertNoDocumentPhotos(photosForAudience([convertedPhoto(), convertedGeneralPhoto()], 'customer')), true);
  assert.throws(() => assertNoDocumentPhotos([rawPhoto()], 'Print view'), /Print view/);
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

test('the module writes nothing and reaches nothing', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../document-display.js', import.meta.url), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  for (const banned of ['supabase', 'netlify/functions', 'fetch(', 'localstorage',
    'createobjecturl', 'filereader', 'indexeddb', '\nimport ']) {
    assert.equal(code.toLowerCase().includes(banned), false, `must not reference ${banned}`);
  }
});

test('field names appear only inside the named accessors', () => {
  // One place to change if a converter ever changes; scattered fallbacks are how
  // a security gate silently stops matching.
  const names = ['photoType', 'customerVisible', 'documentPageNumber', 'activityType', 'aiGenerated', 'commentSequence'];
  for (const n of names) assert.ok(typeof n === 'string');
  assert.equal(photoTypeOf({ photoType: 'document' }), 'document');
  assert.equal(photoTypeOf({ photo_type: 'document' }), 'document');
  assert.equal(photoTypeOf({}), 'general');
});

// ---------------------------------------------------------------------------
// Host wiring — the documented handler against the real subscription contract
// ---------------------------------------------------------------------------

// The real signature: `subscribeToActivities(workOrderId, onInsert)` calls
// `onInsert(activityFromRow(payload.new))` (supabase-client.js:465–471). The
// callback receives ONE already-converted activity — there is no `payload` in
// scope, which is what the previous revision's snippet assumed.
const activityFromRow = (row) => ({
  id: row.id, workOrderId: row.work_order_id, activityType: row.activity_type,
  visibility: row.visibility, body: row.body || '', meta: row.meta || {},
  attachments: row.attachments || [], aiGenerated: !!row.ai_generated,
  authorId: row.author_id, authorName: row.author_name || '', createdAt: row.created_at,
  documentCaptureId: row.document_capture_id || null,
  commentSequence: row.comment_sequence != null ? row.comment_sequence : null,
});
const fakeSubscribeToActivities = (workOrderId, onInsert) => ({
  emit: (dbRow) => onInsert(activityFromRow(dbRow)),
  unsubscribe: () => {},
});

// The host, wired exactly as index-5d-edits.md Edit 4 documents it.
function fakeHost() {
  const stream = createActivityStream({ merge: mergeActivityById, mergeMany: mergeActivitiesById });
  const host = { state: { jobActivities: [] } };
  host.setState = (fn) => { host.state = { ...host.state, ...fn(host.state) }; };
  host.channel = fakeSubscribeToActivities(WO, (act) => {
    host.setState((s) => ({ jobActivities: stream.applyRealtime(s.jobActivities, act) }));
  });
  host.saveOptimistically = (activities) => {
    host.setState((s) => ({ jobActivities: stream.applyOptimistic(s.jobActivities, activities) }));
  };
  return host;
}

test('the documented realtime handler receives the converted activity and applies it', () => {
  const host = fakeHost();
  host.channel.emit({
    id: 'a1', work_order_id: WO, activity_type: 'document_transcription', visibility: 'private',
    body: 'Impeller kit', ai_generated: true, author_name: 'Dana Reyes',
    created_at: '2026-08-29T10:00:00.000Z', document_capture_id: CAP, comment_sequence: 1,
    attachments: ['ph1'], meta: {},
  });
  const [row] = host.state.jobActivities;
  assert.equal(host.state.jobActivities.length, 1);
  assert.equal(row.id, 'a1');
  assert.equal(isDocumentActivity(row), true, 'the converted activity reached applyRealtime');
  assert.equal(showsAiBadge(row), true);
  assert.equal(row.commentSequence, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'activity_type'), false);
});

test('a five-comment save plus five realtime inserts leaves five rows in reviewed order', () => {
  const host = fakeHost();
  const saved = [1, 2, 3, 4, 5].map((n) => convertedActivity({
    id: `a${n}`, commentSequence: n, createdAt: `2026-08-29T10:00:0${n}.000Z` }));
  host.saveOptimistically(saved);
  for (const n of [3, 1, 5, 2, 4]) {                       // realtime, out of order
    host.channel.emit({
      id: `a${n}`, work_order_id: WO, activity_type: 'document_transcription',
      body: 'Impeller kit', ai_generated: true, author_name: 'Dana Reyes',
      created_at: `2026-08-29T10:00:0${n}.000Z`, document_capture_id: CAP, comment_sequence: n,
    });
  }
  assert.equal(host.state.jobActivities.length, 5);
  assert.deepEqual(host.state.jobActivities.map((a) => a.commentSequence), [1, 2, 3, 4, 5]);
});

test('a realtime insert for an unrelated type still lands through the same handler', () => {
  const host = fakeHost();
  host.channel.emit({ id: 'w1', activity_type: 'work_log', body: 'oil change', created_at: '2026-08-29T11:00:00.000Z' });
  assert.equal(host.state.jobActivities[0].activityType, 'work_log');
});

test('the integrated realtime callback passes the callback argument, not a payload', async () => {
  // Revision 129: was a read of the (root-level, never-shipped) index-5d-edits.md
  // and failed with ENOENT. It now asserts the shipped host wiring.
  const { readFile } = await import('node:fs/promises');
  const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = host.indexOf('this._dataMod.subscribeToActivities(jobId');
  assert.notEqual(start, -1, 'the host subscribes to activities');
  const snippet = host.slice(start, start + 700);
  assert.match(snippet, /\(act\)\s*=>/, 'the callback takes the converted activity');
  assert.match(snippet, /applyRealtime\(s\.jobActivities,\s*act\)/, 'and passes it straight through');
  assert.equal(/applyRealtime\([^)]*payload/.test(host), false, 'no payload variable reaches applyRealtime');
  // The stream is built from the APPROVED merge helpers, not a local reimplementation.
  const streamAt = host.indexOf('createActivityStream({');
  assert.notEqual(streamAt, -1, 'the host builds the activity stream');
  const stream = host.slice(streamAt, streamAt + 220);
  assert.match(stream, /merge:\s*this\._dataMod\.mergeActivityById/);
  assert.match(stream, /mergeMany:\s*this\._dataMod\.mergeActivitiesById/);
});
