// Step 5C tests — review, split, draft persistence, and confirmation.
// Run:  node --test tests/document-review-draft.test.mjs
// Fully mocked: no Supabase, no Netlify, no OpenAI, no network, no browser.
// `finalize` is a double standing in for the approved Step 4
// `finalizeDocumentCapture`; `storage` is an in-memory localStorage double.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewController, draftKeyFor, DRAFT_KEY_PREFIX, DRAFT_SCHEMA_VERSION, MESSAGES,
  REVIEW_STATES, HINT_FEATURE_DISABLED, HINT_NOT_ALLOWED,
} from '../document-review-draft.js';

const WO = 'K7M2Q';
const CAP = 'cap-1';
const AUTHOR = { id: 'u-1', name: 'Dana Reyes', role: 'mechanic' };

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i]; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

// Capture pages carry exactly what 5A produces: blobs and an object URL. None
// of it may reach storage.
const capturePages = (n) => Array.from({ length: n }, (_, i) => ({
  pageId: `p${i + 1}`,
  archival: { blob: { size: 90000 + i, type: 'image/jpeg' }, width: 1800, height: 2400 },
  thumb: { blob: { size: 4000 }, url: `blob:https://app.local/thumb-${i + 1}`, width: 320, height: 427 },
  ocr: { blob: { size: 40000 }, width: 1200, height: 1600 },
  sourceFile: { name: `IMG_000${i + 1}.jpg` },
}));

const readingPages = (texts, over = {}) => texts.map((text, i) => ({
  pageId: `p${i + 1}`, pageNumber: i + 1, text,
  state: text ? 'ready' : 'failed', confidenceScore: text ? 0.91 : null,
  lowConfidenceRegions: [], needsReview: false, qualityTier: 'standard', edited: false,
  pendingStrong: null, ...(over[`p${i + 1}`] || {}),
}));

function harness(opts = {}) {
  const {
    storage = makeStorage(),
    clock = { t: 1_700_000_000_000 },
    uploadPage,
    uploadTimeoutMs,
    finalizeTimeoutMs,
    timers,
    finalize = async (payload) => ({
      photos: payload.pages.map((p, i) => ({ id: `ph-${i + 1}`, documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
      activities: payload.comments.map((c, i) => ({ id: `ac-${i + 1}`, body: c.body, documentCaptureId: payload.documentCaptureId })),
      photosExisted: false, activitiesExisted: false,
    }),
  } = opts;
  let n = 0;
  const calls = [];
  const uploads = [];
  const emissions = [];
  const ctl = createReviewController({
    storage,
    now: () => clock.t,
    newId: () => `c${++n}`,
    uploadPage: async (page) => { uploads.push(page.pageNumber); if (uploadPage) return uploadPage(page, uploads.length); },
    finalize: async (payload) => { calls.push(payload); return finalize(payload, calls.length); },
    onChange: (s) => emissions.push(s),
    // Only supplied when a test is exercising the bounds, so every existing
    // test keeps the production defaults and the real setTimeout.
    ...(uploadTimeoutMs != null ? { uploadTimeoutMs } : {}),
    ...(finalizeTimeoutMs != null ? { finalizeTimeoutMs } : {}),
    ...(timers ? { setTimeoutFn: timers.set, clearTimeoutFn: timers.clear } : {}),
  });
  const begin = (texts = ['Page one text', 'Page two text'], pageCount = texts.length) =>
    ctl.beginReview({
      workOrderId: WO, documentCaptureId: CAP,
      capturePages: capturePages(pageCount), readingPages: readingPages(texts),
    });
  const stored = () => {
    const raw = storage.getItem(draftKeyFor(WO, CAP));
    return raw == null ? null : JSON.parse(raw);
  };
  return { ctl, storage, calls, uploads, emissions, clock, begin, stored };
}

// ---------------------------------------------------------------------------
// Entering review
// ---------------------------------------------------------------------------

test('review starts with one comment per transcribed page, each defaulting to ALL captured pages', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  const s = h.ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.comments.length, 3);
  for (const c of s.comments) assert.deepEqual(c.pageIds, ['p1', 'p2', 'p3']);
  assert.deepEqual(s.comments.map((c) => c.sequence), [1, 2, 3]);
});

test('a page that produced no text contributes no comment, and the others survive', () => {
  const h = harness();
  h.begin(['one', '', 'three']);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments.map((c) => c.body), ['one', 'three']);
  assert.equal(s.pages.length, 3, 'the failed page is still a source page');
});

test('complete AI failure REFUSES review instead of opening an empty comment', () => {
  const h = harness();
  const r = h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(2),
    readingPages: [
      { pageId: 'p1', text: '', state: 'failed' },
      { pageId: 'p2', text: null, state: 'failed' },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_transcribed_text');
  assert.equal(r.message, MESSAGES.noTranscribedText);
  const s = h.ctl.getState();
  assert.equal(s.status, 'idle', 'the reviewer never opened, so the mechanic stays on the pages/reading screen');
  assert.equal(s.comments.length, 0, 'no fabricated empty comment');
});

test('one page of text is enough to open review; failed pages contribute no comment', () => {
  const h = harness();
  const r = h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(2),
    readingPages: [
      { pageId: 'p1', text: '', state: 'failed' },
      { pageId: 'p2', text: 'page two read fine', state: 'ready', qualityTier: 'standard', confidenceScore: 0.9 },
    ],
  });
  assert.equal(r.ok, true);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments.map((c) => c.body), ['page two read fine']);
  assert.equal(s.comments[0].aiGenerated, true);
  assert.equal(s.pages.length, 2, 'the failed page is still a source page');
});

test('whitespace-only transcription counts as no text', () => {
  const h = harness();
  const r = h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(1),
    readingPages: [{ pageId: 'p1', text: '   \n\t  ', state: 'ready' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_transcribed_text');
});

test('an unresolved stronger-reading choice blocks review instead of silently resolving it', () => {
  const h = harness();
  const r = h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(2),
    readingPages: readingPages(['edited text', 'two'], { p1: { edited: true, pendingStrong: { text: 'stronger' } } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pending_stronger_choice');
  assert.deepEqual(r.pageIds, ['p1']);
  assert.equal(h.ctl.getState().status, 'idle', 'review is not entered');
});

test('every comment defaults to private visibility', () => {
  const h = harness();
  h.begin(['one', 'two']);
  assert.deepEqual(h.ctl.getState().comments.map((c) => c.visibility), ['private', 'private']);
});

test('low confidence is surfaced as a review aid without blocking confirmation', () => {
  const h = harness();
  h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(1),
    readingPages: readingPages(['faint [illegible] pencil'], { p1: { confidenceScore: 0.41, lowConfidenceRegions: [{ pageNumber: 1, text: '[illegible]', reason: 'Handwriting is unclear' }] } }),
  });
  const c = h.ctl.getState().comments[0];
  assert.equal(c.lowConfidence, true);
  assert.equal(c.lowConfidenceRegions.length, 1);
  assert.equal(h.ctl.getState().canConfirm, true);
});

// ---------------------------------------------------------------------------
// Editing, split, merge, reorder, delete
// ---------------------------------------------------------------------------

test('a human edit is stored verbatim and marks the comment edited', () => {
  const h = harness();
  h.begin(['machine text']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, '  spaced  text\n\nkept  ');
  const c = h.ctl.getState().comments[0];
  assert.equal(c.body, '  spaced  text\n\nkept  ');
  assert.equal(c.humanEdited, true);
});

test('a human edit survives a later capture synchronisation', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.editComment(id, 'human authority');
  h.ctl.syncCapture(capturePages(2));
  assert.equal(h.ctl.getState().comments[0].body, 'human authority');
});

test('split produces two comments in order, both defaulting to all captured pages', () => {
  const h = harness();
  h.begin(['PARTS LIST\nimpeller kit']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setCommentPages(id, ['p1']);
  const r = h.ctl.splitComment(id, 'PARTS LIST'.length);
  assert.equal(r.applied, true);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments.map((c) => c.body), ['PARTS LIST', '\nimpeller kit']);
  assert.deepEqual(s.comments[1].pageIds, ['p1'], 'one-page capture: all pages is that page');
});

test('a split comment inherits ALL pages even when the parent was narrowed', () => {
  const h = harness();
  h.begin(['alpha beta', 'two', 'three']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setCommentPages(id, ['p2']);
  h.ctl.splitComment(id, 'alpha'.length);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments[0].pageIds, ['p2'], 'the narrowed parent keeps its explicit choice');
  assert.deepEqual(s.comments[1].pageIds, ['p1', 'p2', 'p3'], 'the new comment defaults to all pages');
});

test('a split that would create an empty half is refused', () => {
  const h = harness();
  h.begin(['text']);
  const id = h.ctl.getState().comments[0].commentId;
  const r = h.ctl.splitComment(id, 0);
  assert.equal(r.applied, false);
  assert.equal(h.ctl.getState().comments.length, 1);
});

test('split preserves provenance and visibility on both halves', () => {
  const h = harness();
  h.begin(['alpha beta']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setVisibility(id, 'public');
  h.ctl.splitComment(id, 'alpha'.length);
  for (const c of h.ctl.getState().comments) {
    assert.equal(c.aiGenerated, true);
    assert.equal(c.visibility, 'public');
    assert.equal(c.qualityTier, 'standard');
  }
});

test('merge unions the page sets in capture order and keeps deterministic body order', () => {
  const h = harness();
  h.begin(['first', 'second', 'third']);
  const s0 = h.ctl.getState();
  h.ctl.setCommentPages(s0.comments[0].commentId, ['p3']);
  h.ctl.setCommentPages(s0.comments[1].commentId, ['p1', 'p2']);
  h.ctl.mergeCommentUp(s0.comments[1].commentId);
  const s = h.ctl.getState();
  assert.equal(s.comments.length, 2);
  assert.equal(s.comments[0].body, 'first\n\nsecond');
  assert.deepEqual(s.comments[0].pageIds, ['p1', 'p2', 'p3']);
});

test('merge never widens visibility: private plus public stays private', () => {
  const h = harness();
  h.begin(['a', 'b']);
  const s0 = h.ctl.getState();
  h.ctl.setVisibility(s0.comments[1].commentId, 'public');
  h.ctl.mergeCommentUp(s0.comments[1].commentId);
  assert.equal(h.ctl.getState().comments[0].visibility, 'private');
});

test('merging an AI comment into a manual one keeps AI provenance and the stronger tier', () => {
  const h = harness();
  h.begin(['ai text']);
  const manual = h.ctl.addComment().commentId;
  h.ctl.editComment(manual, 'typed by hand');
  h.ctl.moveComment(manual, -1);            // manual first, AI second
  const aiId = h.ctl.getState().comments[1].commentId;
  h.ctl.mergeCommentUp(aiId);
  const c = h.ctl.getState().comments[0];
  assert.equal(c.aiGenerated, true);
  assert.equal(c.qualityTier, 'standard');
});

test('the first comment cannot merge up', () => {
  const h = harness();
  h.begin(['a', 'b']);
  const r = h.ctl.mergeCommentUp(h.ctl.getState().comments[0].commentId);
  assert.equal(r.applied, false);
  assert.equal(h.ctl.getState().comments.length, 2);
});

test('reorder moves a comment without losing its identity, text, pages, or visibility', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  const s0 = h.ctl.getState();
  const target = s0.comments[2];
  h.ctl.setVisibility(target.commentId, 'public');
  h.ctl.setCommentPages(target.commentId, ['p2']);
  h.ctl.moveComment(target.commentId, -2);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments.map((c) => c.body), ['three', 'one', 'two']);
  assert.equal(s.comments[0].commentId, target.commentId);
  assert.equal(s.comments[0].visibility, 'public');
  assert.deepEqual(s.comments[0].pageIds, ['p2']);
  assert.deepEqual(s.comments.map((c) => c.sequence), [1, 2, 3]);
});

