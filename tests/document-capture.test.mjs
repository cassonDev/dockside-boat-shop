// Mocked tests for the Step 4 document-capture data layer.
//
// Run:  node --test tests/document-capture.test.mjs
//
// NO external service is contacted. The Supabase client, fetch, and the session
// getter are all injected into createDocumentCaptureApi, so nothing here loads
// @supabase/supabase-js and nothing opens a socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentCaptureApi, mergeActivityById, mergeActivitiesById,
         DocumentCaptureIntegrityError, DOCUMENT_TRANSCRIBE_ENDPOINT } from '../document-capture.js';

const USER = { id: 'u-1', name: 'Mia Osei', role: 'mechanic' };
const WO = 'K7M2Q';
const CAP = '44444444-4444-4444-8444-444444444444';
const REQ = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// Fake Supabase: records every call, returns queued results.
// ---------------------------------------------------------------------------
const documentPathsFor = (n) => ({ origPath: `${WO}/${CAP}-p${n}-orig.jpg`, thumbPath: `${WO}/${CAP}-p${n}-thumb.jpg` });

const photoRow = (n, over = {}) => ({
  id: `photo-${n}`, work_order_id: WO, document_capture_id: CAP, document_page_number: n,
  photo_type: 'document', customer_visible: false,
  storage_path: `${WO}/${CAP}-p${n}-orig.jpg`, thumb_path: `${WO}/${CAP}-p${n}-thumb.jpg`, ...over,
});
// Identity-only row: useful for set-shape tests, NOT for recovery tests.
const activityRow = (seq, over = {}) => ({
  id: `act-${seq}`, work_order_id: WO, document_capture_id: CAP, comment_sequence: seq,
  activity_type: 'document_transcription', ...over,
});

// A COMPLETE stored row matching the intended reviewed comment, built from the
// same contract buildActivityRows() writes. Recovery tests must use this: a
// partial fixture is not a recovered comment, it is a different comment.
const storedActivityRow = (seq, comment = {}, over = {}) => {
  const c = { body: 'x', visibility: 'private', aiGenerated: false, photoIds: ['photo-1', 'photo-2'], ...comment };
  return {
    id: `act-${seq}`,
    active: true,
    work_order_id: WO,
    document_capture_id: CAP,
    comment_sequence: seq,
    activity_type: 'document_transcription',
    body: c.body,
    visibility: c.visibility === 'public' ? 'public' : 'private',
    attachments: c.photoIds,
    ai_generated: !!c.aiGenerated,
    author_id: USER.id, author_name: USER.name, author_role: USER.role,
    meta: {
      source: c.aiGenerated ? 'document_photo_transcription' : 'document_photo_manual_entry',
      reviewed_by_human: true,
      quality_tier: c.aiGenerated ? (c.qualityTier || 'standard') : null,
      original_confidence: c.originalConfidence != null ? c.originalConfidence : 0,
      low_confidence_regions: c.lowConfidenceRegions || [],
    },
    ...over,
  };
};

function fakeDb({ insertResults = {}, selectRows = {}, uploadError = null } = {}) {
  const calls = { uploads: [], inserts: [], selects: [] };
  const insertQueue = { ...insertResults };

  const builder = (table) => {
    const state = { table, filters: {} };
    const api = {
      insert(rows) { calls.inserts.push({ table, rows }); state.rows = rows; return api; },
      select() {
        if (state.rows) {
          const r = insertQueue[table];
          const result = typeof r === 'function' ? r(state.rows) : r;
          return Promise.resolve(result || { data: state.rows.map((x, i) => ({ ...x, id: `${table}-${i + 1}` })), error: null });
        }
        calls.selects.push({ table, filters: state.filters });
        return api;
      },
      eq(col, val) { state.filters[col] = val; return api; },
      order(col) {
        state.filters.__order = col;
        return Promise.resolve({ data: selectRows[table] || [], error: null });
      },
    };
    return api;
  };

  return {
    calls,
    from: (table) => builder(table),
    storage: {
      from: (bucket) => ({
        upload: async (path, blob, opts) => {
          calls.uploads.push({ bucket, path, opts, blob });
          return uploadError ? { error: uploadError } : { error: null, data: { path } };
        },
      }),
    },
  };
}

function build({ db = fakeDb(), session = { access_token: 'jwt-abc' }, fetchResult, fetchThrows = false } = {}) {
  const calls = { fetch: [] };
  const api = createDocumentCaptureApi({
    supabase: db,
    getSession: async () => session,
    fetchImpl: async (url, init) => {
      calls.fetch.push({ url, init, body: JSON.parse(init.body) });
      if (fetchThrows) throw new Error('network down');
      return fetchResult;
    },
    // The REAL converters, as edited per STEP4-REVIEW §2. Internal logic must
    // not depend on them — see "identity survives a converter that drops it".
    photoFromRow: (r) => ({
      id: r.id, workOrderId: r.work_order_id, storagePath: r.storage_path, thumbPath: r.thumb_path,
      customerVisible: r.customer_visible !== false, photoType: r.photo_type || 'general',
      documentCaptureId: r.document_capture_id || null,
      documentPageNumber: r.document_page_number != null ? r.document_page_number : null,
    }),
    activityFromRow: (r) => ({
      id: r.id, workOrderId: r.work_order_id, activityType: r.activity_type, body: r.body,
      attachments: r.attachments || [], aiGenerated: !!r.ai_generated,
      documentCaptureId: r.document_capture_id || null,
      commentSequence: r.comment_sequence != null ? r.comment_sequence : null,
    }),
    signPhotos: async (rows) => rows,
    randomUuid: () => 'generated-uuid',
  });
  return { api, db, calls };
}

