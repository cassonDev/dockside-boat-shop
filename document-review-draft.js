// ===========================================================================
// document-review-draft.js — Step 5C: review, split, draft, and confirm.
//
//   Pure factory module: imports nothing, references no global, no module-scope
//   side effects, so `node --test` imports it directly. Storage, page staging,
//   finalization, clock, and id generation are injected.
//
//   WHAT THIS MODULE OWNS
//   * Review state: comments, their order, their text, their visibility, and
//     their source pages — all keyed by stable ids, never by array position.
//   * The lifecycle: which states are reachable and what action leaves each one.
//   * The races: double confirm, mutation during confirmation, ambiguous
//     finalization, storage failure, reopen-during-review, and a restored draft
//     meeting a changed capture.
//
//   THREE INVARIANTS WORTH STATING OUT LOUD
//   1. ONE IMMUTABLE CAPTURE IDENTITY per confirmation. A confirmation plan is
//      frozen before the first await; every upload and the finalization read the
//      plan, never live state. A host that switches jobs or reopens the capture
//      mid-save cannot retarget a single byte.
//   2. CONFIRMATION LOCKS THE REVIEW. Every mutation, every capture
//      synchronisation, and teardown itself refuse while a confirmation is in
//      flight. Disabled styling is a courtesy; this is the guard.
//   3. NOTHING IS DERIVED FROM A STALE FLAG. Whether photos are missing is
//      recomputed from the live capture on every read, so a completed
//      reattachment cannot leave a "photos were not restored" warning standing
//      next to an enabled save button.
//
//   FAIL-CLOSED RULES
//   * A comment may never be confirmed with zero source pages.
//   * A restored draft may never bind to a different work order or capture.
//   * A restored draft may never confirm against pages whose images are absent.
//   * Human edits are authoritative: nothing here rewrites a body.
//   * No image bytes, blob, data URL, object URL, or machine-response envelope
//     is ever serialized. Only this feature's own key is ever removed.
//   * The draft is cleared only after a fully verified finalization.
// ===========================================================================

export const DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_KEY_PREFIX = 'dockside:document-draft';
export const DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;   // a draft older than a week is expired

export const draftKeyFor = (workOrderId, documentCaptureId) =>
  `${DRAFT_KEY_PREFIX}:${workOrderId}:${documentCaptureId}`;

export const REVIEW_STATES = [
  'idle', 'recovery', 'review', 'needs_reattach', 'confirming', 'confirmed', 'failed',
  'feature_disabled',
];

export const MESSAGES = {
  storageUnavailable:
    'This device isn’t saving a local draft. Your review is still here while this tab stays open.',
  storageWriteFailed:
    'Couldn’t save the local draft (device storage is full). Your review is still here while this tab stays open.',
  restoredNoPhotos:
    'Your reviewed text was restored, but the document photos were not. Add each page again, then match it to the page it replaces.',
  missingPages:
    'Some pages this review refers to are not in the capture. Add them again and match them, or narrow the comment to the pages you have.',
  zeroPages: 'Every comment needs at least one source page.',
  emptyBody: 'A comment can’t be saved empty. Type the note or delete the comment.',
  deleteLast: 'This is the only comment. Deleting it leaves nothing to save.',
  discardDraft: 'Discarding removes the restored text from this device. This can’t be undone.',
  pendingStronger: 'A page still has a stronger reading waiting for your choice. Resolve it before reviewing.',
  noTranscribedText:
    'No page has been read yet. Use TRY AGAIN, or TRY STRONGER READING, before reviewing the text.',
  sharedPage:
    'That page is already the source for another part of this review. Confirm again to use one photo for both.',
  offline:
    'Document transcription and saving need an internet connection. Your reviewed text is still on this device; reconnect and try again.',
  ambiguous:
    'The save didn’t confirm. Nothing was lost — try again; saving twice cannot create duplicates.',
  locked: 'Saving is in progress. Wait for it to finish or fail before changing the review.',
  // The database refused the save because the shop owner switched the feature
  // off. Distinct from a failure: retrying changes nothing until an owner acts,
  // so no retry is offered — the reviewer returns to the review deliberately.
  featureDisabled:
    'Document transcription was turned off for this shop. Your reviewed text is saved on this device. Ask the shop owner to turn it back on, then return to review and save again.',
  notAllowed:
    'This document can\u2019t be saved to that work order. Check you are on the right job, or ask the shop owner.',
};

// Stable hints raised by the Section 27 A2 feature-gate triggers. The generic
// hint deliberately covers missing, inactive, anonymous, identity-less, and
// cross-shop cases with one indistinguishable refusal; the disabled hint is
// returned only after same-shop authorization has already succeeded.
export const HINT_FEATURE_DISABLED = 'DOCUMENT_TRANSCRIPTION_DISABLED';
export const HINT_NOT_ALLOWED = 'DOCUMENT_ROW_NOT_ALLOWED';

const errorCarries = (e, hint) => {
  if (!e) return false;
  return [e.hint, e.code, e.details, e.message]
    .some((v) => typeof v === 'string' && v.includes(hint));
};

// Anything that could carry image material. Bodies are excluded from this scan
// on purpose: a body is reviewer text by contract and may legitimately contain
// the characters "data:" copied off a printed page. Every other field is
// machine-controlled and must be clean.
const IMAGE_MATERIAL = /(data:|blob:|;base64|objecturl|dataurl)/i;

const clone = (v) => JSON.parse(JSON.stringify(v));
const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const uniq = (list) => [...new Set(list)];