test('reorder past the ends is a no-op', () => {
  const h = harness();
  h.begin(['one', 'two']);
  assert.equal(h.ctl.moveComment(h.ctl.getState().comments[0].commentId, -1).applied, false);
  assert.equal(h.ctl.moveComment(h.ctl.getState().comments[1].commentId, 1).applied, false);
  assert.deepEqual(h.ctl.getState().comments.map((c) => c.body), ['one', 'two']);
});

test('deleting the last remaining comment warns first', () => {
  const h = harness();
  h.begin(['only']);
  const id = h.ctl.getState().comments[0].commentId;
  const r = h.ctl.deleteComment(id);
  assert.equal(r.applied, false);
  assert.equal(r.requiresConfirm, true);
  assert.equal(r.warning, MESSAGES.deleteLast);
  assert.equal(h.ctl.getState().comments.length, 1);
});

test('a forced delete of the last comment leaves an empty manual comment, never a dead end', () => {
  const h = harness();
  h.begin(['only']);
  h.ctl.deleteComment(h.ctl.getState().comments[0].commentId, { force: true });
  const s = h.ctl.getState();
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0].body, '');
  assert.equal(s.comments[0].manualEntry, true);
  assert.equal(s.canConfirm, false);
});

test('deleting one of several comments renumbers the rest deterministically', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  h.ctl.deleteComment(h.ctl.getState().comments[1].commentId);
  const s = h.ctl.getState();
  assert.deepEqual(s.comments.map((c) => c.body), ['one', 'three']);
  assert.deepEqual(s.comments.map((c) => c.sequence), [1, 2]);
});

// ---------------------------------------------------------------------------
// Pages per comment
// ---------------------------------------------------------------------------

test('page narrowing is explicit and ordered by capture order', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setCommentPages(id, ['p3', 'p1']);
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p1', 'p3']);
});

test('setting a comment to zero pages is rejected and changes nothing', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  const r = h.ctl.setCommentPages(id, []);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'zero_pages');
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p1', 'p2']);
});

test('toggling off the last page of a comment is rejected', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setCommentPages(id, ['p2']);
  const r = h.ctl.toggleCommentPage(id, 'p2');
  assert.equal(r.applied, false);
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p2']);
});

test('toggling a page on and off again is symmetric', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.toggleCommentPage(id, 'p1');
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p2']);
  h.ctl.toggleCommentPage(id, 'p1');
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p1', 'p2']);
});

test('unknown page ids are ignored rather than stored', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.setCommentPages(id, ['p1', 'p9']);
  assert.deepEqual(h.ctl.getState().comments[0].pageIds, ['p1']);
});

// ---------------------------------------------------------------------------
// Draft persistence — text only
// ---------------------------------------------------------------------------

test('the draft is written under this feature key, for this capture only', () => {
  const h = harness();
  h.begin(['one']);
  const keys = [...h.storage.map.keys()];
  assert.deepEqual(keys, [draftKeyFor(WO, CAP)]);
  assert.equal(keys[0].indexOf(`${DRAFT_KEY_PREFIX}:`), 0);
});

test('the persisted draft contains no image bytes, blobs, data URLs, or object URLs', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const raw = h.storage.getItem(draftKeyFor(WO, CAP));
  for (const needle of ['blob:', 'data:', 'base64', 'ocr', 'archival', 'thumb', 'sourceFile', 'IMG_']) {
    assert.equal(raw.includes(needle), false, `draft must not contain "${needle}"`);
  }
});

test('the draft field inventory is exactly the approved text and metadata set', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const d = h.stored();
  assert.deepEqual(Object.keys(d).sort(),
    ['comments', 'documentCaptureId', 'pages', 'savedAt', 'step', 'v', 'workOrderId']);
  assert.deepEqual(Object.keys(d.pages[0]).sort(), ['pageId', 'pageNumber']);
  assert.deepEqual(Object.keys(d.comments[0]).sort(), [
    'aiGenerated', 'body', 'commentId', 'humanEdited', 'lowConfidenceRegions',
    'originalConfidence', 'pageIds', 'qualityTier', 'source', 'visibility',
  ]);
  assert.equal(d.v, DRAFT_SCHEMA_VERSION);
});

test('every review mutation rewrites the draft', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.editComment(id, 'changed');
  assert.equal(h.stored().comments[0].body, 'changed');
  h.ctl.setVisibility(id, 'public');
  assert.equal(h.stored().comments[0].visibility, 'public');
  h.ctl.moveComment(id, 1);
  assert.equal(h.stored().comments[1].body, 'changed');
});

test('the draft-write guard refuses image material even if a future edit leaks it in', () => {
  // A page id shaped like a data URL stands in for the class of mistake the
  // guard exists to catch: page material reaching the persisted payload.
  const h = harness();
  h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: [{ pageId: 'data:image/jpeg;base64,AAA', archival: { blob: { size: 1 }, width: 1, height: 1 } }],
    readingPages: [{ pageId: 'data:image/jpeg;base64,AAA', text: 'x', confidenceScore: 0.9, lowConfidenceRegions: [], qualityTier: 'standard' }],
  });
  assert.equal(h.ctl.getState().storageStatus, 'write_failed', 'nothing was written');
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.ctl.getState().comments.length, 1, 'the review itself is unaffected');
});

test('reviewer text that happens to contain "data:" or "base64" is still persisted', () => {
  const h = harness();
  h.begin(['one']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'see data:sheet base64 note on the invoice');
  assert.equal(h.stored().comments[0].body, 'see data:sheet base64 note on the invoice');
  assert.equal(h.ctl.getState().storageStatus, 'ok');
});

test('unavailable storage never takes the in-memory review with it', () => {
  const h = harness({ storage: null });
  h.begin(['one', 'two']);
  const s = h.ctl.getState();
  assert.equal(s.comments.length, 2);
  assert.equal(s.storageStatus, 'unavailable');
  assert.equal(s.storageMessage, MESSAGES.storageUnavailable);
  assert.equal(s.canConfirm, true, 'a device that cannot save a draft can still save the work');
});

test('a throwing storage is treated as unavailable, not as a crash', () => {
  const throwing = { get length() { return 0; }, key() { return null; },
    getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const h = harness({ storage: throwing });
  h.begin(['one']);
  assert.equal(h.ctl.getState().storageStatus, 'unavailable');
  assert.equal(h.ctl.getState().comments.length, 1);
});

test('a quota failure reports write_failed and loses no in-memory review state', () => {
  const s = makeStorage();
  s.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  const h = harness({ storage: s });
  h.begin(['one', 'two']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'still here');
  const st = h.ctl.getState();
  assert.equal(st.storageStatus, 'write_failed');
  assert.equal(st.storageMessage, MESSAGES.storageWriteFailed);
  assert.equal(st.comments[0].body, 'still here');
  assert.equal(st.canConfirm, true);
});

test('storage recovering from a quota failure clears the warning on the next write', () => {
  const store = makeStorage();
  const real = store.setItem.bind(store);
  let fail = true;
  store.setItem = (k, v) => { if (fail) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } real(k, v); };
  const h = harness({ storage: store });
  h.begin(['one']);
  assert.equal(h.ctl.getState().storageStatus, 'write_failed');
  fail = false;
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'now saved');
  assert.equal(h.ctl.getState().storageStatus, 'ok');
  assert.equal(h.stored().comments[0].body, 'now saved');
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function seedDraft(storage, over = {}, key) {
  const draft = {
    v: DRAFT_SCHEMA_VERSION, workOrderId: WO, documentCaptureId: CAP,
    pages: [{ pageId: 'p1', pageNumber: 1 }, { pageId: 'p2', pageNumber: 2 }],
    comments: [{
      commentId: 'kept-1', body: 'restored text', visibility: 'public', pageIds: ['p1', 'p2'],
      aiGenerated: true, qualityTier: 'strong', originalConfidence: 0.6,
      lowConfidenceRegions: [], humanEdited: true, source: 'document_photo_transcription',
    }],
    step: 'review', savedAt: 1_700_000_000_000, ...over,
  };
  storage.setItem(key || draftKeyFor(draft.workOrderId, draft.documentCaptureId), JSON.stringify(draft));
  return draft;
}

test('closing and reopening review finds the draft and restores it exactly', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl.editComment(id, 'edited before closing');
  h.ctl.setVisibility(id, 'public');
  h.ctl.closeReview();
  assert.equal(h.ctl.getState().status, 'idle');

  assert.equal(h.ctl.detectDraft(WO).found, true);
  assert.equal(h.ctl.getState().status, 'recovery');
  const r = h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: capturePages(2) });
  assert.equal(r.ok, true);
  assert.equal(r.identical, true);
  const s = h.ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.comments[0].body, 'edited before closing');
  assert.equal(s.comments[0].visibility, 'public');
  assert.equal(s.comments[0].humanEdited, true);
});