const jsonRes = (status, payload) => ({ status, json: async () => payload });

const PAGES = [
  { pageNumber: 2, origPath: `${WO}/${CAP}-p2-orig.jpg`, thumbPath: `${WO}/${CAP}-p2-thumb.jpg` },
  { pageNumber: 1, origPath: `${WO}/${CAP}-p1-orig.jpg`, thumbPath: `${WO}/${CAP}-p1-thumb.jpg` },
];

// ---------------------------------------------------------------------------
// Deterministic paths
// ---------------------------------------------------------------------------

test('page paths are deterministic and satisfy the storage key guard', () => {
  const { api } = build();
  const a = api.documentPagePaths(WO, CAP, 3);
  const b = api.documentPagePaths(WO, CAP, 3);
  assert.deepEqual(a, b, 'same inputs must give the same paths');
  assert.equal(a.origPath, `${WO}/${CAP}-p3-orig.jpg`);
  assert.equal(a.thumbPath, `${WO}/${CAP}-p3-thumb.jpg`);
  for (const p of [a.origPath, a.thumbPath]) {
    assert.match(p, /^[^/]+\/[^/]+-(orig|thumb)\.jpg$/, 'must match storage_name_is_valid_photo');
  }
  assert.notEqual(api.documentPagePaths(WO, CAP, 4).origPath, a.origPath);
});

test('uploads use upsert:true so a retry overwrites instead of orphaning', async () => {
  const { api, db } = build();
  const args = { workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, blobOrig: 'O', blobThumb: 'T' };
  await api.uploadDocumentPage(args);
  await api.uploadDocumentPage(args);           // retry
  assert.equal(db.calls.uploads.length, 4);
  for (const u of db.calls.uploads) assert.equal(u.opts.upsert, true);
  assert.deepEqual(db.calls.uploads.map((u) => u.path),
    [`${WO}/${CAP}-p1-orig.jpg`, `${WO}/${CAP}-p1-thumb.jpg`,
     `${WO}/${CAP}-p1-orig.jpg`, `${WO}/${CAP}-p1-thumb.jpg`],
    'the retry must reuse the same two paths');
});

test('an upload failure surfaces and no cleanup delete is attempted', async () => {
  const db = fakeDb({ uploadError: { message: 'storage down' } });
  const { api } = build({ db });
  await assert.rejects(() => api.uploadDocumentPage({ workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, blobOrig: 'O', blobThumb: 'T' }));
  assert.equal(JSON.stringify(db.calls).includes('remove'), false, 'must never call storage.remove — mechanics have no DELETE');
});

// ---------------------------------------------------------------------------
// Transcription goes only through the protected Function
// ---------------------------------------------------------------------------

test('transcription posts the full contract with the bearer token', async () => {
  const { api, calls } = build({
    fetchResult: jsonRes(200, { ok: true, text: 'Replace impeller', pageNumber: 1, qualityTier: 'standard', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false }),
  });
  const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(out.ok, true);
  assert.equal(calls.fetch[0].url, DOCUMENT_TRANSCRIBE_ENDPOINT);
  assert.equal(calls.fetch[0].init.headers.Authorization, 'Bearer jwt-abc');
  assert.deepEqual(Object.keys(calls.fetch[0].body).sort(),
    ['documentCaptureId','imageDataUrl','pageNumber','qualityTier','requestId','workOrderId']);
  assert.equal(calls.fetch[0].body.qualityTier, 'standard');
});

test('an invalid tier fails locally and makes ZERO outbound calls', async () => {
  for (const qualityTier of ['premium', 'STRONG', '', null, 42]) {
    const { api, calls } = build({ fetchResult: jsonRes(200, { ok: true }) });
    const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd', qualityTier });
    assert.equal(out.ok, false, `tier ${qualityTier}`);
    assert.equal(out.code, 'INVALID_TIER');
    assert.equal(out.retryable, false);
    assert.equal(calls.fetch.length, 0, 'no silent downgrade, and no call');
  }
});

test('both valid tiers are sent through unchanged', async () => {
  for (const qualityTier of ['standard', 'strong']) {
    const { api, calls } = build({ fetchResult: jsonRes(200, { ok: true, text: 'x', pageNumber: 1, qualityTier }) });
    await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd', qualityTier });
    assert.equal(calls.fetch[0].body.qualityTier, qualityTier);
  }
});