// Deep freeze: the confirmation plan must be impossible to edit after the fact,
// not merely inconvenient to edit.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}

export function createReviewController(deps) {
  const {
    storage,                       // localStorage-like, may be absent or throwing
    finalize,                      // (payload) -> { photos, activities, ... }
    // Stages ONE page's already-generated blobs, by page identity, using the
    // approved data-layer upload (deterministic path + upsert, so a retry
    // overwrites the same object instead of orphaning a new one). The module
    // never sees a blob; the host looks the page up in the capture. Identity is
    // handed IN from the frozen plan and must not be re-derived by the adapter.
    uploadPage = null,
    now = () => Date.now(),
    newId = () => `c-${Math.random().toString(16).slice(2)}`,
    onChange = () => {},
    maxAgeMs = DRAFT_MAX_AGE_MS,
  } = deps || {};

  let session = null;         // { workOrderId, documentCaptureId }
  let pages = [];             // [{ pageId, pageNumber, width, height, sizeBytes, caption, hasImage }]
  let comments = [];
  let status = 'idle';
  let error = '';
  let recovery = null;        // { key, draft, reason }
  let storageStatus = 'ok';   // ok | unavailable | write_failed
  let restoredFromDraft = false;
  let draftPageIds = [];      // the page identities the restored draft was built on
  let confirmInFlight = false;
  let progress = '';
  let lastResult = null;

  // ---- storage boundary ----------------------------------------------------

  function readRaw(key) {
    try { return storage ? storage.getItem(key) : null; }
    catch (e) { storageStatus = 'unavailable'; return null; }
  }

  function writeRaw(key, value) {
    try {
      if (!storage) { storageStatus = 'unavailable'; return false; }
      storage.setItem(key, value);
      if (storageStatus === 'write_failed' || storageStatus === 'unavailable') storageStatus = 'ok';
      return true;
    } catch (e) {
      storageStatus = /quota|exceed/i.test(String((e && e.name) || e)) ? 'write_failed' : 'unavailable';
      return false;
    }
  }

  // Removes exactly one key, and only if it is this feature's own.
  function removeRaw(key) {
    if (typeof key !== 'string' || key.indexOf(`${DRAFT_KEY_PREFIX}:`) !== 0) return false;
    try { if (storage) storage.removeItem(key); return true; }
    catch (e) { storageStatus = 'unavailable'; return false; }
  }

  // ---- serialization -------------------------------------------------------

  function serializableComment(c) {
    return {
      commentId: c.commentId,
      body: c.body,
      visibility: c.visibility,
      pageIds: c.pageIds.slice(),
      aiGenerated: c.aiGenerated,
      qualityTier: c.qualityTier,
      originalConfidence: c.originalConfidence,
      lowConfidenceRegions: clone(c.lowConfidenceRegions || []),
      humanEdited: !!c.humanEdited,
      source: c.source,
    };
  }

  function draftPayload() {
    return {
      v: DRAFT_SCHEMA_VERSION,
      workOrderId: session.workOrderId,
      documentCaptureId: session.documentCaptureId,
      // Identity and order only.
      pages: pages.map((p) => ({ pageId: p.pageId, pageNumber: p.pageNumber })),
      comments: comments.map(serializableComment),
      step: 'review',
      savedAt: now(),
    };
  }

  // A defensive assertion, not a formality: it is the thing that would catch a
  // future edit that starts spreading a page object into the draft.
  function assertNoImageMaterial(payload) {
    const scrubbed = { ...payload, comments: payload.comments.map((c) => ({ ...c, body: '' })) };
    if (IMAGE_MATERIAL.test(JSON.stringify(scrubbed))) {
      throw new Error('Refusing to persist a draft containing image material.');
    }
    // The SCANNED copy is not the SAVED copy: bodies are scrubbed for the scan
    // only. Returning the scrubbed text here would persist empty comments — a
    // draft that restores nothing.
    return JSON.stringify(payload);
  }

  function saveDraft() {
    if (!session || status === 'confirmed') return false;
    let text;
    try { text = assertNoImageMaterial(draftPayload()); }
    catch (e) { storageStatus = 'write_failed'; error = e.message; return false; }
    return writeRaw(draftKeyFor(session.workOrderId, session.documentCaptureId), text);
  }

  function clearOwnDraft() {
    if (!session) return false;
    return removeRaw(draftKeyFor(session.workOrderId, session.documentCaptureId));
  }

  // ---- derived view --------------------------------------------------------
  //
  // Everything about "are the photos here?" is RECOMPUTED here, never stored.
  // A stored flag is how a warning survives the fix that resolved it.

  const pageById = () => new Map(pages.map((p) => [p.pageId, p]));

  function commentIssues(c, byId) {
    const missing = c.pageIds.filter((id) => !byId.has(id));
    const noImage = c.pageIds.filter((id) => byId.has(id) && !byId.get(id).hasImage);
    const issues = [];
    if (!c.body || c.body.trim() === '') issues.push({ code: 'EMPTY_BODY', message: MESSAGES.emptyBody });
    if (!c.pageIds.length) issues.push({ code: 'NO_PAGES', message: MESSAGES.zeroPages });
    if (missing.length) issues.push({ code: 'MISSING_PAGES', message: MESSAGES.missingPages, pageIds: missing });
    if (noImage.length) issues.push({ code: 'NO_IMAGE', message: MESSAGES.restoredNoPhotos, pageIds: noImage });
    return issues;
  }

  const missingPageIds = () => {
    const byId = pageById();
    return uniq(comments.flatMap((c) => c.pageIds).filter((id) => !byId.has(id) || !byId.get(id).hasImage));
  };

  function viewComment(c, index, byId) {
    const issues = commentIssues(c, byId);
    return {
      commentId: c.commentId,
      sequence: index + 1,
      body: c.body,
      visibility: c.visibility,
      pageIds: c.pageIds.slice(),
      pageNumbers: c.pageIds.map((id) => (byId.get(id) ? byId.get(id).pageNumber : null)).filter((n) => n != null),
      missingPageIds: c.pageIds.filter((id) => !byId.has(id)),
      aiGenerated: c.aiGenerated,
      qualityTier: c.qualityTier,
      originalConfidence: c.originalConfidence,
      lowConfidenceRegions: clone(c.lowConfidenceRegions || []),
      lowConfidence: c.aiGenerated && c.originalConfidence != null && c.originalConfidence < 0.75,
      humanEdited: !!c.humanEdited,
      manualEntry: !c.aiGenerated,
      canMergeUp: index > 0,
      canMoveUp: index > 0,
      canMoveDown: index < comments.length - 1,
      isOnlyComment: comments.length === 1,
      issues,
      ok: issues.length === 0,
    };
  }

  function snapshot() {
    const byId = pageById();
    const viewComments = comments.map((c, i) => viewComment(c, i, byId));
    const missing = missingPageIds();
    const blocking = viewComments.some((c) => !c.ok);
    const needsReattach = viewComments.some((c) =>
      c.issues.some((i) => i.code === 'MISSING_PAGES' || i.code === 'NO_IMAGE'));
    // Unmatched pages are the state, whether the mechanic is in the review or
    // away at the page picker: the matching panel is what must be shown either
    // way. `canConfirm` and `canReturnToReview` still distinguish the two.
    const effectiveStatus = session && needsReattach && (status === 'review' || status === 'idle')
      ? 'needs_reattach' : status;
    const referenced = new Set(comments.flatMap((c) => c.pageIds));

    return {
      status: effectiveStatus,
      workOrderId: session ? session.workOrderId : null,
      documentCaptureId: session ? session.documentCaptureId : null,
      pages: pages.map((p) => ({ pageId: p.pageId, pageNumber: p.pageNumber, hasImage: p.hasImage })),
      comments: viewComments,
      error,
      storageStatus,
      storageMessage: storageStatus === 'unavailable' ? MESSAGES.storageUnavailable
        : storageStatus === 'write_failed' ? MESSAGES.storageWriteFailed : '',
      // Recomputed, never a stored flag.
      restoredFromDraft,
      restoredWithoutPhotos: needsReattach,
      needsReattach,
      reattachMessage: needsReattach
        ? (restoredFromDraft ? MESSAGES.restoredNoPhotos : MESSAGES.missingPages) : '',
      missingPageIds: missing,
      draftPageIds: draftPageIds.slice(),
      // Live pages no comment points at yet: the candidates a mechanic maps onto.
      reattachCandidates: pages.filter((p) => p.hasImage && !referenced.has(p.pageId))
        .map((p) => ({ pageId: p.pageId, pageNumber: p.pageNumber })),
      recovery: recovery ? {
        key: recovery.key,
        reason: recovery.reason,
        usable: !recovery.reason,
        workOrderId: recovery.draft.workOrderId || null,
        // The recovered capture identity is EXPOSED so the host can reopen the
        // capture under it instead of inventing a new one.
        documentCaptureId: recovery.draft.documentCaptureId || null,
        pageIds: (recovery.draft.pages || []).map((p) => p.pageId),
        savedAt: recovery.draft.savedAt || null,
        comments: (recovery.draft.comments || []).length,
      } : null,
      confirmInFlight,
      locked: confirmInFlight,
      progress,
      canConfirm: status === 'review' && !confirmInFlight && comments.length > 0 && !blocking,
      canRetryConfirm: status === 'failed' && !confirmInFlight,
      canReturnToReview: !confirmInFlight && !!session && comments.length > 0 && status === 'idle',
      // The feature-off state. SAVE and TRY SAVING AGAIN are both absent; the one
      // deliberate way forward is RETURN TO REVIEW, which is a pure state
      // transition — it makes no request and checks no flag.
      featureDisabled: status === 'feature_disabled',
      featureDisabledMessage: status === 'feature_disabled' ? MESSAGES.featureDisabled : '',
      canReturnAfterFeatureDisabled: status === 'feature_disabled' && !confirmInFlight,
      // Confirmation is allowed only from the review itself or from a failed
      // attempt. Away at the page picker, a stale handler must not save.
      canConfirmFromStatus: status === 'review' || status === 'failed',
      result: lastResult,
    };
  }

  const emit = () => onChange(snapshot());
  const persistAndEmit = () => { saveDraft(); emit(); };
  const find = (id) => comments.find((c) => c.commentId === id);
  const indexOf = (id) => comments.findIndex((c) => c.commentId === id);

  // THE LOCK. Every mutation and every capture synchronisation goes through it.
  const locked = () => confirmInFlight;
  const refuse = () => ({ applied: false, reason: 'in_flight', message: MESSAGES.locked });

  // ---- entering review -----------------------------------------------------

  function makeComment(over) {
    return {
      commentId: newId(),
      body: '',
      visibility: 'private',
      pageIds: pages.map((p) => p.pageId),   // default: ALL captured pages
      aiGenerated: false,
      qualityTier: null,
      originalConfidence: 0,
      lowConfidenceRegions: [],
      humanEdited: false,
      source: 'document_photo_manual_entry',
      ...over,
    };
  }

  function adoptPages(capturePages) {
    pages = (capturePages || []).map((p, i) => ({
      pageId: p.pageId,
      pageNumber: i + 1,
      width: (p.archival && p.archival.width) || p.width || null,
      height: (p.archival && p.archival.height) || p.height || null,
      sizeBytes: (p.archival && p.archival.blob && p.archival.blob.size) || p.sizeBytes || null,
      caption: p.caption || null,
      hasImage: !!(p.archival || p.hasImage),
    }));
  }

  // Imported 5B state with an unresolved KEEP MY EDITS / USE STRONGER READING
  // choice must not be flattened into a comment.
  function beginReview({ workOrderId, documentCaptureId, capturePages, readingPages }) {
    if (locked()) return { ok: false, reason: 'in_flight', message: MESSAGES.locked };
    const pending = (readingPages || []).filter((p) => p.pendingStrong).map((p) => p.pageId);
    if (pending.length) {
      return { ok: false, reason: 'pending_stronger_choice', pageIds: pending, message: MESSAGES.pendingStronger };
    }

    // No page produced text: transcription failed for every page. Review is
    // REFUSED and no state is mutated, so the mechanic stays on the reading
    // screen with each page's error and retry controls intact. Fabricating an
    // empty comment here is what produced a review the mechanic could neither
    // fill from the photo nor save.
    const anyText = (readingPages || []).some((p) => typeof p.text === 'string' && p.text.trim() !== '');
    if (!anyText) {
      return { ok: false, reason: 'no_transcribed_text', message: MESSAGES.noTranscribedText };
    }

    session = { workOrderId, documentCaptureId };
    adoptPages(capturePages);
    restoredFromDraft = false;
    draftPageIds = [];
    lastResult = null;
    error = '';
    confirmInFlight = false;
    progress = '';

    const allIds = pages.map((p) => p.pageId);
    const byPageId = new Map((readingPages || []).map((p) => [p.pageId, p]));
    comments = [];
    for (const p of pages) {
      const r = byPageId.get(p.pageId);
      const text = r && typeof r.text === 'string' ? r.text : '';
      if (text.trim() === '') continue;               // failed or empty page contributes no comment
      comments.push(makeComment({
        body: text,
        pageIds: allIds.slice(),
        aiGenerated: true,
        qualityTier: r.qualityTier || 'standard',
        originalConfidence: r.confidenceScore != null ? r.confidenceScore : 0,
        lowConfidenceRegions: clone(r.lowConfidenceRegions || []),
        humanEdited: !!r.edited,
        source: 'document_photo_transcription',
      }));
    }
    // Unreachable: beginReview() refuses above unless at least one page carries
    // text, so there is always a transcribed comment to review. Kept as a fail-
    // closed assertion rather than an empty-comment fallback.
    if (!comments.length) {
      session = null; pages = []; comments = [];
      return { ok: false, reason: 'no_transcribed_text', message: MESSAGES.noTranscribedText };
    }

    status = 'review';
    persistAndEmit();
    return { ok: true, comments: comments.length };
  }

  // Returning from the page picker — or from a feature-off refusal — to the
  // EXISTING review. Deliberately not beginReview(): re-deriving comments from
  // reading state would throw away the restored or edited text. It performs no
  // network request and checks no feature flag; it only changes state, which is
  // why it is not called "check again".
  function returnToReview() {
    if (locked()) return refuse();
    if (!session || !comments.length) return { applied: false, reason: 'no_review' };
    status = 'review';
    error = '';
    emit();
    return { applied: true };
  }

  // ---- recovery ------------------------------------------------------------

  function parseDraft(raw) {
    let d;
    try { d = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'malformed' }; }
    if (!d || typeof d !== 'object') return { ok: false, reason: 'malformed' };
    if (d.v !== DRAFT_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
    if (!d.workOrderId || !d.documentCaptureId) return { ok: false, reason: 'malformed' };
    if (!Array.isArray(d.pages) || !Array.isArray(d.comments)) return { ok: false, reason: 'malformed' };
    if (!Number.isFinite(d.savedAt)) return { ok: false, reason: 'malformed' };
    if (now() - d.savedAt > maxAgeMs) return { ok: false, reason: 'expired' };
    for (const c of d.comments) {
      if (typeof c.body !== 'string' || !Array.isArray(c.pageIds)) return { ok: false, reason: 'malformed' };
    }
    return { ok: true, draft: d };
  }

  // Reads ONLY keys under this feature's prefix, for this work order. Never
  // enumerates to write or delete.
  function findDrafts(workOrderId) {
    const prefix = `${DRAFT_KEY_PREFIX}:${workOrderId}:`;
    const out = [];
    let count = 0;
    try { count = storage ? storage.length : 0; }
    catch (e) { storageStatus = 'unavailable'; return out; }
    for (let i = 0; i < count; i++) {
      let key = null;
      try { key = storage.key(i); } catch (e) { storageStatus = 'unavailable'; return out; }
      if (typeof key !== 'string' || key.indexOf(prefix) !== 0) continue;
      const raw = readRaw(key);
      if (raw == null) continue;
      const parsed = parseDraft(raw);
      if (!parsed.ok) { out.push({ key, ok: false, reason: parsed.reason }); continue; }
      out.push({ key, ok: true, draft: parsed.draft });
    }
    return out;
  }

  // Offers resume-or-discard, and REPORTS THE RECOVERED CAPTURE IDENTITY so the
  // host can reopen the capture under it. A provisional capture id created on
  // open must never be substituted for it.
  function detectDraft(workOrderId) {
    const found = findDrafts(workOrderId);
    const usable = found.filter((f) => f.ok).sort((a, b) => b.draft.savedAt - a.draft.savedAt)[0];
    if (usable) {
      recovery = { key: usable.key, draft: usable.draft, reason: null };
      if (status === 'idle') status = 'recovery';
      emit();
      return {
        found: true, usable: true, key: usable.key,
        workOrderId: usable.draft.workOrderId,
        documentCaptureId: usable.draft.documentCaptureId,
        pageIds: usable.draft.pages.map((p) => p.pageId),
        savedAt: usable.draft.savedAt,
        comments: usable.draft.comments.length,
      };
    }
    const broken = found.find((f) => !f.ok);
    if (broken) {
      recovery = { key: broken.key, draft: { savedAt: null, comments: [], pages: [] }, reason: broken.reason };
      if (status === 'idle') status = 'recovery';
      emit();
      return { found: true, usable: false, key: broken.key, reason: broken.reason };
    }
    recovery = null;
    emit();
    return { found: false };
  }

  // Binding a restored draft to the live capture. The caller must pass the
  // draft's OWN capture id — the host is expected to have reopened the capture
  // under it first. Every identity mismatch fails closed.
  function resumeDraft({ workOrderId, documentCaptureId, capturePages }) {
    if (locked()) return { ok: false, reason: 'in_flight', message: MESSAGES.locked };
    if (!recovery || !recovery.draft || recovery.reason) {
      return { ok: false, reason: recovery ? recovery.reason : 'no_draft' };
    }
    const d = recovery.draft;
    if (d.workOrderId !== workOrderId) return { ok: false, reason: 'wrong_work_order' };
    // Identity is required, not optional: a null capture id used to be accepted
    // and let the reviewer adopt the draft's id while the capture controller and
    // the upload adapter kept the provisional one.
    if (!documentCaptureId) return { ok: false, reason: 'capture_id_required' };
    if (d.documentCaptureId !== documentCaptureId) return { ok: false, reason: 'wrong_capture' };

    session = { workOrderId: d.workOrderId, documentCaptureId: d.documentCaptureId };
    adoptPages(capturePages);
    draftPageIds = d.pages.map((p) => p.pageId);

    comments = d.comments.map((c) => makeComment({
      commentId: c.commentId || newId(),
      body: c.body,
      visibility: c.visibility === 'public' ? 'public' : 'private',
      pageIds: c.pageIds.slice(),
      aiGenerated: !!c.aiGenerated,
      qualityTier: c.aiGenerated ? (c.qualityTier || 'standard') : null,
      originalConfidence: c.originalConfidence != null ? c.originalConfidence : 0,
      lowConfidenceRegions: clone(c.lowConfidenceRegions || []),
      humanEdited: !!c.humanEdited,
      source: c.aiGenerated ? 'document_photo_transcription' : 'document_photo_manual_entry',
    }));

    restoredFromDraft = true;
    recovery = null;
    error = '';
    const missing = missingPageIds();
    // A draft restored without its photos lands the mechanic on the page picker.
    // The reviewer goes to its "away at pages" state — session, comments, and
    // draft intact — so RETURN TO REVIEW is reachable and beginReview() is never
    // needed on this path.
    status = missing.length ? 'idle' : 'review';
    persistAndEmit();
    return {
      ok: true,
      documentCaptureId: d.documentCaptureId,
      identical: sameSet(draftPageIds, pages.map((p) => p.pageId)),
      missingPageIds: missing,
      needsReattach: missing.length > 0,
    };
  }

  // Warned, then explicit. Removes only this key, and never during a save.
  function discardDraft({ force = false } = {}) {
    if (locked()) return { discarded: false, reason: 'in_flight', message: MESSAGES.locked };
    if (!recovery) return { discarded: false, reason: 'no_draft' };
    if (!force) return { discarded: false, requiresConfirm: true, warning: MESSAGES.discardDraft };
    removeRaw(recovery.key);
    recovery = null;
    if (status === 'recovery') status = 'idle';
    emit();
    return { discarded: true };
  }

  // Explicit mapping after the reviewer adds a replacement page. Never inferred
  // from filename, position, or page number. Mapping several original pages onto
  // ONE replacement needs a second, separate approval — it is usually a mistake,
  // and it silently changes what evidence a comment stands on.
  function reattachPage(oldPageId, newPageId, { allowShared = false } = {}) {
    if (locked()) return refuse();
    const live = pageById();
    if (!live.has(newPageId) || !live.get(newPageId).hasImage) return { applied: false, reason: 'unknown_page' };
    if (!comments.some((c) => c.pageIds.includes(oldPageId))) return { applied: false, reason: 'not_referenced' };
    const alreadyUsed = comments.some((c) => c.pageIds.includes(newPageId));
    if (alreadyUsed && !allowShared) {
      return { applied: false, reason: 'already_mapped', requiresApproval: true, message: MESSAGES.sharedPage };
    }
    let touched = 0;
    for (const c of comments) {
      const i = c.pageIds.indexOf(oldPageId);
      if (i === -1) continue;
      if (c.pageIds.includes(newPageId)) c.pageIds.splice(i, 1);
      else c.pageIds[i] = newPageId;
      touched += 1;
    }
    persistAndEmit();
    const missing = missingPageIds();
    return { applied: true, comments: touched, missingPageIds: missing, complete: missing.length === 0 };
  }

  // ---- capture synchronisation --------------------------------------------
  //
  // The capture changes under review whenever the mechanic adds, removes,
  // reorders, rotates, or enhances a page. Page numbers move; page IDENTITY does
  // not. A comment that loses its last page is left invalid and visible rather
  // than silently repaired — the reviewer decides what evidence it stands on.

  function syncCapture(capturePages) {
    if (locked()) return { changed: false, reason: 'in_flight' };
    if (!session) return { changed: false };
    const before = pages.map((p) => p.pageId);
    adoptPages(capturePages);
    const after = pages.map((p) => p.pageId);
    const changed = !sameSet(before, after);
    if (changed) saveDraft();
    emit();
    return {
      changed,
      removed: before.filter((id) => !after.includes(id)),
      added: after.filter((id) => !before.includes(id)),
      missingPageIds: missingPageIds(),
    };
  }

  // ---- comment operations --------------------------------------------------

  function editComment(commentId, body) {
    if (locked()) return refuse();
    const c = find(commentId);
    if (!c) return { applied: false };
    c.body = body;                      // stored exactly as typed; never trimmed
    c.humanEdited = true;
    persistAndEmit();
    return { applied: true };
  }

  function setVisibility(commentId, visibility) {
    if (locked()) return refuse();
    const c = find(commentId);
    if (!c) return { applied: false };
    c.visibility = visibility === 'public' ? 'public' : 'private';
    persistAndEmit();
    return { applied: true };
  }

  // Split at a caret index. Both halves keep the parent's provenance, and the
  // new comment defaults to ALL captured pages — narrowing is explicit.
  function splitComment(commentId, caretIndex) {
    if (locked()) return refuse();
    const i = indexOf(commentId);
    if (i === -1) return { applied: false };
    const c = comments[i];
    const at = Math.max(0, Math.min(Number.isInteger(caretIndex) ? caretIndex : c.body.length, c.body.length));
    const head = c.body.slice(0, at);
    const tail = c.body.slice(at);
    if (head.trim() === '' || tail.trim() === '') {
      return { applied: false, reason: 'empty_half', message: 'Split where both halves have text.' };
    }
    const allIds = pages.map((p) => p.pageId);
    c.body = head;
    const child = makeComment({
      body: tail,
      pageIds: allIds.slice(),
      aiGenerated: c.aiGenerated,
      qualityTier: c.qualityTier,
      originalConfidence: c.originalConfidence,
      lowConfidenceRegions: clone(c.lowConfidenceRegions || []),
      humanEdited: c.humanEdited,
      source: c.source,
      visibility: c.visibility,
    });
    comments.splice(i + 1, 0, child);
    persistAndEmit();
    return { applied: true, commentId: child.commentId };
  }

  // Merge into the previous comment: bodies joined in order, page sets unioned
  // in capture order, provenance widened, visibility never widened.
  function mergeCommentUp(commentId) {
    if (locked()) return refuse();
    const i = indexOf(commentId);
    if (i <= 0) return { applied: false, reason: 'no_previous' };
    const prev = comments[i - 1];
    const c = comments[i];
    const order = pages.map((p) => p.pageId);
    const rank = (id) => { const k = order.indexOf(id); return k === -1 ? 1e9 : k; };
    prev.body = `${prev.body}\n\n${c.body}`;
    prev.pageIds = uniq([...prev.pageIds, ...c.pageIds]).sort((a, b) => rank(a) - rank(b));
    prev.aiGenerated = prev.aiGenerated || c.aiGenerated;
    prev.qualityTier = prev.aiGenerated
      ? (prev.qualityTier === 'strong' || c.qualityTier === 'strong' ? 'strong' : 'standard')
      : null;
    prev.originalConfidence = Math.min(
      prev.originalConfidence != null ? prev.originalConfidence : 0,
      c.originalConfidence != null ? c.originalConfidence : 0,
    );
    prev.lowConfidenceRegions = [...(prev.lowConfidenceRegions || []), ...(c.lowConfidenceRegions || [])];
    prev.source = prev.aiGenerated ? 'document_photo_transcription' : 'document_photo_manual_entry';
    prev.humanEdited = prev.humanEdited || c.humanEdited;
    prev.visibility = (prev.visibility === 'public' && c.visibility === 'public') ? 'public' : 'private';
    comments.splice(i, 1);
    persistAndEmit();
    return { applied: true, commentId: prev.commentId };
  }

  function moveComment(commentId, delta) {
    if (locked()) return refuse();
    const i = indexOf(commentId);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= comments.length) return { applied: false };
    const [moved] = comments.splice(i, 1);
    comments.splice(j, 0, moved);
    persistAndEmit();
    return { applied: true };
  }

  function deleteComment(commentId, { force = false } = {}) {
    if (locked()) return refuse();
    const i = indexOf(commentId);
    if (i === -1) return { applied: false };
    if (comments.length === 1 && !force) {
      return { applied: false, requiresConfirm: true, warning: MESSAGES.deleteLast };
    }
    comments.splice(i, 1);
    // Deleting the last comment leaves an empty manual comment rather than an
    // unsaveable dead end with no action out.
    if (!comments.length) comments.push(makeComment({ body: '' }));
    persistAndEmit();
    return { applied: true };
  }

  function addComment() {
    if (locked()) return refuse();
    const c = makeComment({ body: '' });
    comments.push(c);
    persistAndEmit();
    return { applied: true, commentId: c.commentId };
  }

  // Page narrowing. A comment can never be left with zero pages.
  function setCommentPages(commentId, pageIds) {
    if (locked()) return refuse();
    const c = find(commentId);
    if (!c) return { applied: false };
    const live = pageById();
    const order = pages.map((p) => p.pageId);
    const next = uniq(pageIds || []).filter((id) => live.has(id))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (!next.length) return { applied: false, reason: 'zero_pages', message: MESSAGES.zeroPages };
    c.pageIds = next;
    persistAndEmit();
    return { applied: true };
  }

  function toggleCommentPage(commentId, pageId) {
    if (locked()) return refuse();
    const c = find(commentId);
    if (!c) return { applied: false };
    const has = c.pageIds.includes(pageId);
    const next = has ? c.pageIds.filter((id) => id !== pageId) : [...c.pageIds, pageId];
    if (!next.length) return { applied: false, reason: 'zero_pages', message: MESSAGES.zeroPages };
    c.pageIds = uniq(next).filter((id) => pageById().has(id))
      .sort((a, b) => pages.findIndex((p) => p.pageId === a) - pages.findIndex((p) => p.pageId === b));
    persistAndEmit();
    return { applied: true };
  }

  // ---- confirmation --------------------------------------------------------

  function validateForConfirm() {
    const byId = pageById();
    if (!comments.length) return [{ code: 'NO_COMMENTS', message: MESSAGES.emptyBody }];
    return comments.flatMap((c, i) =>
      commentIssues(c, byId).map((issue) => ({ ...issue, sequence: i + 1, commentId: c.commentId })));
  }

  // THE PLAN. Built once, before the first await, deep-frozen, and used for
  // every upload and for finalization. Nothing after this point reads live
  // state, so a mutation, a page removal, a capture reopen, or a job switch
  // during the save cannot change what is written.
  function buildPlan(author, userId) {
    const byId = pageById();
    return deepFreeze({
      workOrderId: session.workOrderId,
      documentCaptureId: session.documentCaptureId,
      pages: pages.map((p) => ({
        pageId: p.pageId, pageNumber: p.pageNumber, width: p.width, height: p.height,
        sizeBytes: p.sizeBytes, caption: p.caption || `Document page ${p.pageNumber}`,
      })),
      comments: comments.map((c, i) => ({
        sequence: i + 1,
        body: c.body,
        visibility: c.visibility,
        aiGenerated: c.aiGenerated,
        qualityTier: c.aiGenerated ? (c.qualityTier || 'standard') : null,
        originalConfidence: c.originalConfidence,
        lowConfidenceRegions: clone(c.lowConfidenceRegions || []),
        pageNumbers: c.pageIds.map((id) => byId.get(id).pageNumber).sort((a, b) => a - b),
      })),
      author: author || null,
      userId: userId || (author && author.id) || null,
    });
  }

  // Maps the frozen plan onto the approved data-layer finalization contract. No
  // storage or database logic is duplicated here.
  const finalizePayloadFrom = (plan) => ({
    workOrderId: plan.workOrderId,
    documentCaptureId: plan.documentCaptureId,
    pages: plan.pages.map((p) => ({
      pageNumber: p.pageNumber, width: p.width, height: p.height,
      sizeBytes: p.sizeBytes, caption: p.caption,
    })),
    comments: plan.comments.map((c) => ({ ...c, lowConfidenceRegions: clone(c.lowConfidenceRegions) })),
    author: plan.author,
    userId: plan.userId,
  });

  // Fail closed on anything that is not a complete, matching result. The
  // approved data layer already verifies its own rows; this is the injected
  // boundary refusing to clear the draft on a partial or malformed reply.
  function verifyResult(result, plan) {
    const activities = (result && result.activities) || [];
    const photos = (result && result.photos) || [];
    if (!Array.isArray(activities) || activities.length !== plan.comments.length) {
      return { ok: false, detail: 'comment_count', saved: activities.length, expected: plan.comments.length };
    }
    if (!Array.isArray(photos) || photos.length !== plan.pages.length) {
      return { ok: false, detail: 'photo_count', saved: photos.length, expected: plan.pages.length };
    }
    // The approved data layer's converter exposes `documentPageNumber` and
    // `documentCaptureId`; the raw-row shapes are accepted too. Identity is
    // REQUIRED on every returned photo — treating an absent field as “nothing to
    // check” is how page verification silently stops running.
    const pageNumberOf = (row) => (row && (row.documentPageNumber != null ? row.documentPageNumber
      : row.document_page_number != null ? row.document_page_number
      : row.pageNumber != null ? row.pageNumber : row.page_number));
    const captureOf = (row) => (row && (row.documentCaptureId != null ? row.documentCaptureId
      : row.document_capture_id));

    const reported = [];
    for (const row of photos) {
      const n = pageNumberOf(row);
      if (n == null) return { ok: false, detail: 'photo_page_identity_missing' };
      const cap = captureOf(row);
      if (cap == null) return { ok: false, detail: 'photo_capture_identity_missing' };
      if (cap !== plan.documentCaptureId) return { ok: false, detail: 'capture_identity' };
      reported.push(n);
    }
    if (uniq(reported).length !== reported.length) return { ok: false, detail: 'duplicate_page' };
    const want = plan.pages.map((p) => p.pageNumber).sort((a, b) => a - b);
    if (!sameSet(want, [...reported].sort((a, b) => a - b))) return { ok: false, detail: 'photo_page_identity' };

    // Activities: the converter may or may not surface the capture id. When it
    // does, it must match.
    for (const row of activities) {
      const cap = captureOf(row);
      if (cap != null && cap !== plan.documentCaptureId) return { ok: false, detail: 'capture_identity' };
    }
    return { ok: true, activities: activities.length, photos: photos.length };
  }

  function failConfirmation(message, extra) {
    confirmInFlight = false;
    status = 'failed';
    progress = '';
    error = message;
    // The draft is retained on EVERY failure path, including the ambiguous one.
    // The data layer's finalization is idempotent per capture id, so the retry
    // is safe by construction rather than by hope.
    saveDraft();
    emit();
    return { ok: false, retryable: true, error, ...extra };
  }

  // Duplicate taps are refused in CODE. The flag is set synchronously, before
  // any await, so two taps in the same tick cannot both pass.
  async function confirm({ author, userId } = {}) {
    if (confirmInFlight) return { ok: false, reason: 'in_flight' };
    if (!session) return { ok: false, reason: 'no_session' };
    // Confirmed is terminal for this capture: a late tap on a stale render must
    // not open a second finalization, idempotent or not.
    if (status === 'confirmed') return { ok: false, reason: 'already_confirmed' };
    // Only the review itself, or a failed attempt being retried, may save. Away
    // at the page picker or mid-recovery, a stale handler must not upload.
    if (status !== 'review' && status !== 'failed') return { ok: false, reason: 'not_in_review', status };
    const issues = validateForConfirm();
    if (issues.length) {
      error = issues[0].message;
      status = 'review';
      emit();
      return { ok: false, reason: 'invalid', issues };
    }

    const plan = buildPlan(author, userId);
    confirmInFlight = true;
    status = 'confirming';
    error = '';
    emit();

    // Staging first, one page at a time, page-level progress only — the storage
    // client exposes no upload progress, and a fake percentage is worse than
    // none. Every page must succeed before any database row exists.
    if (uploadPage) {
      for (const p of plan.pages) {
        progress = `Uploading page ${p.pageNumber} of ${plan.pages.length}`;
        emit();
        try {
          await uploadPage({
            pageId: p.pageId, pageNumber: p.pageNumber, totalPages: plan.pages.length,
            workOrderId: plan.workOrderId, documentCaptureId: plan.documentCaptureId,
          });
        } catch (e) {
          return failConfirmation(
            (e && e.code === 'OFFLINE') ? MESSAGES.offline
              : `Couldn’t upload page ${p.pageNumber}. Nothing was saved — try again.`,
            { reason: 'upload_failed', pageNumber: p.pageNumber },
          );
        }
      }
    }
    progress = 'Saving reviewed comments';
    emit();

    let result;
    try {
      result = await finalize(finalizePayloadFrom(plan));
    } catch (e) {
      // The A2 feature gate refused: the owner switched the feature off. This is
      // its own state, not a failure — `failed` would derive a retry button, and
      // every retry would be refused identically until an owner acts.
      if (errorCarries(e, HINT_FEATURE_DISABLED)) {
        confirmInFlight = false;
        status = 'feature_disabled';
        progress = '';
        error = MESSAGES.featureDisabled;
        saveDraft();                       // retained, exactly as on every failure
        emit();
        return { ok: false, reason: 'feature_disabled', retryable: false, error };
      }
      return failConfirmation(
        errorCarries(e, HINT_NOT_ALLOWED) ? MESSAGES.notAllowed
          : (e && e.code === 'OFFLINE') ? MESSAGES.offline
          : (e && e.ambiguous) ? MESSAGES.ambiguous
          : (e && e.message) || MESSAGES.ambiguous,
        { reason: 'failed' },
      );
    }

    const verified = verifyResult(result, plan);
    if (!verified.ok) {
      return failConfirmation(MESSAGES.ambiguous, {
        reason: 'unverified', detail: verified.detail,
        saved: verified.saved, expected: verified.expected,
      });
    }

    confirmInFlight = false;
    status = 'confirmed';
    progress = '';
    lastResult = {
      activities: verified.activities,
      photos: verified.photos,
      documentCaptureId: plan.documentCaptureId,
      alreadySaved: !!(result && (result.activitiesExisted || result.photosExisted)),
    };
    clearOwnDraft();      // only after fully verified success, and only this key
    emit();
    return { ok: true, ...lastResult };
  }

  const retryConfirm = (args) => confirm(args);

  // Teardown refuses mid-save: nulling the session between awaits is how a
  // confirmation loses the draft it is supposed to be protecting.
  function closeReview() {
    if (locked()) return refuse();
    session = null; pages = []; comments = [];
    status = 'idle'; error = ''; recovery = null;
    restoredFromDraft = false; draftPageIds = []; progress = '';
    emit();
    return { applied: true };
  }

  // Leaving review for the page picker keeps the session, the comments, and the
  // draft. returnToReview() comes back to exactly this review.
  function backToCapture() {
    if (locked()) return refuse();
    saveDraft();
    status = 'idle';
    emit();
    return { applied: true };
  }

  return {
    beginReview, returnToReview, detectDraft, resumeDraft, discardDraft, reattachPage, syncCapture,
    editComment, setVisibility, splitComment, mergeCommentUp, moveComment,
    deleteComment, addComment, setCommentPages, toggleCommentPage,
    confirm, retryConfirm, closeReview, backToCapture,
    getState: snapshot,
    _internals: { draftPayload, parseDraft, buildPlan, finalizePayloadFrom, verifyResult, validateForConfirm, saveDraft },
  };
}