test('a restored draft keeps comment identity and order', () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: capturePages(2) });
  const s = h.ctl.getState();
  assert.equal(s.comments[0].commentId, 'kept-1');
  assert.equal(s.comments[0].qualityTier, 'strong');
});

test('a draft for another work order is never offered', () => {
  const h = harness();
  seedDraft(h.storage, { workOrderId: 'OTHER', documentCaptureId: CAP }, draftKeyFor('OTHER', CAP));
  assert.deepEqual(h.ctl.detectDraft(WO), { found: false });
});

test('a draft whose work order does not match is refused at bind time too', () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  const r = h.ctl.resumeDraft({ workOrderId: 'DIFFERENT', documentCaptureId: CAP, capturePages: capturePages(2) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_work_order');
  assert.equal(h.ctl.getState().status, 'recovery', 'nothing was bound');
});

test('a draft from a different capture cannot bind to the active capture', () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  const r = h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: 'cap-2', capturePages: capturePages(2) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_capture');
});

test('a malformed draft is reported as unusable, with a discard action available', () => {
  const h = harness();
  h.storage.setItem(draftKeyFor(WO, CAP), '{not json');
  const d = h.ctl.detectDraft(WO);
  assert.equal(d.found, true);
  assert.equal(d.usable, false);
  assert.equal(d.reason, 'malformed');
  assert.equal(h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: capturePages(2) }).ok, false);
  assert.equal(h.ctl.discardDraft({ force: true }).discarded, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a draft written by a different schema version is not restored', () => {
  const h = harness();
  seedDraft(h.storage, { v: 99 });
  assert.equal(h.ctl.detectDraft(WO).reason, 'schema_version');
});

test('an expired draft is not restored', () => {
  const h = harness({ clock: { t: 1_700_000_000_000 } });
  seedDraft(h.storage, { savedAt: 1_700_000_000_000 - (1000 * 60 * 60 * 24 * 8) });
  assert.equal(h.ctl.detectDraft(WO).reason, 'expired');
});

test('a draft with a mismatched page set restores the text but blocks saving', () => {
  const h = harness();
  seedDraft(h.storage);                       // references p1 and p2
  h.ctl.detectDraft(WO);
  const r = h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [capturePages(3)[2]] });
  assert.equal(r.ok, true);
  assert.equal(r.identical, false);
  assert.deepEqual(r.missingPageIds, ['p1', 'p2']);
  const s = h.ctl.getState();
  assert.equal(s.status, 'needs_reattach');
  assert.equal(s.canConfirm, false);
  assert.equal(s.comments[0].body, 'restored text');
});

test('a draft restored with no photos at all cannot be confirmed', async () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] });
  assert.equal(h.ctl.getState().restoredWithoutPhotos, true);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 0, 'no finalization was attempted');
});

test('explicit reattachment remaps a page and unblocks saving; no filename inference', async () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [{ pageId: 'p9', archival: { blob: { size: 1 }, width: 10, height: 10 } }] });
  assert.equal(h.ctl.getState().canConfirm, false);
  assert.equal(h.ctl.reattachPage('p1', 'p9').applied, true);
  const shared = h.ctl.reattachPage('p2', 'p9');
  assert.equal(shared.applied, false, 'many-to-one needs a separate approval');
  assert.equal(shared.requiresApproval, true);
  assert.equal(h.ctl.reattachPage('p2', 'p9', { allowShared: true }).applied, true);
  assert.equal(h.ctl.returnToReview().applied, true, 'RETURN TO REVIEW is the way back in');
  const s = h.ctl.getState();
  assert.deepEqual(s.comments[0].pageIds, ['p9']);
  assert.equal(s.canConfirm, true);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
});

test('reattaching to a page that is not in the capture is refused', () => {
  const h = harness();
  h.begin(['one', 'two']);
  assert.equal(h.ctl.reattachPage('p1', 'nope').applied, false);
});

test('discarding a recovered draft warns first and then removes only that key', () => {
  const h = harness();
  h.storage.setItem('dockside:unrelated', 'keep me');
  h.storage.setItem(`${DRAFT_KEY_PREFIX}:OTHERWO:cap-9`, 'another job');
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  const warn = h.ctl.discardDraft();
  assert.equal(warn.discarded, false);
  assert.equal(warn.requiresConfirm, true);
  assert.equal(warn.warning, MESSAGES.discardDraft);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null, 'the warning did not delete anything');

  assert.equal(h.ctl.discardDraft({ force: true }).discarded, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.storage.getItem('dockside:unrelated'), 'keep me');
  assert.equal(h.storage.getItem(`${DRAFT_KEY_PREFIX}:OTHERWO:cap-9`), 'another job');
});

test('detection ignores unrelated keys entirely', () => {
  const h = harness();
  h.storage.setItem('supabase.auth.token', 'x');
  h.storage.setItem('dockside:something-else', 'y');
  assert.deepEqual(h.ctl.detectDraft(WO), { found: false });
  assert.equal(h.storage.map.size, 2, 'nothing was removed');
});

// ---------------------------------------------------------------------------
// Capture changes during review
// ---------------------------------------------------------------------------

test('deleting a source page during review invalidates only the comments that used it', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  const s0 = h.ctl.getState();
  h.ctl.setCommentPages(s0.comments[0].commentId, ['p1']);
  h.ctl.setCommentPages(s0.comments[1].commentId, ['p2']);
  h.ctl.setCommentPages(s0.comments[2].commentId, ['p3']);
  const r = h.ctl.syncCapture([capturePages(3)[1], capturePages(3)[2]]);
  assert.deepEqual(r.removed, ['p1']);
  const s = h.ctl.getState();
  assert.equal(s.status, 'needs_reattach');
  assert.equal(s.comments[0].ok, false);
  assert.equal(s.comments[1].ok, true);
  assert.equal(s.comments[2].ok, true);
  assert.equal(s.canConfirm, false);
});

test('a page removed during review renumbers the survivors without changing identity', () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  h.ctl.syncCapture([capturePages(3)[0], capturePages(3)[2]]);
  assert.deepEqual(h.ctl.getState().pages, [
    { pageId: 'p1', pageNumber: 1, hasImage: true },
    { pageId: 'p3', pageNumber: 2, hasImage: true },
  ]);
});

test('narrowing a broken comment onto a surviving page is a valid way out', () => {
  const h = harness();
  h.begin(['one', 'two']);
  h.ctl.syncCapture([capturePages(2)[1]]);
  const id = h.ctl.getState().comments[0].commentId;
  assert.equal(h.ctl.getState().canConfirm, false);
  h.ctl.setCommentPages(id, ['p2']);
  h.ctl.setCommentPages(h.ctl.getState().comments[1].commentId, ['p2']);
  assert.equal(h.ctl.getState().canConfirm, true);
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

test('confirmation calls the Step 4 contract once, with reviewed order and page numbers', async () => {
  const h = harness();
  h.begin(['one', 'two']);
  const s0 = h.ctl.getState();
  h.ctl.setCommentPages(s0.comments[1].commentId, ['p2']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(h.calls.length, 1);
  const p = h.calls[0];
  assert.equal(p.workOrderId, WO);
  assert.equal(p.documentCaptureId, CAP);
  assert.deepEqual(p.pages.map((x) => x.pageNumber), [1, 2]);
  assert.deepEqual(p.comments.map((c) => c.sequence), [1, 2]);
  assert.deepEqual(p.comments[0].pageNumbers, [1, 2]);
  assert.deepEqual(p.comments[1].pageNumbers, [2]);
  assert.equal(p.author, AUTHOR);
  assert.equal(p.userId, AUTHOR.id);
});

test('the confirmation payload never carries image material or a capture blob', async () => {
  const h = harness();
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  const text = JSON.stringify(h.calls[0]);
  for (const needle of ['blob:', 'data:', 'base64', 'sourceFile', 'thumb']) {
    assert.equal(text.includes(needle), false, `payload must not contain "${needle}"`);
  }
});

test('a zero-page comment can never reach finalization', async () => {
  const h = harness();
  h.begin(['one']);
  const id = h.ctl.getState().comments[0].commentId;
  h.ctl._internals.buildPlan(AUTHOR, AUTHOR.id);              // sanity: a plan builds today
  h.ctl.setCommentPages(id, []);                              // refused
  h.ctl.syncCapture([]);                                      // pages vanish entirely
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 0);
  assert.ok(r.issues.some((i) => i.code === 'MISSING_PAGES' || i.code === 'NO_PAGES'));
});

test('an empty comment blocks confirmation with a named issue', async () => {
  const h = harness();
  h.begin(['one']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, '   ');
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'EMPTY_BODY');
  assert.equal(h.calls.length, 0);
});

test('pages are staged to Storage before finalization, one at a time, in page order', async () => {
  const h = harness();
  h.begin(['one', 'two', 'three']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.deepEqual(h.uploads, [1, 2, 3]);
  assert.equal(h.calls.length, 1);
});

test('an upload failure stops before finalization and keeps the draft', async () => {
  const h = harness({ uploadPage: async (page) => {
    if (page.pageNumber === 2) throw Object.assign(new Error('network'), { code: 'OFFLINE' });
  } });
  h.begin(['one', 'two', 'three']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upload_failed');
  assert.equal(r.pageNumber, 2);
  assert.equal(h.calls.length, 0, 'no database write was attempted');
  assert.deepEqual(h.uploads, [1, 2], 'page 3 was never uploaded');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.ctl.getState().error, MESSAGES.offline);
  assert.equal(h.ctl.getState().canRetryConfirm, true);
});

test('a retry after an upload failure re-stages every page and then finalizes', async () => {
  let fail = true;
  const h = harness({ uploadPage: async (page) => {
    if (fail && page.pageNumber === 2) throw new Error('network');
  } });
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  fail = false;
  const r = await h.ctl.retryConfirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.deepEqual(h.uploads, [1, 2, 1, 2], 'deterministic paths + upsert make the re-upload safe');
  assert.equal(h.calls.length, 1);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('progress is reported per page and per phase, never as a percentage', async () => {
  const h = harness();
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  const labels = [...new Set(h.emissions.map((s) => s.progress).filter(Boolean))];
  assert.deepEqual(labels, ['Uploading page 1 of 2', 'Uploading page 2 of 2', 'Saving reviewed comments']);
  for (const l of labels) assert.equal(/%/.test(l), false);
  assert.equal(h.ctl.getState().progress, '');
});

test('a double confirm tap uploads and finalizes exactly once', async () => {
  let gateRelease;
  const gate = new Promise((r) => { gateRelease = r; });
  const h = harness({ uploadPage: async () => gate });
  h.begin(['one', 'two']);
  const first = h.ctl.confirm({ author: AUTHOR });
  const second = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(second.reason, 'in_flight');
  gateRelease();
  assert.equal((await first).ok, true);
  assert.deepEqual(h.uploads, [1, 2]);
  assert.equal(h.calls.length, 1);
});

test('a double confirm tap performs exactly one finalization', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ finalize: async (payload) => { await gate; return {
    photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map((c, i) => ({ id: `a${i}` })) }; } });
  h.begin(['one']);
  const first = h.ctl.confirm({ author: AUTHOR });
  const second = h.ctl.confirm({ author: AUTHOR });
  assert.deepEqual(await second, { ok: false, reason: 'in_flight' });
  release();
  assert.equal((await first).ok, true);
  assert.equal(h.calls.length, 1);
});

test('confirmation is refused while in flight even after a re-render reads canConfirm', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ finalize: async (payload) => { await gate; return {
    photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'a' })) }; } });
  h.begin(['one']);
  const run = h.ctl.confirm({ author: AUTHOR });
  const mid = h.ctl.getState();
  assert.equal(mid.status, 'confirming');
  assert.equal(mid.confirmInFlight, true);
  assert.equal(mid.canConfirm, false);
  release();
  await run;
});