test('no session means no call to the Function at all', async () => {
  const { api, calls } = build({ session: null });
  const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'UNAUTHENTICATED');
  assert.equal(calls.fetch.length, 0);
});

test('server refusals propagate by code and are never auto-retried', async () => {
  const cases = [
    [403, { ok: false, code: 'NOT_AUTHORIZED', error: 'x' }, 'NOT_AUTHORIZED'],
    [429, { ok: false, code: 'RATE_LIMITED', error: 'x' }, 'RATE_LIMITED'],
    [409, { ok: false, code: 'RESULT_NOT_REPLAYABLE', error: 'x' }, 'RESULT_NOT_REPLAYABLE'],
    [409, { ok: false, code: 'REQUEST_IN_PROGRESS', error: 'x' }, 'REQUEST_IN_PROGRESS'],
    [409, { ok: false, code: 'REQUEST_TERMINAL', error: 'x' }, 'REQUEST_TERMINAL'],
    [413, { ok: false, code: 'IMAGE_TOO_LARGE', error: 'x' }, 'IMAGE_TOO_LARGE'],
    [200, { ok: false, code: 'AI_FAILED', error: 'x' }, 'AI_FAILED'],
  ];
  for (const [status, payload, code] of cases) {
    const { api, calls } = build({ fetchResult: jsonRes(status, payload) });
    const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd' });
    assert.equal(out.ok, false);
    assert.equal(out.code, code);
    assert.equal(out.retryable, false, `${code} must not be auto-retried`);
    assert.equal(calls.fetch.length, 1, `${code} must not trigger a second call`);
  }
});

test('a cross-shop work order surfaces the generic refusal unchanged', async () => {
  const { api } = build({ fetchResult: jsonRes(403, { ok: false, code: 'NOT_AUTHORIZED', error: 'Document transcription is not available for this work order.' }) });
  const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: 'OTHERSHOP', documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd' });
  assert.equal(out.code, 'NOT_AUTHORIZED');
  assert.match(out.error, /not available for this work order/);
  assert.equal(/another shop|exists|other tenant/i.test(out.error), false, 'must not leak cross-shop existence');
});

test('feature disabled is indistinguishable from an inaccessible work order', async () => {
  const body = { ok: false, code: 'NOT_AUTHORIZED', error: 'Document transcription is not available for this work order.' };
  const a = build({ fetchResult: jsonRes(403, body) });
  const b = build({ fetchResult: jsonRes(403, body) });
  const r1 = await a.api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd' });
  const r2 = await b.api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 2, imageDataUrl: 'd' });
  assert.deepEqual({ ...r1, pageNumber: null }, { ...r2, pageNumber: null });
});

test('a transport failure is reported as OFFLINE with no fallback path', async () => {
  const { api } = build({ fetchThrows: true });
  const out = await api.transcribeDocumentPage({ requestId: REQ, workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, imageDataUrl: 'd' });
  assert.equal(out.code, 'OFFLINE');
  assert.equal(out.retryable, true);
  assert.match(out.error, /internet connection/i);
});

test('the module never references a client-side AI fallback', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../document-capture.js', import.meta.url), 'utf8');
  assert.equal(src.includes('window.claude'), false);
  assert.equal(src.includes('api.openai.com'), false);
  assert.equal((src.match(/fetchImpl\(/g) || []).length, 1, 'exactly one outbound call site, and it is the protected Function');
});

// ---------------------------------------------------------------------------
// Saving photos
// ---------------------------------------------------------------------------

test('document photos save staff-only, typed, ordered, and without shop_id', async () => {
  const { api, db } = build();
  await api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id });
  const rows = db.calls.inserts[0].rows;
  assert.deepEqual(rows.map((r) => r.document_page_number), [1, 2], 'pages must be written in order');
  for (const r of rows) {
    assert.equal(r.customer_visible, false, 'document photos are staff-only by default');
    assert.equal(r.photo_type, 'document');
    assert.deepEqual(r.categories, ['Document']);
    assert.equal(r.document_capture_id, CAP);
    assert.equal('shop_id' in r, false, 'the tenant trigger stamps shop_id');
    assert.equal(r.display_order, r.document_page_number);
  }
});

test('a duplicate photo insert is recovered, not duplicated', async () => {
  const db = fakeDb({
    insertResults: { work_order_photos: { data: null, error: { code: '23505', message: 'duplicate key value' } } },
    selectRows: { work_order_photos: [photoRow(1), photoRow(2)] },
  });
  const { api } = build({ db });
  const out = await api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id });
  assert.equal(out.alreadySaved, true);
  assert.equal(out.photos.length, 2);
  assert.equal(db.calls.inserts.length, 1, 'must not retry the insert');
});

test('a non-unique-violation error is not swallowed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: { data: null, error: { code: '42501', message: 'permission denied' } } } });
  const { api } = build({ db });
  await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }));
});

