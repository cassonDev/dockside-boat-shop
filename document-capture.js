// ===========================================================================
// document-capture.js — Step 4 data layer for Document Photo Transcription.
//
//   A PURE FACTORY MODULE: imports nothing, references no global, no
//   module-scope side effects, so `node --test` can import it directly. The app
//   binding lives in supabase-client.js (supabase-client-binding.md §Edit 4).
//
//   INTEGRITY POSTURE
//   * Storage paths are DERIVED, never accepted from the caller. A page cannot
//     claim document-capture identity while pointing at arbitrary objects.
//   * The whole capture is validated BEFORE the first database write.
//   * Identity is read from RAW ROWS, never from a converted object, so a
//     converter that omits a field cannot break finalization.
//   * Rows are verified against what was intended — on a successful insert AND
//     on 23505 recovery. A 23505 proves a collision, not that the stored capture
//     is the one being saved.
//   * Document photos always save customer_visible:false; shop_id is never sent
//     (the tenant trigger stamps it); identity never duplicated into meta.
//   * Transcription is reachable only through the protected Netlify Function.
//     No fallback. An invalid tier fails locally rather than downgrading.
// ===========================================================================

export const DOCUMENT_TRANSCRIBE_ENDPOINT = '/.netlify/functions/transcribe-document';
export const DOCUMENT_PHOTO_TYPE = 'document';
export const DOCUMENT_PHOTO_CATEGORY = 'Document';
export const DOCUMENT_MAX_PAGES = 5;
export const DOCUMENT_QUALITY_TIERS = ['standard', 'strong'];

export class DocumentCaptureIntegrityError extends Error {
  constructor(message, details) { super(message); this.name = 'DocumentCaptureIntegrityError'; this.details = details || {}; }
}

const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// Key-order-insensitive for objects, order-SENSITIVE for arrays. JSONB does not
// preserve object key order, so key order is not an integrity signal — but the
// order of low-confidence regions is meaningful and must be preserved.
function sameJson(a, b) {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    return x.every((v, i) => sameJson(v, y[i]));
  }
  if (typeof x === 'object' && typeof y === 'object') {
    const kx = Object.keys(x).sort();
    const ky = Object.keys(y).sort();
    if (kx.length !== ky.length || kx.some((k, i) => k !== ky[i])) return false;
    return kx.every((k) => sameJson(x[k], y[k]));
  }
  return false;
}