test('a failed finalization keeps the draft and offers a retry', async () => {
  let attempt = 0;
  const h = harness({ finalize: async (payload) => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error('network down'), { code: 'OFFLINE' });
    return { photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'a' })) };
  } });
  h.begin(['one']);
  const first = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(h.ctl.getState().status, 'failed');
  assert.equal(h.ctl.getState().error, MESSAGES.offline);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null, 'the reviewed draft is retained');
  assert.equal(h.ctl.getState().canRetryConfirm, true);

  const second = await h.ctl.retryConfirm({ author: AUTHOR });
  assert.equal(second.ok, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null, 'cleared only after verified success');
});

test('a retry after failure sends the same capture id and the same reviewed text', async () => {
  let attempt = 0;
  const h = harness({ finalize: async (payload) => {
    attempt += 1;
    if (attempt === 1) throw new Error('boom');
    return { photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'a' })) };
  } });
  h.begin(['one']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'reviewed wording');
  await h.ctl.confirm({ author: AUTHOR });
  await h.ctl.retryConfirm({ author: AUTHOR });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].documentCaptureId, h.calls[1].documentCaptureId);
  assert.equal(h.calls[1].comments[0].body, 'reviewed wording');
});

test('an ambiguous failure that actually saved is resolved by an idempotent retry', async () => {
  // First attempt reaches the database and then the connection drops; the second
  // attempt hits Step 4's 23505 recovery path and reports the existing rows.
  let attempt = 0;
  const h = harness({ finalize: async (payload) => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error('connection lost'), { ambiguous: true });
    return {
      photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
      activities: payload.comments.map(() => ({ id: 'ac' })),
      photosExisted: true, activitiesExisted: true,
    };
  } });
  h.begin(['one', 'two']);
  const first = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(first.ok, false);
  assert.equal(h.ctl.getState().error, MESSAGES.ambiguous);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);

  const second = await h.ctl.retryConfirm({ author: AUTHOR });
  assert.equal(second.ok, true);
  assert.equal(second.alreadySaved, true);
  assert.equal(h.ctl.getState().status, 'confirmed');
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a partial finalization result is treated as unverified: draft kept, retry offered', async () => {
  let attempt = 0;
  const h = harness({ finalize: async (payload) => {
    attempt += 1;
    return attempt === 1
      ? { photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: [{ id: 'ac-1' }] }   // 1 of 2
      : { photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'ac' })) };
  } });
  h.begin(['one', 'two']);
  const first = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'unverified');
  assert.equal(first.saved, 1);
  assert.equal(first.expected, 2);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal((await h.ctl.retryConfirm({ author: AUTHOR })).ok, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a failure with storage unavailable still keeps the review in memory and retryable', async () => {
  let attempt = 0;
  const h = harness({ storage: null, finalize: async (payload) => {
    attempt += 1;
    if (attempt === 1) throw new Error('boom');
    return { photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'a' })) };
  } });
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.ctl.getState().comments[0].body, 'one');
  assert.equal((await h.ctl.retryConfirm({ author: AUTHOR })).ok, true);
});

test('visibility choices survive confirmation exactly as set', async () => {
  const h = harness();
  h.begin(['public one', 'private two']);
  const s0 = h.ctl.getState();
  h.ctl.setVisibility(s0.comments[0].commentId, 'public');
  await h.ctl.confirm({ author: AUTHOR });
  assert.deepEqual(h.calls[0].comments.map((c) => c.visibility), ['public', 'private']);
});

test('AI-derived text stays AI-attributed after human review, with the reviewed body saved', async () => {
  const h = harness();
  h.begin(['machine reading']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'human corrected reading');
  await h.ctl.confirm({ author: AUTHOR });
  const c = h.calls[0].comments[0];
  assert.equal(c.aiGenerated, true);
  assert.equal(c.qualityTier, 'standard');
  assert.equal(c.body, 'human corrected reading');
});

// Replaces 'manual entry after complete AI failure ...'. A total no-text result
// now refuses beginReview() and mutates no state, so there is no review to type
// into on that path. Manual provenance is still covered — through the ordinary
// added-comment workflow, which is where manual typing lives.
test('a manually added comment is saved with manual provenance and no tier', async () => {
  const h = harness();
  h.begin(['a page that read fine']);
  const manual = h.ctl.addComment().commentId;
  h.ctl.editComment(manual, 'typed from the paper');
  await h.ctl.confirm({ author: AUTHOR });
  const c = h.calls[0].comments.find((x) => x.body === 'typed from the paper');
  assert.ok(c, 'the manual comment was submitted');
  assert.equal(c.aiGenerated, false);
  assert.equal(c.qualityTier, null);
  assert.equal(c.originalConfidence, 0);
});

test('no test path can open a review from zero transcribed pages', () => {
  const h = harness();
  for (const readingPages of [
    [],
    [{ pageId: 'p1', text: '', state: 'failed' }],
    [{ pageId: 'p1', text: null, state: 'failed' }, { pageId: 'p2', text: '  ', state: 'ready' }],
  ]) {
    const r = h.ctl.beginReview({
      workOrderId: WO, documentCaptureId: CAP,
      capturePages: capturePages(readingPages.length || 1),
      readingPages,
    });
    assert.equal(r.ok, false, JSON.stringify(readingPages));
    assert.equal(r.reason, 'no_transcribed_text');
    assert.equal(h.ctl.getState().status, 'idle');
    assert.equal(h.ctl.getState().comments.length, 0);
  }
});

test('a strong-tier page keeps its tier through review and confirmation', async () => {
  const h = harness();
  h.ctl.beginReview({
    workOrderId: WO, documentCaptureId: CAP, capturePages: capturePages(1),
    readingPages: readingPages(['strong reading'], { p1: { qualityTier: 'strong' } }),
  });
  await h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.calls[0].comments[0].qualityTier, 'strong');
});

test('confirming twice in sequence does not re-finalize after success', async () => {
  const h = harness();
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  const again = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(again.ok, false);
  assert.equal(h.calls.length, 1);
});

test('the confirmed state is terminal for this capture and clears no unrelated key', async () => {
  const h = harness();
  h.storage.setItem('dockside:unrelated', 'keep me');
  h.storage.setItem(`${DRAFT_KEY_PREFIX}:${WO}:cap-other`, 'another capture');
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.ctl.getState().status, 'confirmed');
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.storage.getItem('dockside:unrelated'), 'keep me');
  assert.equal(h.storage.getItem(`${DRAFT_KEY_PREFIX}:${WO}:cap-other`), 'another capture');
});

// ---------------------------------------------------------------------------
// Lifecycle and reachable states
// ---------------------------------------------------------------------------

test('every reachable status has a callable action out', async () => {
  const api = createReviewController({ storage: makeStorage(), finalize: async () => ({ photos: [{ documentCaptureId: CAP, documentPageNumber: 1 }], activities: [{}] }) });
  const exits = {
    idle: ['beginReview', 'detectDraft'],
    recovery: ['resumeDraft', 'discardDraft'],
    review: ['confirm', 'backToCapture', 'closeReview'],
    needs_reattach: ['reattachPage', 'setCommentPages', 'discardDraft', 'closeReview'],
    confirming: ['getState'],
    confirmed: ['closeReview'],
    failed: ['retryConfirm', 'closeReview'],
  };
  for (const [state, actions] of Object.entries(exits)) {
    for (const name of actions) {
      assert.equal(typeof api[name], 'function', `${state} needs ${name}`);
    }
  }
});

test('backToCapture keeps the draft and is refused mid-finalization', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ finalize: async (payload) => { await gate; return {
    photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })), activities: payload.comments.map(() => ({ id: 'a' })) }; } });
  h.begin(['one']);
  assert.equal(h.ctl.backToCapture().applied, true);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  h.begin(['one']);
  const run = h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.ctl.backToCapture().reason, 'in_flight');
  release();
  await run;
});

test('closeReview leaves the draft in place for the next visit', () => {
  const h = harness();
  h.begin(['one']);
  h.ctl.closeReview();
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.ctl.getState().status, 'idle');
  assert.equal(h.ctl.getState().comments.length, 0);
});