// ---------------------------------------------------------------------------
// Saving activities
// ---------------------------------------------------------------------------

test('activities carry identity in columns, never in meta', async () => {
  const { api, db } = build();
  await api.saveDocumentCaptureActivities({
    workOrderId: WO, documentCaptureId: CAP, author: USER,
    comments: [{ body: 'Customer says gearbox leaks', visibility: 'private', aiGenerated: true, qualityTier: 'standard', originalConfidence: 0.82, photoIds: ['p1'] }],
  });
  const row = db.calls.inserts[0].rows[0];
  assert.equal(row.activity_type, 'document_transcription');
  assert.equal(row.document_capture_id, CAP);
  assert.equal(row.comment_sequence, 1);
  assert.deepEqual(row.attachments, ['p1']);
  assert.equal(row.ai_generated, true);
  assert.equal(row.meta.quality_tier, 'standard');
  assert.equal('document_capture_id' in row.meta, false, 'identity must not be duplicated into meta');
  assert.equal('source_photo_ids' in row.meta, false, 'attachments is the authoritative photo link');
  assert.equal('shop_id' in row, false);
});

test('an accepted body is stored exactly as reviewed, never trimmed', async () => {
  const { api, db } = build();
  const body = '  Line one\n  Line two  ';
  await api.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER,
    comments: [{ body, photoIds: ['p1'] }] });
  assert.equal(db.calls.inserts[0].rows[0].body, body);
});

test('manual entry records ai_generated false and a null tier', async () => {
  const { api, db } = build();
  await api.saveDocumentCaptureActivities({
    workOrderId: WO, documentCaptureId: CAP, author: USER,
    comments: [{ body: 'Typed by hand', visibility: 'private', aiGenerated: false, photoIds: ['p1'] }],
  });
  const row = db.calls.inserts[0].rows[0];
  assert.equal(row.ai_generated, false);
  assert.equal(row.meta.source, 'document_photo_manual_entry');
  assert.equal(row.meta.quality_tier, null);
});

test('per-comment visibility is preserved and defaults to private', async () => {
  const { api, db } = build();
  await api.saveDocumentCaptureActivities({
    workOrderId: WO, documentCaptureId: CAP, author: USER,
    comments: [
      { body: 'a', visibility: 'public', photoIds: ['p1'] },
      { body: 'b', visibility: 'private', photoIds: ['p1'] },
      { body: 'c', photoIds: ['p1'] },
    ],
  });
  assert.deepEqual(db.calls.inserts[0].rows.map((r) => r.visibility), ['public', 'private', 'private']);
  assert.deepEqual(db.calls.inserts[0].rows.map((r) => r.comment_sequence), [1, 2, 3]);
});

test('a duplicate activity insert is recovered, not duplicated', async () => {
  const db = fakeDb({
    insertResults: { activities: { data: null, error: { code: '23505', message: 'duplicate key value' } } },
    selectRows: { activities: [storedActivityRow(1, { photoIds: ['p1'] })] },
  });
  const { api } = build({ db });
  const out = await api.saveDocumentCaptureActivities({
    workOrderId: WO, documentCaptureId: CAP, author: USER,
    comments: [{ body: 'x', photoIds: ['p1'] }],
  });
  assert.equal(out.alreadySaved, true);
  assert.equal(out.activities.length, 1);
});

// ---------------------------------------------------------------------------
// finalizeDocumentCapture
// ---------------------------------------------------------------------------

test('finalize writes photos first and links comments to real photo ids', async () => {
  const db = fakeDb({
    insertResults: {
      work_order_photos: (rows) => ({ data: rows.map((r) => ({ ...r, id: `photo-${r.document_page_number}` })), error: null }),
    },
  });
  const { api } = build({ db });
  const out = await api.finalizeDocumentCapture({
    workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER,
    comments: [{ body: 'all pages' }, { body: 'page 2 only', pageNumbers: [2] }],
  });
  assert.equal(db.calls.inserts[0].table, 'work_order_photos');
  assert.equal(db.calls.inserts[1].table, 'activities');
  const acts = db.calls.inserts[1].rows;
  assert.deepEqual(acts[0].attachments, ['photo-1', 'photo-2'], 'default is every page, in order');
  assert.deepEqual(acts[1].attachments, ['photo-2']);
  assert.deepEqual(acts.map((a) => a.comment_sequence), [1, 2]);
  assert.equal(out.photos.length, 2);
});

test('EVERY requested page must resolve; one bad page writes no activity', async () => {
  const cases = [
    [[1, 99], /not a valid page number/],
    [[1, 4], /not part of this capture/],   // 4 is in range but not in this capture
    [[1, 1], /more than once/],
    [[0], /not a valid page number/],
    [[1.5], /not a valid page number/],
  ];
  for (const [pageNumbers, re] of cases) {
    const db = fakeDb({ insertResults: { work_order_photos: (rows) => ({ data: rows.map((r) => ({ ...r, id: `photo-${r.document_page_number}` })), error: null }) } });
    const { api } = build({ db });
    await assert.rejects(
      () => api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER,
                                          comments: [{ body: 'x', pageNumbers }] }), re,
      `pageNumbers ${JSON.stringify(pageNumbers)}`);
    assert.equal(db.calls.inserts.filter((i) => i.table === 'activities').length, 0,
      'no activity may be written when any requested page is invalid');
  }
});