export function createDocumentCaptureApi(deps) {
  const {
    supabase: db, fetchImpl, getSession: getSessionFn,
    photoBucket = 'work-order-photos',
    signPhotos: signPhotosFn = async (rows) => rows,
    photoFromRow: photoFromRowFn = (r) => r,
    activityFromRow: activityFromRowFn = (r) => r,
    randomUuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
  } = deps || {};

  const newDocumentCaptureId = () => randomUuid();
  const newTranscriptionRequestId = () => randomUuid();
  const fail = (why, details) => { throw new DocumentCaptureIntegrityError(why, details); };

  // Satisfies the storage key guard: ^[^/]+/[^/]+-(orig|thumb)\.jpg$
  function documentPagePaths(workOrderId, documentCaptureId, pageNumber) {
    const base = `${workOrderId}/${documentCaptureId}-p${pageNumber}`;
    return { origPath: `${base}-orig.jpg`, thumbPath: `${base}-thumb.jpg` };
  }

  // ---- transcription -------------------------------------------------------

  async function transcribeDocumentPage({ requestId, workOrderId, documentCaptureId, pageNumber, imageDataUrl, qualityTier = 'standard' }) {
    // An unrecognised tier is a client bug. Downgrading silently would make the
    // response claim a reading that never happened and misattribute cost.
    if (!DOCUMENT_QUALITY_TIERS.includes(qualityTier)) {
      return { ok: false, code: 'INVALID_TIER', status: 0, retryable: false, error: `Unknown reading quality "${qualityTier}".` };
    }
    const session = await getSessionFn();
    const token = session && session.access_token;
    if (!token) return { ok: false, code: 'UNAUTHENTICATED', status: 401, retryable: false, error: 'You are signed out. Sign in again to read this page.' };

    let res;
    try {
      res = await fetchImpl(DOCUMENT_TRANSCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId, workOrderId, documentCaptureId, pageNumber, imageDataUrl, qualityTier }),
      });
    } catch (e) {
      // No offline queue and deliberately no client-side AI fallback: anything
      // bypassing the Function bypasses auth, the feature flag, the rate limits,
      // and the usage reservation at once.
      return { ok: false, code: 'OFFLINE', status: 0, retryable: true,
               error: 'Document transcription and saving need an internet connection. Your reviewed text is still on this device; reconnect and try again.' };
    }

    // The body is read as text first so a non-JSON response (an HTML 502 page,
    // an empty 404 from a Function that was never deployed) is still reportable
    // instead of collapsing into a bare "temporarily unavailable".
    let raw = '';
    try { raw = await res.text(); } catch (e) { raw = ''; }
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch (e) { payload = null; }
    if (payload && payload.ok === true) return { ...payload, status: res.status };

    const code = (payload && payload.code) || (res.status === 429 ? 'RATE_LIMITED' : 'SERVER_CONFIG');
    // Diagnostic only, and deliberately never shown to the mechanic. The image
    // data URL and the bearer token are not part of this — only the request
    // identity, the HTTP status, the server's error code, and a truncated body.
    try {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[document-transcription] request failed', {
          requestId, workOrderId, documentCaptureId, pageNumber, qualityTier,
          httpStatus: res.status,
          code,
          serverError: payload && payload.error,
          requestIdEcho: payload && payload.requestId,
          bodyPreview: payload ? undefined : String(raw).slice(0, 300),
          endpoint: DOCUMENT_TRANSCRIBE_ENDPOINT,
        });
      }
    } catch (e) { /* logging must never break the read */ }

    return {
      ok: false,
      code,
      status: res.status,
      error: (payload && payload.error) || 'Document transcription is temporarily unavailable.',
      retryable: false,
    };
  }

  // ---- upload --------------------------------------------------------------

  async function uploadDocumentPage({ workOrderId, documentCaptureId, pageNumber, blobOrig, blobThumb }) {
    const { origPath, thumbPath } = documentPagePaths(workOrderId, documentCaptureId, pageNumber);
    const opts = { contentType: 'image/jpeg', upsert: true };
    const up1 = await db.storage.from(photoBucket).upload(origPath, blobOrig, opts);
    if (up1.error) throw up1.error;
    const up2 = await db.storage.from(photoBucket).upload(thumbPath, blobThumb, opts);
    if (up2.error) throw up2.error;
    return { origPath, thumbPath, pageNumber, documentCaptureId };
  }

  // ---- validation (runs before ANY database write) -------------------------

  function validatePages(workOrderId, documentCaptureId, pages) {
    if (!Array.isArray(pages) || pages.length === 0) fail('A capture must have at least one page.', { pages: 0 });
    if (pages.length > DOCUMENT_MAX_PAGES) fail(`A capture may have at most ${DOCUMENT_MAX_PAGES} pages.`, { pages: pages.length });

    const seen = new Set();
    for (const p of pages) {
      const n = p && p.pageNumber;
      if (!Number.isInteger(n) || n < 1 || n > DOCUMENT_MAX_PAGES) fail(`Page number ${n} is not valid.`, { page: n });
      if (seen.has(n)) fail(`Page ${n} appears more than once.`, { page: n });
      seen.add(n);

      // Paths are derived, not trusted. If the upload stage supplied them they
      // must match exactly — a mismatch means the row would claim this capture's
      // identity while pointing somewhere else.
      const expected = documentPagePaths(workOrderId, documentCaptureId, n);
      if (p.origPath != null && p.origPath !== expected.origPath) fail(`Page ${n} has an unexpected original path.`, { page: n, expected: expected.origPath, actual: p.origPath });
      if (p.thumbPath != null && p.thumbPath !== expected.thumbPath) fail(`Page ${n} has an unexpected thumbnail path.`, { page: n, expected: expected.thumbPath, actual: p.thumbPath });
    }
    return [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  }

  function validateComments(comments) {
    if (!Array.isArray(comments) || comments.length === 0) fail('A capture must produce at least one comment.', { comments: 0 });
    const seen = new Set();
    comments.forEach((c, i) => {
      // Body contract: a string with something in it. An empty or whitespace-only
      // comment is never a legitimate reviewed transcription — and once accepted
      // the body is stored EXACTLY as reviewed, never trimmed or normalized.
      if (typeof c.body !== 'string') fail(`Comment ${i + 1} has no reviewed text.`, { comment: i + 1, type: typeof c.body });
      if (c.body.trim() === '') fail(`Comment ${i + 1} is empty.`, { comment: i + 1 });
      const seq = c.sequence != null ? c.sequence : i + 1;
      if (!Number.isInteger(seq) || seq < 1) fail(`Comment ${i + 1} has an invalid sequence (${seq}).`, { comment: i + 1, sequence: seq });
      if (seen.has(seq)) fail(`Comment sequence ${seq} appears more than once.`, { sequence: seq });
      seen.add(seq);
    });
  }

  // ---- intended-row builders (single source of truth for verification) -----

  function buildPhotoRows({ workOrderId, documentCaptureId, pages, userId }) {
    return pages.map((p) => {
      const { origPath, thumbPath } = documentPagePaths(workOrderId, documentCaptureId, p.pageNumber);
      return {
        work_order_id: workOrderId,
        storage_path: origPath, thumb_path: thumbPath,   // DERIVED, never from the caller
        width: p.width || null, height: p.height || null,
        mime_type: 'image/jpeg', size_bytes: p.sizeBytes || null,
        caption: p.caption || `Document page ${p.pageNumber}`,
        categories: [DOCUMENT_PHOTO_CATEGORY],
        display_order: p.pageNumber,
        customer_visible: false,
        photo_type: DOCUMENT_PHOTO_TYPE,
        document_capture_id: documentCaptureId,
        document_page_number: p.pageNumber,
        created_by: userId || null,
      };
    });
  }

  function buildActivityRows({ workOrderId, documentCaptureId, comments, author }) {
    return comments.map((c, i) => ({
      work_order_id: workOrderId,
      activity_type: 'document_transcription',
      visibility: c.visibility === 'public' ? 'public' : 'private',
      body: c.body,
      attachments: c.photoIds,
      ai_generated: !!c.aiGenerated,
      author_id: (author && author.id) || null,
      author_name: (author && author.name) || '',
      author_role: (author && author.role) || '',
      document_capture_id: documentCaptureId,
      comment_sequence: c.sequence != null ? c.sequence : i + 1,
      meta: {
        source: c.aiGenerated ? 'document_photo_transcription' : 'document_photo_manual_entry',
        reviewed_by_human: true,
        quality_tier: c.aiGenerated ? (c.qualityTier || 'standard') : null,
        original_confidence: c.originalConfidence != null ? c.originalConfidence : 0,
        low_confidence_regions: c.lowConfidenceRegions || [],
      },
    }));
  }

  // ---- row verification (successful insert AND recovery) -------------------

  function assertPhotoRowsMatch(rows, intended, where) {
    const want = intended.map((r) => r.document_page_number).sort((a, b) => a - b);
    const got = (rows || []).map((r) => r.document_page_number).sort((a, b) => a - b);
    if (!sameArray(want, got)) fail(`${where}: document photo page set differs.`, { want, got });

    const byPage = new Map(intended.map((r) => [r.document_page_number, r]));
    for (const r of rows) {
      const exp = byPage.get(r.document_page_number);
      if (r.work_order_id !== exp.work_order_id) fail(`${where}: wrong work order.`, { row: r.id });
      if (r.document_capture_id !== exp.document_capture_id) fail(`${where}: wrong capture.`, { row: r.id });
      if (r.photo_type !== DOCUMENT_PHOTO_TYPE) fail(`${where}: wrong photo_type.`, { row: r.id, photo_type: r.photo_type });
      if (r.customer_visible !== false) fail(`${where}: photo is not staff-only.`, { row: r.id });
      if (r.storage_path !== exp.storage_path || r.thumb_path !== exp.thumb_path) {
        fail(`${where}: storage paths are not the deterministic paths for this capture.`,
             { row: r.id, expected: { storage_path: exp.storage_path, thumb_path: exp.thumb_path },
               actual: { storage_path: r.storage_path, thumb_path: r.thumb_path } });
      }
      if (r.active === false) fail(`${where}: photo row is inactive.`, { row: r.id });
    }
  }

  // Identity alone is not enough: an ambiguous earlier save could hold different
  // reviewed text. Every intended comment is compared field by field.
  function assertActivityRowsMatch(rows, intended, where, { strictAuthor = true } = {}) {
    const want = intended.map((r) => r.comment_sequence).sort((a, b) => a - b);
    const got = (rows || []).map((r) => r.comment_sequence).sort((a, b) => a - b);
    if (!sameArray(want, got)) fail(`${where}: document comment set differs.`, { want, got });

    const bySeq = new Map(intended.map((r) => [r.comment_sequence, r]));
    for (const r of rows) {
      const exp = bySeq.get(r.comment_sequence);
      const bad = (why, details) => fail(`${where}: ${why}`, { sequence: r.comment_sequence, ...details });

      if (r.active === false) bad('activity row is inactive.');
      if (r.activity_type !== 'document_transcription') bad('wrong activity_type.', { activity_type: r.activity_type });
      if (r.work_order_id !== exp.work_order_id) bad('wrong work order.');
      if (r.document_capture_id !== exp.document_capture_id) bad('wrong capture.');
      if (r.body !== exp.body) bad('stored body differs from the reviewed text.');
      if (r.visibility !== exp.visibility) bad('stored visibility differs.', { stored: r.visibility, intended: exp.visibility });
      if (!sameArray(r.attachments || [], exp.attachments || [])) bad('stored attachments differ.', { stored: r.attachments, intended: exp.attachments });
      if (!!r.ai_generated !== !!exp.ai_generated) bad('stored ai_generated differs.', { stored: !!r.ai_generated });
      // Author is an integrity field. When an author was supplied, the stored row
      // must carry exactly that author — a null author_id is a mismatch, not a
      // pass. Name and role are compared too: the intended-row builder writes
      // them, so a difference means the stored row is not the one being saved.
      if (strictAuthor && exp.author_id) {
        if (r.author_id !== exp.author_id) bad('stored author differs.', { stored: r.author_id, intended: exp.author_id });
        if ((r.author_name || '') !== (exp.author_name || '')) bad('stored author name differs.', { stored: r.author_name, intended: exp.author_name });
        if ((r.author_role || '') !== (exp.author_role || '')) bad('stored author role differs.', { stored: r.author_role, intended: exp.author_role });
      }

      const m = r.meta || {}, em = exp.meta;
      if (m.source !== em.source) bad('provenance source differs.', { stored: m.source });
      if (m.reviewed_by_human !== em.reviewed_by_human) bad('reviewed_by_human differs.');
      if (!sameJson(m.quality_tier, em.quality_tier)) bad('quality_tier differs.', { stored: m.quality_tier, intended: em.quality_tier });
      if (!sameJson(m.original_confidence, em.original_confidence)) bad('original_confidence differs.');
      if (!sameJson(m.low_confidence_regions, em.low_confidence_regions)) bad('low-confidence regions differ.');
    }
  }

  // ---- reads ---------------------------------------------------------------

  async function selectPhotoRows(workOrderId, documentCaptureId) {
    const { data, error } = await db.from('work_order_photos').select('*')
      .eq('work_order_id', workOrderId).eq('document_capture_id', documentCaptureId)
      .eq('active', true).order('document_page_number');
    if (error) throw error;
    return data || [];
  }

  async function selectActivityRows(workOrderId, documentCaptureId) {
    const { data, error } = await db.from('activities').select('*')
      .eq('work_order_id', workOrderId).eq('document_capture_id', documentCaptureId)
      .order('comment_sequence');
    if (error) throw error;
    return data || [];
  }

  // ---- writes --------------------------------------------------------------

  const isUniqueViolation = (e) => !!e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));

  async function saveDocumentCapturePhotos({ workOrderId, documentCaptureId, pages, userId, skipValidation = false }) {
    const ordered = skipValidation ? [...pages].sort((a, b) => a.pageNumber - b.pageNumber)
                                   : validatePages(workOrderId, documentCaptureId, pages);
    const intended = buildPhotoRows({ workOrderId, documentCaptureId, pages: ordered, userId });

    const { data, error } = await db.from('work_order_photos').insert(intended).select();
    if (!error) {
      assertPhotoRowsMatch(data || [], intended, 'Saved document photos');
      return { rows: data || [], photos: await signPhotosFn((data || []).map(photoFromRowFn)), alreadySaved: false };
    }
    if (!isUniqueViolation(error)) throw error;

    const recovered = await selectPhotoRows(workOrderId, documentCaptureId);
    assertPhotoRowsMatch(recovered, intended, 'Recovered document photos');
    return { rows: recovered, photos: await signPhotosFn(recovered.map(photoFromRowFn)), alreadySaved: true };
  }

  async function saveDocumentCaptureActivities({ workOrderId, documentCaptureId, comments, author, skipValidation = false }) {
    if (!skipValidation) validateComments(comments);
    const intended = buildActivityRows({ workOrderId, documentCaptureId, comments, author });

    const { data, error } = await db.from('activities').insert(intended).select();
    if (!error) {
      assertActivityRowsMatch(data || [], intended, 'Saved document comments');
      return { rows: data || [], activities: (data || []).map(activityFromRowFn), alreadySaved: false };
    }
    if (!isUniqueViolation(error)) throw error;

    const recovered = await selectActivityRows(workOrderId, documentCaptureId);
    assertActivityRowsMatch(recovered, intended, 'Recovered document comments');
    return { rows: recovered, activities: recovered.map(activityFromRowFn), alreadySaved: true };
  }

  // Every requested page must resolve. A silently dropped page would attach a
  // comment to the wrong evidence.
  function resolveCommentPages(comments, pageRows, availablePageNumbers) {
    const byPage = new Map(pageRows.map((r) => [r.document_page_number, r.id]));
    return comments.map((c, i) => {
      const requested = (c.pageNumbers && c.pageNumbers.length) ? c.pageNumbers : availablePageNumbers;
      const seen = new Set();
      const ids = [];
      for (const n of requested) {
        if (!Number.isInteger(n) || n < 1 || n > DOCUMENT_MAX_PAGES) fail(`Comment ${i + 1} requests page ${n}, which is not a valid page number.`, { comment: i + 1, page: n });
        if (seen.has(n)) fail(`Comment ${i + 1} requests page ${n} more than once.`, { comment: i + 1, page: n });
        seen.add(n);
        const id = byPage.get(n);
        if (!id) fail(`Comment ${i + 1} requests page ${n}, which is not part of this capture.`, { comment: i + 1, page: n, available: [...byPage.keys()] });
        ids.push(id);
      }
      if (!ids.length) fail(`Comment ${i + 1} has no source page.`, { comment: i + 1 });
      return { ...c, sequence: c.sequence != null ? c.sequence : i + 1, photoIds: ids };
    });
  }

  async function finalizeDocumentCapture({ workOrderId, documentCaptureId, pages, comments, author, userId }) {
    // Whole-capture validation FIRST: nothing is written if any of it is wrong.
    // Storage objects from the upload stage stay valid and reusable.
    const ordered = validatePages(workOrderId, documentCaptureId, pages);
    validateComments(comments);
    const available = ordered.map((p) => p.pageNumber);
    for (const [i, c] of comments.entries()) {
      if (c.pageNumbers && c.pageNumbers.length) {
        const seen = new Set();
        for (const n of c.pageNumbers) {
          if (!Number.isInteger(n) || n < 1 || n > DOCUMENT_MAX_PAGES) fail(`Comment ${i + 1} requests page ${n}, which is not a valid page number.`, { comment: i + 1, page: n });
          if (seen.has(n)) fail(`Comment ${i + 1} requests page ${n} more than once.`, { comment: i + 1, page: n });
          seen.add(n);
          if (!available.includes(n)) fail(`Comment ${i + 1} requests page ${n}, which is not part of this capture.`, { comment: i + 1, page: n, available });
        }
      }
    }

    const saved = await saveDocumentCapturePhotos({ workOrderId, documentCaptureId, pages: ordered, userId: userId || (author && author.id), skipValidation: true });
    const resolved = resolveCommentPages(comments, saved.rows, available);
    const acts = await saveDocumentCaptureActivities({ workOrderId, documentCaptureId, comments: resolved, author, skipValidation: true });

    return { photos: saved.photos, activities: acts.activities, photosExisted: saved.alreadySaved, activitiesExisted: acts.alreadySaved };
  }

  return {
    newDocumentCaptureId, newTranscriptionRequestId, documentPagePaths,
    transcribeDocumentPage, uploadDocumentPage,
    saveDocumentCapturePhotos, saveDocumentCaptureActivities,
    fetchDocumentCapturePhotos: async (w, c) => signPhotosFn((await selectPhotoRows(w, c)).map(photoFromRowFn)),
    fetchDocumentCaptureActivities: async (w, c) => (await selectActivityRows(w, c)).map(activityFromRowFn),
    finalizeDocumentCapture,
    _internals: { validatePages, validateComments, buildPhotoRows, buildActivityRows, resolveCommentPages, assertPhotoRowsMatch, assertActivityRowsMatch },
  };
}

// Pure realtime helpers. NOT wired to the subscription — that is Step 5.
export function mergeActivityById(list, incoming) {
  if (!incoming || !incoming.id) return list;
  const i = list.findIndex((a) => a.id === incoming.id);
  if (i === -1) return [...list, incoming];
  const next = list.slice();
  next[i] = { ...next[i], ...incoming };
  return next;
}

export function mergeActivitiesById(list, incomingList) {
  return (incomingList || []).reduce(mergeActivityById, list);
}