test('the module exposes no storage, transcription, or database entry point of its own', () => {
  const api = createReviewController({ storage: makeStorage(), finalize: async () => ({}) });
  assert.deepEqual(Object.keys(api).sort(), [
    '_internals', 'addComment', 'backToCapture', 'beginReview', 'closeReview', 'confirm',
    'deleteComment', 'detectDraft', 'discardDraft', 'editComment', 'getState', 'mergeCommentUp',
    'moveComment', 'reattachPage', 'resumeDraft', 'retryConfirm', 'returnToReview',
    'setCommentPages', 'setVisibility', 'splitComment', 'syncCapture', 'toggleCommentPage',
  ]);
});

test('the source contains no executable network, Supabase, transcription, or image reference', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../document-review-draft.js', import.meta.url), 'utf8');
  // Comments are prose and may legitimately name what this module must NOT do.
  // The boundary under test is executable code, so strip comments first.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  for (const banned of ['supabase', 'netlify/functions', 'fetch(', 'XMLHttpRequest',
    'createObjectURL', 'toDataURL', 'FileReader', 'indexeddb', '\nimport ']) {
    assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false, 'must not reference ' + banned);
  }
  assert.equal(/createReviewController\(deps\)/.test(code), true, 'every side effect stays injected');
});

test('every state emission is a plain serializable snapshot', () => {
  const h = harness();
  h.begin(['one', 'two']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'x');
  assert.ok(h.emissions.length > 1);
  for (const s of h.emissions) {
    const text = JSON.stringify(s);
    assert.equal(text.includes('blob:'), false);
    assert.equal(text.includes('base64'), false);
  }
});

// ---------------------------------------------------------------------------
// The confirmation lock
// ---------------------------------------------------------------------------

// Holds the confirmation open at a chosen phase so mutations can be attempted
// while it is genuinely in flight.
function gatedHarness(phase) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    uploadPage: phase === 'upload' ? async () => gate : undefined,
    finalize: async (payload) => {
      if (phase === 'finalize') await gate;
      return {
        photos: payload.pages.map((p) => ({ id: 'ph', documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
        activities: payload.comments.map(() => ({ id: 'ac' })),
      };
    },
  });
  return { h, release: () => release() };
}

const mutationAttempts = (ctl, commentId) => ({
  editComment: ctl.editComment(commentId, 'sneaky edit'),
  setVisibility: ctl.setVisibility(commentId, 'public'),
  splitComment: ctl.splitComment(commentId, 3),
  mergeCommentUp: ctl.mergeCommentUp(commentId),
  moveComment: ctl.moveComment(commentId, 1),
  deleteComment: ctl.deleteComment(commentId, { force: true }),
  addComment: ctl.addComment(),
  setCommentPages: ctl.setCommentPages(commentId, ['p1']),
  toggleCommentPage: ctl.toggleCommentPage(commentId, 'p1'),
  reattachPage: ctl.reattachPage('p1', 'p2'),
  returnToReview: ctl.returnToReview(),
  backToCapture: ctl.backToCapture(),
  closeReview: ctl.closeReview(),
});

test('every review mutation is refused while pages are uploading', async () => {
  const { h, release } = gatedHarness('upload');
  h.begin(['one', 'two']);
  const before = JSON.stringify(h.ctl.getState().comments);
  const run = h.ctl.confirm({ author: AUTHOR });
  await Promise.resolve();
  const attempts = mutationAttempts(h.ctl, h.ctl.getState().comments[0].commentId);
  for (const [name, r] of Object.entries(attempts)) {
    assert.equal(r.applied, false, name + ' must be refused');
    assert.equal(r.reason, 'in_flight', name + ' must report in_flight');
  }
  assert.equal(h.ctl.getState().confirmInFlight, true);
  assert.equal(JSON.stringify(h.ctl.getState().comments), before, 'nothing changed');
  release();
  assert.equal((await run).ok, true);
  assert.equal(h.calls[0].comments[0].body, 'one', 'the validated text is what was saved');
});

test('every review mutation is refused while finalization is in flight', async () => {
  const { h, release } = gatedHarness('finalize');
  h.begin(['one', 'two']);
  const run = h.ctl.confirm({ author: AUTHOR });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const attempts = mutationAttempts(h.ctl, h.ctl.getState().comments[0].commentId);
  for (const [name, r] of Object.entries(attempts)) {
    assert.equal(r.reason, 'in_flight', name + ' must report in_flight');
  }
  release();
  assert.equal((await run).ok, true);
});

test('capture synchronisation is refused mid-save and cannot drop a planned page', async () => {
  const { h, release } = gatedHarness('upload');
  h.begin(['one', 'two']);
  const run = h.ctl.confirm({ author: AUTHOR });
  await Promise.resolve();
  const r = h.ctl.syncCapture([]);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'in_flight');
  assert.equal(h.ctl.getState().pages.length, 2);
  release();
  await run;
  assert.deepEqual(h.uploads, [1, 2]);
  assert.deepEqual(h.calls[0].pages.map((p) => p.pageNumber), [1, 2]);
});

test('teardown is refused mid-save, so the confirmation cannot lose its session', async () => {
  const { h, release } = gatedHarness('finalize');
  h.begin(['one']);
  const run = h.ctl.confirm({ author: AUTHOR });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.ctl.closeReview().reason, 'in_flight');
  assert.equal(h.ctl.getState().status, 'confirming');
  assert.equal(h.ctl.getState().documentCaptureId, CAP);
  release();
  assert.equal((await run).ok, true);
  assert.equal(h.ctl.getState().status, 'confirmed');
});

test('discard, resume, and a fresh beginReview are refused mid-save', async () => {
  const { h, release } = gatedHarness('upload');
  h.begin(['one']);
  const run = h.ctl.confirm({ author: AUTHOR });
  await Promise.resolve();
  assert.equal(h.ctl.discardDraft({ force: true }).reason, 'in_flight');
  assert.equal(h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] }).reason, 'in_flight');
  assert.equal(h.ctl.beginReview({ workOrderId: 'OTHER', documentCaptureId: 'x', capturePages: [], readingPages: [] }).reason, 'in_flight');
  release();
  await run;
});

// ---------------------------------------------------------------------------
// The immutable confirmation plan
// ---------------------------------------------------------------------------

test('the confirmation plan is deep-frozen', () => {
  const h = harness();
  h.begin(['one', 'two']);
  const plan = h.ctl._internals.buildPlan(AUTHOR, AUTHOR.id);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.comments[0]), true);
  assert.equal(Object.isFrozen(plan.pages[0]), true);
  assert.throws(() => { plan.comments[0].body = 'tampered'; }, TypeError);
});

test('every upload carries the plan identity, handed in rather than re-derived', async () => {
  const seen = [];
  const h = harness({ uploadPage: async (page) => { seen.push({ ...page }); } });
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.deepEqual(seen.map((x) => x.pageNumber), [1, 2]);
  for (const x of seen) {
    assert.equal(x.workOrderId, WO);
    assert.equal(x.documentCaptureId, CAP);
    assert.equal(x.totalPages, 2);
    assert.ok(x.pageId);
  }
});

test('a host that changes its own references mid-save cannot retarget the write', async () => {
  const hostState = { workOrderId: WO, captureId: CAP };
  const seen = [];
  const h = harness({ uploadPage: async (page) => {
    hostState.workOrderId = 'DIFFERENT-JOB';   // the mechanic switched jobs
    hostState.captureId = 'cap-999';           // and reopened the capture
    seen.push(page);
  } });
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  for (const x of seen) {
    assert.equal(x.workOrderId, WO);
    assert.equal(x.documentCaptureId, CAP);
  }
  assert.equal(h.calls[0].workOrderId, WO);
  assert.equal(h.calls[0].documentCaptureId, CAP);
});

// ---------------------------------------------------------------------------
// Verified success: photos as well as activities
// ---------------------------------------------------------------------------

test('a short photo result is unverified and keeps the draft', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: [{ id: 'ph-1' }],                                  // 1 of 2
    activities: payload.comments.map(() => ({ id: 'ac' })),
  }) });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unverified');
  assert.equal(r.detail, 'photo_count');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('duplicate photo page numbers are unverified', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: [{ document_page_number: 1, document_capture_id: CAP }, { document_page_number: 1, document_capture_id: CAP }],
    activities: payload.comments.map(() => ({ id: 'ac' })),
  }) });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.detail, 'duplicate_page');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('photo page numbers that do not match the plan are unverified', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: [{ document_page_number: 1, document_capture_id: CAP }, { document_page_number: 4, document_capture_id: CAP }],
    activities: payload.comments.map(() => ({ id: 'ac' })),
  }) });
  h.begin(['one', 'two']);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).detail, 'photo_page_identity');
});

test('a row from another capture is unverified', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map((p) => ({ document_page_number: p.pageNumber, document_capture_id: 'cap-other' })),
    activities: payload.comments.map(() => ({ id: 'ac' })),
  }) });
  h.begin(['one']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.detail, 'capture_identity');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a matching, fully identified result is accepted and clears the draft', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map((p) => ({ document_page_number: p.pageNumber, document_capture_id: payload.documentCaptureId })),
    activities: payload.comments.map((c) => ({ id: 'ac-' + c.sequence, document_capture_id: payload.documentCaptureId })),
  }) });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(r.photos, 2);
  assert.equal(r.activities, 2);
  assert.equal(r.documentCaptureId, CAP);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

// ---------------------------------------------------------------------------
// Reattachment state stays honest
// ---------------------------------------------------------------------------

const livePage = (pageId) => ({ pageId, archival: { blob: { size: 1 }, width: 9, height: 9 }, thumb: { url: 'blob:' + pageId } });

test('partial mapping stays blocked; complete mapping clears the warning and enables saving', () => {
  const h = harness();
  seedDraft(h.storage);                              // references p1 and p2
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] });
  assert.equal(h.ctl.getState().restoredWithoutPhotos, true);

  h.ctl.syncCapture([livePage('n1'), livePage('n2')]);   // 5A onChange after re-selection
  let s = h.ctl.getState();
  assert.deepEqual(s.missingPageIds, ['p1', 'p2']);
  assert.deepEqual(s.reattachCandidates.map((p) => p.pageId), ['n1', 'n2']);
  assert.equal(s.canConfirm, false);

  const first = h.ctl.reattachPage('p1', 'n1');
  assert.equal(first.applied, true);
  assert.equal(first.complete, false);
  s = h.ctl.getState();
  assert.equal(s.status, 'needs_reattach', 'still blocked with one page unmapped');
  assert.equal(s.restoredWithoutPhotos, true);
  assert.equal(s.canConfirm, false);

  const second = h.ctl.reattachPage('p2', 'n2');
  assert.equal(second.complete, true);
  assert.equal(h.ctl.getState().canReturnToReview, true);
  h.ctl.returnToReview();
  s = h.ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.restoredWithoutPhotos, false, 'the warning is recomputed, not remembered');
  assert.equal(s.reattachMessage, '');
  assert.equal(s.canConfirm, true);
});