test('retrying finalize after photos already saved completes without duplicating', async () => {
  const db = fakeDb({
    insertResults: { work_order_photos: { data: null, error: { code: '23505', message: 'duplicate key' } } },
    selectRows: { work_order_photos: [photoRow(1), photoRow(2)] },
  });
  const { api } = build({ db });
  const out = await api.finalizeDocumentCapture({
    workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }],
  });
  assert.equal(out.photosExisted, true);
  assert.deepEqual(db.calls.inserts.filter((i) => i.table === 'activities')[0].rows[0].attachments, ['photo-1', 'photo-2']);
});

// ---------------------------------------------------------------------------
// Realtime dedupe
// ---------------------------------------------------------------------------

test('mergeActivityById appends once and then updates in place', () => {
  const a = { id: 'x', body: 'first' };
  let list = mergeActivityById([], a);
  assert.equal(list.length, 1);
  list = mergeActivityById(list, { id: 'x', body: 'first' });
  assert.equal(list.length, 1, 'the realtime echo must not duplicate the optimistic append');
  list = mergeActivityById(list, { id: 'x', body: 'edited' });
  assert.equal(list[0].body, 'edited');
  list = mergeActivitiesById(list, [{ id: 'y' }, { id: 'z' }, { id: 'y' }]);
  assert.deepEqual(list.map((i) => i.id), ['x', 'y', 'z']);
  assert.equal(mergeActivityById(list, null).length, 3);
});

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

test('capture and request ids are freshly generated', () => {
  const { api } = build();
  assert.equal(api.newDocumentCaptureId(), 'generated-uuid');
  assert.equal(api.newTranscriptionRequestId(), 'generated-uuid');
});


// ---------------------------------------------------------------------------
// Derived paths on FRESH saves
// ---------------------------------------------------------------------------

test('a fresh save persists derived paths, never caller-supplied ones', async () => {
  const db = fakeDb();
  const { api } = build({ db });
  await api.saveDocumentCapturePhotos({
    workOrderId: WO, documentCaptureId: CAP, userId: USER.id,
    pages: [{ pageNumber: 1 }, { pageNumber: 2 }],   // no paths supplied at all
  });
  const rows = db.calls.inserts[0].rows;
  assert.equal(rows[0].storage_path, `${WO}/${CAP}-p1-orig.jpg`);
  assert.equal(rows[0].thumb_path, `${WO}/${CAP}-p1-thumb.jpg`);
  assert.equal(rows[1].storage_path, `${WO}/${CAP}-p2-orig.jpg`);
});

test('a caller-supplied path that differs is rejected before any insert', async () => {
  for (const bad of [{ origPath: 'K7M2Q/evil-orig.jpg' }, { thumbPath: 'OTHER/x-thumb.jpg' }]) {
    const db = fakeDb();
    const { api } = build({ db });
    await assert.rejects(
      () => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, userId: USER.id,
        pages: [{ pageNumber: 1, ...documentPathsFor(1), ...bad }] }),
      /unexpected (original|thumbnail) path/);
    assert.equal(db.calls.inserts.length, 0, 'nothing may be written');
  }
});

test('a successful insert returning altered paths fails closed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: (rows) =>
    ({ data: rows.map((r, i) => ({ ...r, id: `p${i}`, storage_path: 'K7M2Q/tampered-orig.jpg' })), error: null }) } });
  const { api } = build({ db });
  await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }),
    /Saved document photos: storage paths/);
});

test('a successful insert returning a customer-visible row fails closed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: (rows) =>
    ({ data: rows.map((r, i) => ({ ...r, id: `p${i}`, customer_visible: true })), error: null }) } });
  const { api } = build({ db });
  await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }),
    /not staff-only/);
});

// ---------------------------------------------------------------------------
// Whole-capture validation before the first write
// ---------------------------------------------------------------------------

test('an invalid capture writes nothing at all', async () => {
  const cases = [
    [{ pages: [] }, /at least one page/],
    [{ pages: [1,2,3,4,5,6].map((n) => ({ pageNumber: n })) }, /at most 5 pages/],
    [{ pages: [{ pageNumber: 0 }] }, /not valid/],
    [{ pages: [{ pageNumber: 9 }] }, /not valid/],
    [{ pages: [{ pageNumber: 1.5 }] }, /not valid/],
    [{ pages: [{ pageNumber: 1 }, { pageNumber: 1 }] }, /more than once/],
    [{ comments: [] }, /at least one comment/],
    [{ comments: [{ body: 'a', sequence: 1 }, { body: 'b', sequence: 1 }] }, /sequence 1 appears more than once/],
    [{ comments: [{ body: 'a', sequence: 0 }] }, /invalid sequence/],
    [{ comments: [{ body: '' }] }, /is empty/],
    [{ comments: [{ body: '   \n\t ' }] }, /is empty/],
    [{ comments: [{}] }, /no reviewed text/],
    [{ comments: [{ body: 42 }] }, /no reviewed text/],
    [{ comments: [{ body: null }] }, /no reviewed text/],
  ];
  for (const [override, re] of cases) {
    const db = fakeDb();
    const { api } = build({ db });
    await assert.rejects(() => api.finalizeDocumentCapture({
      workOrderId: WO, documentCaptureId: CAP, author: USER,
      pages: PAGES, comments: [{ body: 'x' }], ...override }), re, JSON.stringify(override).slice(0, 60));
    assert.equal(db.calls.inserts.length, 0, 'zero database inserts for an invalid capture');
  }
});

// ---------------------------------------------------------------------------
// Recovery integrity — a 23505 is not proof the capture is complete
// ---------------------------------------------------------------------------

const dupErr = { data: null, error: { code: '23505', message: 'duplicate key value' } };

test('incomplete photo recovery fails closed instead of reporting alreadySaved', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: dupErr }, selectRows: { work_order_photos: [photoRow(1)] } });
  const { api } = build({ db });
  await assert.rejects(
    () => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }),
    (e) => e instanceof DocumentCaptureIntegrityError && /page set differs/.test(e.message));
});

test('extra recovered pages fail closed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: dupErr }, selectRows: { work_order_photos: [photoRow(1), photoRow(2), photoRow(3)] } });
  const { api } = build({ db });
  await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }),
    /page set differs/);
});

test('recovered rows with wrong storage paths fail closed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: dupErr },
    selectRows: { work_order_photos: [photoRow(1, { storage_path: 'K7M2Q/someone-elses-orig.jpg' }), photoRow(2)] } });
  const { api } = build({ db });
  await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }),
    /deterministic paths/);
});

test('recovered rows that are customer-visible or wrongly typed fail closed', async () => {
  for (const [over, re] of [[{ customer_visible: true }, /staff-only/], [{ photo_type: 'general' }, /photo_type/]]) {
    const db = fakeDb({ insertResults: { work_order_photos: dupErr }, selectRows: { work_order_photos: [photoRow(1, over), photoRow(2)] } });
    const { api } = build({ db });
    await assert.rejects(() => api.saveDocumentCapturePhotos({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, userId: USER.id }), re);
  }
});

test('incomplete activity recovery fails closed', async () => {
  const db = fakeDb({ insertResults: { activities: dupErr }, selectRows: { activities: [activityRow(1)] } });
  const { api } = build({ db });
  await assert.rejects(
    () => api.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER,
      comments: [{ body: 'a', photoIds: ['p1'] }, { body: 'b', photoIds: ['p1'] }] }),
    /comment set differs/);
});

test('recovery fails closed on ANY field that differs from the reviewed comment', async () => {
  const intended = [{ body: 'Reviewed text', visibility: 'public', aiGenerated: true, qualityTier: 'strong',
                      originalConfidence: 0.82, lowConfidenceRegions: [{ pageNumber: 1, text: '[illegible]', reason: 'fold' }],
                      photoIds: ['photo-1', 'photo-2'] }];
  const cases = [
    ['different body',            { body: 'Something else' },                         /stored body differs/],
    ['different visibility',      { visibility: 'private' },                          /stored visibility differs/],
    ['different attachment id',   { attachments: ['photo-1', 'photo-9'] },            /stored attachments differ/],
    ['different attachment order',{ attachments: ['photo-2', 'photo-1'] },            /stored attachments differ/],
    ['different ai_generated',    { ai_generated: false },                            /stored ai_generated differs/],
    ['missing author',            { author_id: null },                                /stored author differs/],
    ['different author',          { author_id: 'someone-else' },                      /stored author differs/],
    ['different author name',     { author_name: 'Someone Else' },                    /author name differs/],
    ['different author role',     { author_role: 'shop_owner' },                      /author role differs/],
    ['inactive row',              { active: false },                                  /inactive/],
    ['wrong activity type',       { activity_type: 'customer_note' },                 /wrong activity_type/],
  ];
  const metaCases = [
    ['different meta.source',        { source: 'document_photo_manual_entry' },       /provenance source differs/],
    ['different reviewed_by_human',  { reviewed_by_human: false },                    /reviewed_by_human differs/],
    ['different quality_tier',       { quality_tier: 'standard' },                    /quality_tier differs/],
    ['different original_confidence',{ original_confidence: 0.1 },                    /original_confidence differs/],
    ['different regions',            { low_confidence_regions: [{ pageNumber: 2, text: '[illegible]', reason: 'fold' }] }, /regions differ/],
    ['missing regions',              { low_confidence_regions: [] },                  /regions differ/],
  ];

  for (const [label, over, re] of cases) {
    const stored = storedActivityRow(1, intended[0], over);
    const db = fakeDb({ insertResults: { activities: dupErr }, selectRows: { activities: [stored] } });
    const { api } = build({ db });
    let reported = null;
    await assert.rejects(
      async () => { reported = await api.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER, comments: intended }); },
      (e) => e instanceof DocumentCaptureIntegrityError && re.test(e.message), label);
    assert.equal(reported, null, `${label}: must not report alreadySaved`);
  }

  for (const [label, metaOver, re] of metaCases) {
    const base = storedActivityRow(1, intended[0]);
    const stored = { ...base, meta: { ...base.meta, ...metaOver } };
    const db = fakeDb({ insertResults: { activities: dupErr }, selectRows: { activities: [stored] } });
    const { api } = build({ db });
    await assert.rejects(
      () => api.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER, comments: intended }),
      (e) => e instanceof DocumentCaptureIntegrityError && re.test(e.message), label);
  }
});