test('removing a mapped page blocks confirmation again', () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] });
  h.ctl.syncCapture([livePage('n1'), livePage('n2')]);
  h.ctl.reattachPage('p1', 'n1');
  h.ctl.reattachPage('p2', 'n2');
  h.ctl.returnToReview();
  assert.equal(h.ctl.getState().canConfirm, true);
  h.ctl.syncCapture([livePage('n1')]);                // the mechanic removes n2
  const s = h.ctl.getState();
  assert.equal(s.status, 'needs_reattach');
  assert.equal(s.canConfirm, false);
  assert.deepEqual(s.missingPageIds, ['n2']);
});

test('mapping onto a placeholder page with no image is refused', () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] });
  h.ctl.syncCapture([{ pageId: 'n1', hasImage: false }]);
  assert.equal(h.ctl.reattachPage('p1', 'n1').reason, 'unknown_page');
});

// ---------------------------------------------------------------------------
// End-to-end against the documented handler sequence
// ---------------------------------------------------------------------------

// Mirrors index-5c-edits.md: a provisional capture id on open, the recovered id
// adopted on RESUME, one adapter that is handed identity per call.
function fakeHost(storage) {
  let n = 0;
  const host = { workOrderId: WO, captureId: null, capturePages: [], uploads: [], finalized: [], nextCapture: 0, state: null };
  const ctl = createReviewController({
    storage,
    now: () => 1700000000000,
    newId: () => 'c' + (++n),
    uploadPage: async ({ pageId, pageNumber, workOrderId, documentCaptureId }) => {
      const page = host.capturePages.find((p) => p.pageId === pageId);
      if (!page) throw new Error('Page ' + pageNumber + ' is no longer available.');
      host.uploads.push({ workOrderId, documentCaptureId, pageNumber, pageId });
    },
    finalize: async (payload) => {
      host.finalized.push(payload);
      return {
        photos: payload.pages.map((p) => ({ document_page_number: p.pageNumber, document_capture_id: payload.documentCaptureId })),
        activities: payload.comments.map((c) => ({ id: 'ac-' + c.sequence, document_capture_id: payload.documentCaptureId })),
      };
    },
    onChange: (s) => { host.state = s; },
  });
  host.ctl = ctl;
  host.openDocCapture = () => {
    host.captureId = 'provisional-' + (++host.nextCapture);   // 5A mints one on open
    host.capturePages = [];
    return ctl.detectDraft(host.workOrderId);
  };
  // RESUME REVIEW reopens the capture under the RECOVERED id before binding.
  host.resumeDocDraft = () => {
    const rec = ctl.getState().recovery;
    if (!rec || !rec.usable) return { ok: false };
    host.captureId = rec.documentCaptureId;
    host.capturePages = [];
    return ctl.resumeDraft({ workOrderId: host.workOrderId, documentCaptureId: host.captureId, capturePages: host.capturePages });
  };
  host.pickPages = (pageIds) => {
    host.capturePages = pageIds.map(livePage);
    return ctl.syncCapture(host.capturePages);                // the 5A onChange line
  };
  host.confirm = () => ctl.confirm({ author: AUTHOR });
  return host;
}

test('the documented handler sequence resumes under the recovered capture id, never the provisional one', async () => {
  const storage = makeStorage();
  seedDraft(storage);                                        // capture CAP, pages p1 and p2
  const host = fakeHost(storage);

  const found = host.openDocCapture();
  assert.equal(found.usable, true);
  assert.equal(found.documentCaptureId, CAP);
  assert.notEqual(host.captureId, CAP, 'a provisional id exists at this point');

  const resumed = host.resumeDocDraft();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.documentCaptureId, CAP);
  assert.equal(host.captureId, CAP, 'the host switched to the recovered capture');
  assert.equal(host.ctl.getState().documentCaptureId, CAP);

  host.pickPages(['n1', 'n2']);
  assert.equal(host.ctl.getState().canConfirm, false);
  host.ctl.reattachPage('p1', 'n1');
  host.ctl.reattachPage('p2', 'n2');
  host.ctl.returnToReview();
  assert.equal(host.ctl.getState().canConfirm, true);

  const r = await host.confirm();
  assert.equal(r.ok, true);
  for (const u of host.uploads) assert.equal(u.documentCaptureId, CAP);
  assert.deepEqual(host.uploads.map((u) => u.pageId), ['n1', 'n2']);
  assert.equal(host.finalized.length, 1);
  assert.equal(host.finalized[0].documentCaptureId, CAP);
  assert.deepEqual(host.finalized[0].comments[0].pageNumbers, [1, 2]);
  assert.equal(storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a provisional capture id is never accepted as the recovered one', () => {
  const storage = makeStorage();
  seedDraft(storage);
  const host = fakeHost(storage);
  host.openDocCapture();
  const wrong = host.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: host.captureId, capturePages: [] });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'wrong_capture');
  const nullId = host.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: null, capturePages: [] });
  assert.equal(nullId.reason, 'capture_id_required', 'a null id must not silently adopt the draft id');
});

test('PAGES then RETURN TO REVIEW keeps the restored review instead of re-deriving it', () => {
  const storage = makeStorage();
  seedDraft(storage);
  const host = fakeHost(storage);
  host.openDocCapture();
  host.resumeDocDraft();
  host.pickPages(['n1']);
  host.ctl.reattachPage('p1', 'n1');
  host.ctl.reattachPage('p2', 'n1', { allowShared: true });
  host.ctl.returnToReview();
  host.ctl.editComment(host.ctl.getState().comments[0].commentId, 'restored and then edited');

  assert.equal(host.ctl.backToCapture().applied, true);
  assert.equal(host.ctl.getState().status, 'idle');
  assert.equal(host.ctl.getState().canReturnToReview, true);
  host.pickPages(['n1', 'n2']);

  assert.equal(host.ctl.returnToReview().applied, true);
  const s = host.ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0].body, 'restored and then edited');
  assert.equal(s.canConfirm, true);
});

test('a resumed draft survives a second close and re-detection under its own capture id', () => {
  const storage = makeStorage();
  seedDraft(storage);
  const host = fakeHost(storage);
  host.openDocCapture();
  host.resumeDocDraft();
  host.pickPages(['n1']);
  host.ctl.reattachPage('p1', 'n1');
  host.ctl.reattachPage('p2', 'n1', { allowShared: true });
  host.ctl.returnToReview();
  host.ctl.editComment(host.ctl.getState().comments[0].commentId, 'second session text');
  host.ctl.closeReview();

  const found = host.openDocCapture();
  assert.equal(found.documentCaptureId, CAP, 'still the original capture id');
  assert.deepEqual(found.pageIds, ['n1'], 'the draft records the reattached page identity');
  host.resumeDocDraft();
  host.pickPages(['n1']);
  host.ctl.returnToReview();
  const s = host.ctl.getState();
  assert.equal(s.comments[0].body, 'second session text');
  assert.equal(s.canConfirm, true);
});

// ---------------------------------------------------------------------------
// Revision 108 — the recovery return path, unusable drafts, revision-96 row
// shapes, the review-status guard, and the upload adapter's identity check
// ---------------------------------------------------------------------------

test('a recovered draft without photos lands away at PAGES with RETURN TO REVIEW reachable', () => {
  const storage = makeStorage();
  seedDraft(storage);
  const host = fakeHost(storage);
  host.openDocCapture();
  const r = host.resumeDocDraft();
  assert.equal(r.ok, true);
  assert.equal(r.needsReattach, true);
  const s0 = host.ctl.getState();
  assert.equal(s0.status, 'needs_reattach', 'the matching panel is the state, shown on the PAGES step');
  assert.equal(s0.canConfirm, false, 'and saving is not possible from here');
  assert.equal(s0.canReturnToReview, true, 'RETURN TO REVIEW must be offered immediately');
  assert.equal(s0.needsReattach, true, 'and the matching panel is shown alongside it');
  assert.equal(s0.comments.length, 1, 'nothing was discarded');
});

test('the documented recovery order restores, matches, returns, and confirms without beginReview', async () => {
  const storage = makeStorage();
  seedDraft(storage);                                    // capture CAP, pages p1 and p2
  const host = fakeHost(storage);

  const found = host.openDocCapture();                   // 1. detect
  assert.equal(found.documentCaptureId, CAP);
  const resumed = host.resumeDocDraft();                 // 2 + 3. switch identity, resume
  assert.equal(resumed.ok, true);
  assert.equal(host.captureId, CAP);
  assert.equal(host.ctl.getState().status, 'needs_reattach');   // 4. landed on PAGES
  const originalIds = host.ctl.getState().comments.map((c) => c.commentId);
  const originalText = host.ctl.getState().comments.map((c) => c.body);

  host.pickPages(['n1', 'n2']);                          // 5. add replacements
  assert.equal(host.ctl.getState().canReturnToReview, true);
  host.ctl.reattachPage('p1', 'n1');
  host.ctl.reattachPage('p2', 'n2');
  assert.deepEqual(host.ctl.getState().missingPageIds, []);
  assert.equal(host.ctl.getState().canReturnToReview, true);   // 6.

  assert.equal(host.ctl.returnToReview().applied, true);       // 7.
  const s1 = host.ctl.getState();
  assert.equal(s1.status, 'review');                           // 8.
  assert.deepEqual(s1.comments.map((c) => c.commentId), originalIds);
  assert.deepEqual(s1.comments.map((c) => c.body), originalText);
  assert.deepEqual(s1.comments.map((c) => c.sequence), [1]);
  assert.equal(s1.comments[0].visibility, 'public', 'the restored visibility choice survived');
  assert.equal(s1.canConfirm, true);

  const done = await host.confirm();                           // 9.
  assert.equal(done.ok, true);
  assert.equal(host.finalized[0].documentCaptureId, CAP);
  assert.equal(storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a resumed draft whose pages are all present goes straight into review', () => {
  const h = harness();
  h.begin(['one', 'two']);
  h.ctl.closeReview();
  h.ctl.detectDraft(WO);
  const r = h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: capturePages(2) });
  assert.equal(r.needsReattach, false);
  assert.equal(h.ctl.getState().status, 'review');
  assert.equal(h.ctl.getState().canConfirm, true);
});