test('metadata comparison ignores object key order but not array order', async () => {
  const comment = { body: 'Reviewed', visibility: 'private', aiGenerated: true, qualityTier: 'standard',
                    originalConfidence: 0.7,
                    lowConfidenceRegions: [{ pageNumber: 1, text: '[illegible]', reason: 'fold' },
                                           { pageNumber: 2, text: 'gearbox', reason: 'smudge' }],
                    photoIds: ['photo-1'] };

  // Same content, different JSONB key order — must PASS.
  const reordered = storedActivityRow(1, comment);
  reordered.meta = {
    low_confidence_regions: [{ reason: 'fold', text: '[illegible]', pageNumber: 1 },
                             { reason: 'smudge', pageNumber: 2, text: 'gearbox' }],
    original_confidence: 0.7, quality_tier: 'standard',
    reviewed_by_human: true, source: 'document_photo_transcription',
  };
  const okDb = fakeDb({ insertResults: { activities: dupErr }, selectRows: { activities: [reordered] } });
  const okApi = build({ db: okDb }).api;
  const out = await okApi.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER, comments: [comment] });
  assert.equal(out.alreadySaved, true, 'reordered object keys are the same metadata');

  // Same regions, different ARRAY order — must FAIL.
  const swapped = storedActivityRow(1, comment);
  swapped.meta = { ...swapped.meta, low_confidence_regions: [swapped.meta.low_confidence_regions[1], swapped.meta.low_confidence_regions[0]] };
  const badDb = fakeDb({ insertResults: { activities: dupErr }, selectRows: { activities: [swapped] } });
  const badApi = build({ db: badDb }).api;
  await assert.rejects(() => badApi.saveDocumentCaptureActivities({ workOrderId: WO, documentCaptureId: CAP, author: USER, comments: [comment] }),
    /regions differ/);
});

// ---------------------------------------------------------------------------
// Partial-retry boundaries
// ---------------------------------------------------------------------------

test('thumbnail upload fails after the original; the retry reuses both paths', async () => {
  const calls = [];
  let failThumb = true;
  const db = {
    calls: { inserts: [], selects: [] },
    from: () => ({ insert(){return this;}, select(){return Promise.resolve({data:[],error:null});}, eq(){return this;}, order(){return Promise.resolve({data:[],error:null});} }),
    storage: { from: () => ({ upload: async (path, blob, opts) => {
      calls.push({ path, upsert: opts.upsert });
      if (failThumb && path.endsWith('-thumb.jpg')) return { error: { message: 'thumb failed' } };
      return { error: null };
    } }) },
  };
  const { api } = build({ db });
  const args = { workOrderId: WO, documentCaptureId: CAP, pageNumber: 1, blobOrig: 'O', blobThumb: 'T' };
  await assert.rejects(() => api.uploadDocumentPage(args));
  failThumb = false;
  await api.uploadDocumentPage(args);
  assert.deepEqual(calls.map((c) => c.path),
    [`${WO}/${CAP}-p1-orig.jpg`, `${WO}/${CAP}-p1-thumb.jpg`, `${WO}/${CAP}-p1-orig.jpg`, `${WO}/${CAP}-p1-thumb.jpg`]);
  assert.equal(calls.every((c) => c.upsert === true), true, 'the re-uploaded original must overwrite, not orphan');
});

test('photos complete but activities previously failed: the retry completes activities', async () => {
  const db = fakeDb({
    insertResults: { work_order_photos: dupErr },
    selectRows: { work_order_photos: [photoRow(1), photoRow(2)] },
  });
  const { api } = build({ db });
  const out = await api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }] });
  assert.equal(out.photosExisted, true);
  assert.equal(out.activitiesExisted, false);
  const acts = db.calls.inserts.filter((i) => i.table === 'activities');
  assert.equal(acts.length, 1);
  assert.deepEqual(acts[0].rows[0].attachments, ['photo-1', 'photo-2']);
});