test('an unusable draft is still exposed for the UI, with a callable discard', () => {
  const h = harness();
  h.storage.setItem('dockside:unrelated', 'keep me');
  h.storage.setItem(draftKeyFor(WO, CAP), '{not json');
  h.ctl.detectDraft(WO);
  const rec = h.ctl.getState().recovery;
  assert.notEqual(rec, null, 'the panel must be renderable');
  assert.equal(rec.usable, false);
  assert.equal(rec.reason, 'malformed');
  assert.equal(h.ctl.getState().status, 'recovery');
  const warn = h.ctl.discardDraft();
  assert.equal(warn.requiresConfirm, true);
  assert.equal(h.ctl.discardDraft({ force: true }).discarded, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.storage.getItem('dockside:unrelated'), 'keep me');
  assert.equal(h.ctl.getState().status, 'idle');
});

test('an expired draft is exposed as unusable rather than hidden', () => {
  const h = harness();
  seedDraft(h.storage, { savedAt: 1_700_000_000_000 - (1000 * 60 * 60 * 24 * 8) });
  h.ctl.detectDraft(WO);
  const rec = h.ctl.getState().recovery;
  assert.equal(rec.usable, false);
  assert.equal(rec.reason, 'expired');
  assert.equal(h.ctl.resumeDraft({ workOrderId: WO, documentCaptureId: CAP, capturePages: [] }).ok, false);
});

// Shaped exactly like revision 96's converters, not generic fixtures.
const rev96Photo = (captureId, pageNumber) => ({
  id: 'photo-' + pageNumber, workOrderId: WO, storagePath: WO + '/' + captureId + '-p' + pageNumber + '-orig.jpg',
  thumbPath: WO + '/' + captureId + '-p' + pageNumber + '-thumb.jpg', customerVisible: false, photoType: 'document',
  categories: ['Document'], documentCaptureId: captureId, documentPageNumber: pageNumber,
});
const rev96Activity = (captureId, sequence) => ({
  id: 'activity-' + sequence, activityType: 'document_transcription', documentCaptureId: captureId,
  commentSequence: sequence, aiGenerated: true,
});

test('revision 96 converter rows verify on their own field names', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map((p) => rev96Photo(payload.documentCaptureId, p.pageNumber)),
    activities: payload.comments.map((c) => rev96Activity(payload.documentCaptureId, c.sequence)),
  }) });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(r.photos, 2);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('revision 96 rows with a swapped page number are caught', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: [rev96Photo(payload.documentCaptureId, 1), rev96Photo(payload.documentCaptureId, 3)],
    activities: payload.comments.map((c) => rev96Activity(payload.documentCaptureId, c.sequence)),
  }) });
  h.begin(['one', 'two']);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).detail, 'photo_page_identity');
});

test('a photo row with no page identity fails closed instead of skipping the check', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map(() => ({ id: 'ph', documentCaptureId: payload.documentCaptureId })),
    activities: payload.comments.map((c) => rev96Activity(payload.documentCaptureId, c.sequence)),
  }) });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.detail, 'photo_page_identity_missing');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('a photo row with no capture identity fails closed', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map((p) => ({ id: 'ph', documentPageNumber: p.pageNumber })),
    activities: payload.comments.map((c) => rev96Activity(payload.documentCaptureId, c.sequence)),
  }) });
  h.begin(['one']);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).detail, 'photo_capture_identity_missing');
});

test('an activity row from another capture is caught', async () => {
  const h = harness({ finalize: async (payload) => ({
    photos: payload.pages.map((p) => rev96Photo(payload.documentCaptureId, p.pageNumber)),
    activities: payload.comments.map((c) => rev96Activity('cap-other', c.sequence)),
  }) });
  h.begin(['one']);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).detail, 'capture_identity');
});

test('confirmation is refused from the PAGES step', async () => {
  const h = harness();
  h.begin(['one']);
  h.ctl.backToCapture();
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_in_review');
  assert.equal(h.uploads.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ctl.returnToReview().applied, true);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).ok, true);
});

test('confirmation is refused during recovery and after close', async () => {
  const h = harness();
  seedDraft(h.storage);
  h.ctl.detectDraft(WO);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).reason, 'no_session');
  h.begin(['one']);
  h.ctl.closeReview();
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).reason, 'no_session');
  assert.equal(h.uploads.length, 0);
});

test('a retry is still allowed from the failed state', async () => {
  let a = 0;
  const h = harness({ finalize: async (payload) => {
    a += 1;
    if (a === 1) throw new Error('boom');
    return {
      photos: payload.pages.map((p) => rev96Photo(payload.documentCaptureId, p.pageNumber)),
      activities: payload.comments.map((c) => rev96Activity(payload.documentCaptureId, c.sequence)),
    };
  } });
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.ctl.getState().status, 'failed');
  assert.equal((await h.ctl.retryConfirm({ author: AUTHOR })).ok, true);
});

// The documented adapter, including its capture-identity assertion.
const adapterFrom = (hostState, uploads) => ({ pageId, pageNumber, workOrderId, documentCaptureId }) => {
  const dc = hostState.docCapture;
  if (!dc || dc.captureId !== documentCaptureId) {
    throw new Error('The active document capture changed before upload.');
  }
  const page = dc.pages.find((p) => p.pageId === pageId);
  if (!page) throw new Error('Page ' + pageNumber + ' is no longer available.');
  uploads.push({ workOrderId, documentCaptureId, pageNumber, blobOrig: page.archival.blob });
};