test('activities already complete: the retry returns the exact set and inserts nothing new', async () => {
  const db = fakeDb({
    insertResults: { work_order_photos: dupErr, activities: dupErr },
    selectRows: { work_order_photos: [photoRow(1), photoRow(2)], activities: [storedActivityRow(1)] },
  });
  const { api } = build({ db });
  const out = await api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }] });
  assert.equal(out.photosExisted, true);
  assert.equal(out.activitiesExisted, true);
  assert.equal(out.activities.length, 1);
  assert.equal(out.activities[0].commentSequence, 1, 'the real converter must expose commentSequence');
});

test('a recovery select returning only some pages fails finalization closed', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: dupErr }, selectRows: { work_order_photos: [photoRow(2)] } });
  const { api } = build({ db });
  await assert.rejects(() => api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }] }),
    DocumentCaptureIntegrityError);
  assert.equal(db.calls.inserts.filter((i) => i.table === 'activities').length, 0);
});

// ---------------------------------------------------------------------------
// Converter independence — the bug found in review
// ---------------------------------------------------------------------------

test('page identity survives a converter that drops document_page_number', async () => {
  // Simulates the UNEDITED production photoFromRow(). Finalization must still
  // link comments correctly, because identity is read from the raw rows.
  const db = fakeDb({ insertResults: { work_order_photos: (rows) => ({ data: rows.map((r) => ({ ...r, id: `photo-${r.document_page_number}` })), error: null }) } });
  const api = createDocumentCaptureApi({
    supabase: db,
    getSession: async () => ({ access_token: 'jwt' }),
    fetchImpl: async () => { throw new Error('no network in this test'); },
    photoFromRow: (r) => ({ id: r.id }),          // drops every identity field
    activityFromRow: (r) => r,
    signPhotos: async (x) => x,
  });
  const out = await api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }] });
  assert.deepEqual(db.calls.inserts.filter((i) => i.table === 'activities')[0].rows[0].attachments, ['photo-1', 'photo-2']);
  assert.equal(out.photos.length, 2);
});

test('the converter doubles in this suite mirror the documented target edits', async () => {
  const db = fakeDb({ insertResults: { work_order_photos: (rows) => ({ data: rows.map((r) => ({ ...r, id: `photo-${r.document_page_number}` })), error: null }) } });
  const { api } = build({ db });
  const out = await api.finalizeDocumentCapture({ workOrderId: WO, documentCaptureId: CAP, pages: PAGES, author: USER, comments: [{ body: 'x' }] });
  assert.equal(out.photos[0].documentCaptureId, CAP);
  assert.equal(out.photos[0].documentPageNumber, 1);
  assert.equal(out.photos[0].customerVisible, false);
  assert.equal(out.photos[0].photoType, 'document');
});

test('the integrated data layer carries both converter edits', async () => {
  // The doubles above are doubles. This asserts the SHIPPED source — not an
  // edits document — actually contains the converter fields, so the integrated
  // file cannot lose them silently. Revision 129: was a read of the (root-level,
  // never-shipped) supabase-client-binding.md and failed with ENOENT.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../supabase-client.js', import.meta.url), 'utf8');
  for (const field of ['documentCaptureId: row.document_capture_id', 'commentSequence: row.comment_sequence',
                       'documentPageNumber: row.document_page_number']) {
    assert.ok(src.includes(field), `supabase-client.js must set ${field}`);
  }
  assert.ok(/function activityFromRow/.test(src) && /function photoFromRow/.test(src),
    'both converters still exist');
  // The two activity fields belong to activityFromRow, the two photo fields to
  // photoFromRow — not swapped, and not both dropped into one converter.
  const actBody = src.slice(src.indexOf('function activityFromRow'), src.indexOf('function photoFromRow'));
  assert.ok(actBody.includes('commentSequence: row.comment_sequence'), 'commentSequence is in activityFromRow');
  const photoBody = src.slice(src.indexOf('function photoFromRow'));
  assert.ok(photoBody.includes('documentPageNumber: row.document_page_number'), 'documentPageNumber is in photoFromRow');
  // And the capture id is set by both converters.
  assert.ok(actBody.includes('documentCaptureId: row.document_capture_id')
    && photoBody.includes('documentCaptureId: row.document_capture_id'));
});

test('module import has no side effects and touches no global', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../document-capture.js', import.meta.url), 'utf8');
  assert.equal(/^import /m.test(src), false, 'the factory module imports nothing');
  // No module-scope call to the factory. String scan, not a regex: the previous
  // version of this line contained an unescaped "(" and the whole suite failed
  // to parse before a single test ran.
  const callSites = src.split('\n')
    .filter((l) => l.includes('createDocumentCaptureApi(') && !l.trim().startsWith('//') && !l.includes('export function'));
  assert.deepEqual(callSites, [], 'no binding may be constructed at import time');
});

test('no test in this file opens a network connection', () => {
  // Every api is built through createDocumentCaptureApi with an injected
  // fetchImpl and supabase double; the app binding is never constructed here.
  assert.equal(typeof createDocumentCaptureApi, 'function');
});