test('the upload adapter refuses a different capture that happens to reuse a page id', async () => {
  const uploads = [];
  const hostState = { docCapture: { captureId: CAP, pages: capturePages(2) } };
  const h = harness({ uploadPage: async (page) => {
    // between page 1 and page 2 the host is pointed at ANOTHER capture whose
    // pages carry the same client ids
    hostState.docCapture = { captureId: 'cap-999', pages: capturePages(2) };
    return adapterFrom(hostState, uploads)(page);
  } });
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upload_failed');
  assert.equal(r.pageNumber, 1, 'it failed before any byte was written');
  assert.equal(uploads.length, 0);
  assert.equal(h.calls.length, 0);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('the upload adapter accepts the matching capture and passes the plan identity through', async () => {
  const uploads = [];
  const hostState = { docCapture: { captureId: CAP, pages: capturePages(2) } };
  const h = harness({ uploadPage: async (page) => adapterFrom(hostState, uploads)(page) });
  h.begin(['one', 'two']);
  assert.equal((await h.ctl.confirm({ author: AUTHOR })).ok, true);
  assert.deepEqual(uploads.map((u) => u.pageNumber), [1, 2]);
  for (const u of uploads) {
    assert.equal(u.documentCaptureId, CAP);
    assert.equal(u.workOrderId, WO);
    assert.ok(u.blobOrig.size > 0);
  }
});

// ---------------------------------------------------------------------------
// Section 27 A2 feature gate — the feature_disabled reviewer state
// ---------------------------------------------------------------------------

// Shaped like a PostgrestError raised by the A2 trigger.
const pgError = (hint) => Object.assign(new Error('Document Photo Transcription is turned off for this shop.'), {
  code: 'P0001', details: null, hint,
});

const disabledHarness = () => harness({ finalize: async () => { throw pgError(HINT_FEATURE_DISABLED); } });

test('feature_disabled is a declared state', () => {
  assert.equal(REVIEW_STATES.includes('feature_disabled'), true);
});

test('a feature-off refusal produces feature_disabled, not failed', async () => {
  const h = disabledHarness();
  h.begin(['one', 'two']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'feature_disabled');
  assert.equal(r.retryable, false);
  const s = h.ctl.getState();
  assert.equal(s.status, 'feature_disabled');
  assert.equal(s.featureDisabled, true);
  assert.equal(s.featureDisabledMessage, MESSAGES.featureDisabled);
  assert.equal(s.canConfirm, false, 'no SAVE');
  assert.equal(s.canRetryConfirm, false, 'no generic retry');
  assert.equal(s.canReturnAfterFeatureDisabled, true, 'one deliberate way forward');
  assert.equal(s.confirmInFlight, false, 'the saving lock is cleared');
  assert.equal(s.progress, '');
});

test('the reviewed draft survives a feature-off refusal', async () => {
  const h = disabledHarness();
  h.begin(['one']);
  h.ctl.editComment(h.ctl.getState().comments[0].commentId, 'reviewed wording');
  await h.ctl.confirm({ author: AUTHOR });
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
  assert.equal(h.stored().comments[0].body, 'reviewed wording');
});

test('the review stays editable while the feature is off', async () => {
  const h = disabledHarness();
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  const id = h.ctl.getState().comments[0].commentId;
  assert.equal(h.ctl.editComment(id, 'kept working while waiting').applied, true);
  assert.equal(h.ctl.setVisibility(id, 'public').applied, true);
  assert.equal(h.ctl.splitComment(id, 4).applied, true);
});

test('confirm is refused from feature_disabled and uploads nothing', async () => {
  const h = disabledHarness();
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  const uploadsAfterFirst = h.uploads.length;
  const again = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(again.reason, 'not_in_review');
  assert.equal(again.status, 'feature_disabled');
  assert.equal(h.uploads.length, uploadsAfterFirst, 'no further staging');
  assert.equal(h.calls.length, 1);
});

test('RETURN TO REVIEW restores the review without touching any dependency', async () => {
  let a = 0;
  const h = harness({ finalize: async (payload) => {
    a += 1;
    if (a === 1) throw pgError(HINT_FEATURE_DISABLED);
    return {
      photos: payload.pages.map((p) => ({ documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
      activities: payload.comments.map(() => ({ id: 'ac' })),
    };
  } });
  h.begin(['one', 'two']);
  const before = JSON.stringify(h.ctl.getState().comments);
  await h.ctl.confirm({ author: AUTHOR });
  const callsBefore = h.calls.length; const uploadsBefore = h.uploads.length;

  assert.equal(h.ctl.returnToReview().applied, true);
  assert.equal(h.calls.length, callsBefore, 'no finalize call');
  assert.equal(h.uploads.length, uploadsBefore, 'no upload');
  const s = h.ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.canConfirm, true, 'SAVE is deliberately exposed again');
  assert.equal(s.featureDisabled, false);
  assert.equal(JSON.stringify(s.comments), before, 'identical ids, text, order, visibility, pages');
});

test('after the owner re-enables, the save completes and the draft clears', async () => {
  let a = 0;
  const h = harness({ finalize: async (payload) => {
    a += 1;
    if (a === 1) throw pgError(HINT_FEATURE_DISABLED);
    return {
      photos: payload.pages.map((p) => ({ documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
      activities: payload.comments.map(() => ({ id: 'ac' })),
    };
  } });
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  h.ctl.returnToReview();
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('saving while still disabled re-stages the pages and returns to feature_disabled', async () => {
  const h = disabledHarness();
  h.begin(['one', 'two']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.deepEqual(h.uploads, [1, 2], 'the first attempt staged both pages');
  h.ctl.returnToReview();
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.reason, 'feature_disabled');
  // Deterministic paths + upsert make the re-upload harmless; it is the same
  // two objects overwritten, not four new ones.
  assert.deepEqual(h.uploads, [1, 2, 1, 2]);
  assert.equal(h.ctl.getState().status, 'feature_disabled');
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('PAGES and close are reachable from feature_disabled, and the draft is kept', async () => {
  const h = disabledHarness();
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  assert.equal(h.ctl.backToCapture().applied, true);
  assert.equal(h.ctl.getState().status, 'idle');
  assert.equal(h.ctl.getState().canReturnToReview, true);
  assert.equal(h.ctl.returnToReview().applied, true);
  assert.equal(h.ctl.closeReview().applied, true);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('the generic A2 refusal is an ordinary failure with its own message', async () => {
  const h = harness({ finalize: async () => { throw pgError(HINT_NOT_ALLOWED); } });
  h.begin(['one']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.reason, 'failed');
  assert.equal(h.ctl.getState().status, 'failed');
  assert.equal(h.ctl.getState().error, MESSAGES.notAllowed);
  assert.equal(h.ctl.getState().featureDisabled, false);
  assert.notEqual(h.storage.getItem(draftKeyFor(WO, CAP)), null);
});

test('the disabled hint is recognised from any of the error fields', async () => {
  for (const shape of [
    { hint: HINT_FEATURE_DISABLED },
    { code: HINT_FEATURE_DISABLED },
    { details: HINT_FEATURE_DISABLED },
    { message: 'ERROR:  ' + HINT_FEATURE_DISABLED },
  ]) {
    const h = harness({ finalize: async () => { throw Object.assign(new Error('x'), shape); } });
    h.begin(['one']);
    await h.ctl.confirm({ author: AUTHOR });
    assert.equal(h.ctl.getState().status, 'feature_disabled', JSON.stringify(shape));
  }
});

test('an ordinary failure still offers a retry, unchanged', async () => {
  const h = harness({ finalize: async () => { throw new Error('boom'); } });
  h.begin(['one']);
  await h.ctl.confirm({ author: AUTHOR });
  const s = h.ctl.getState();
  assert.equal(s.status, 'failed');
  assert.equal(s.canRetryConfirm, true);
  assert.equal(s.featureDisabled, false);
});

// The documented template, checked as source: the state contract says the SAVE
// control is ABSENT while the feature is off, not merely disabled.
test('the integrated footer omits SAVE in feature_disabled rather than disabling it', async () => {
  // Revision 129: was a read of the (root-level, never-shipped) index-5c-edits.md
  // and failed with ENOENT. It now asserts the shipped template.
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const footer = doc.slice(doc.indexOf('{{ docPagesButtonStyle }}'), doc.indexOf('{{ docSaveProgress }}'));
  assert.match(footer, /sc-if value="\{\{ docShowSave \}\}"/, 'SAVE is wrapped in a condition');
  const saveAt = footer.indexOf('confirmDocCapture');
  const condAt = footer.indexOf('docShowSave');
  assert.ok(condAt > -1 && condAt < saveAt, 'the condition precedes the SAVE control');
  assert.match(doc, /docShowSave: !\(rv && rv\.featureDisabled\)/, 'and excludes the feature-off state');
  assert.match(footer, /backToDocPages/, 'PAGES stays in the footer');
});

test('the integrated feature_disabled panel offers RETURN TO REVIEW and no retry', async () => {
  // Revision 129: same ENOENT correction — the shipped template is the subject.
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = doc.indexOf('docFeatureDisabled }}');
  assert.notEqual(start, -1, 'the panel exists');
  const panel = doc.slice(start, doc.indexOf('docConfirmFailed }}', start));
  assert.match(panel, /RETURN TO REVIEW/);
  assert.match(panel, /returnAfterDocFeatureDisabled/);
  assert.equal(/TRY SAVING AGAIN/.test(panel), false, 'no retry control in this state');
  assert.equal(/confirmDocCapture/.test(panel), false, 'no SAVE control in this state');
  // and the close control is the sheet's own, always rendered
  assert.match(doc, /closeDocCapture/);
});

// ===========================================================================
// Bounded upload and finalization.
//
// This is the defect that produced a sheet with a disabled SAVE and no exit:
// uploadPage() was awaited with no bound, so a Storage upload that never
// settled left confirmInFlight true forever — SAVE gone because canConfirm
// needs status 'review', TRY SAVING AGAIN gone because canRetryConfirm needs
// status 'failed', and closeReview() refusing because locked() was true.
// ===========================================================================

// A controllable timer. `fire()` runs every pending callback, which is how a
// timeout is driven without waiting in real time.
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear: (id) => { pending.delete(id); },
    pendingCount: () => pending.size,
    fire: () => { const all = [...pending.values()]; pending.clear(); for (const p of all) p.fn(); },
  };
}

const hang = () => new Promise(() => {});          // never settles, like the real defect
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a hung page upload times out into the recoverable failed state', async () => {
  const timers = fakeTimers();
  const h = harness({ timers, uploadTimeoutMs: 1000, uploadPage: () => hang() });
  h.begin(['one']);
  const p = h.ctl.confirm({ author: AUTHOR });
  await tick();
  assert.equal(h.ctl.getState().locked, true, 'in flight while waiting');
  timers.fire();
  const r = await p;

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upload_timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.pageNumber, 1);
  assert.equal(r.retryable, true);

  const s = h.ctl.getState();
  assert.equal(s.locked, false, 'the lock is cleared');
  assert.equal(s.confirmInFlight, false);
  assert.equal(s.canRetryConfirm, true, 'TRY SAVING AGAIN is offered');
  assert.match(s.error, /took too long/i);
  assert.equal(s.comments.length, 1, 'the review survives');
  assert.equal(h.calls.length, 0, 'finalization was never reached');
  assert.ok(h.stored(), 'the draft is retained');
});

test('the timed-out sheet can be closed, which the hang made impossible', async () => {
  const timers = fakeTimers();
  const h = harness({ timers, uploadTimeoutMs: 1000, uploadPage: () => hang() });
  h.begin(['one']);
  const p = h.ctl.confirm({ author: AUTHOR });
  await tick();
  const refused = h.ctl.closeReview();
  assert.equal(refused.applied, false, 'closing is refused while genuinely in flight');
  assert.equal(refused.reason, 'in_flight');
  timers.fire();
  await p;
  assert.equal(h.ctl.closeReview().applied, true, 'and allowed once the bound has fired');
});

test('a hung finalization times out as AMBIGUOUS, because the write may still land', async () => {
  const timers = fakeTimers();
  const h = harness({ timers, finalizeTimeoutMs: 1000, finalize: () => hang() });
  h.begin(['one']);
  const p = h.ctl.confirm({ author: AUTHOR });
  await tick();
  timers.fire();
  const r = await p;

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'finalize_timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.ambiguous, true);
  const s = h.ctl.getState();
  assert.equal(s.locked, false);
  assert.equal(s.canRetryConfirm, true);
  assert.match(s.error, /cannot create duplicates/i);
  assert.ok(h.stored(), 'the draft is retained so the idempotent retry has its plan');
});

test('a retry after a timeout reuses the SAME capture id, so it cannot duplicate', async () => {
  const timers = fakeTimers();
  let attempt = 0;
  const h = harness({
    timers, uploadTimeoutMs: 1000,
    uploadPage: () => (++attempt === 1 ? hang() : Promise.resolve()),
  });
  h.begin(['one']);
  const first = h.ctl.confirm({ author: AUTHOR });
  await tick();
  timers.fire();
  await first;

  const second = await h.ctl.retryConfirm({ author: AUTHOR });
  assert.equal(second.ok, true);
  assert.equal(h.calls.length, 1, 'exactly one finalization');
  assert.equal(h.calls[0].documentCaptureId, CAP, 'the same capture id, so the server reconciles');
  assert.equal(h.ctl.getState().status, 'confirmed');
});

test('a successful save leaves no pending timer behind', async () => {
  const timers = fakeTimers();
  const h = harness({ timers, uploadTimeoutMs: 1000, finalizeTimeoutMs: 1000 });
  h.begin(['one']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(timers.pendingCount(), 0, 'every bound was cleared on the success path too');
});

test('an upload that fails fast still reports upload_failed, not a timeout', async () => {
  const timers = fakeTimers();
  const h = harness({
    timers, uploadTimeoutMs: 1000,
    uploadPage: () => Promise.reject(new Error('bucket not found')),
  });
  h.begin(['one']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upload_failed');
  assert.equal(r.timedOut, undefined);
  assert.equal(timers.pendingCount(), 0, 'the bound was cleared when the request settled');
});

test('a bound of zero or less disables the timeout rather than firing immediately', async () => {
  const timers = fakeTimers();
  const h = harness({ timers, uploadTimeoutMs: 0 });
  h.begin(['one']);
  const r = await h.ctl.confirm({ author: AUTHOR });
  assert.equal(r.ok, true);
  assert.equal(timers.pendingCount(), 0);
});
