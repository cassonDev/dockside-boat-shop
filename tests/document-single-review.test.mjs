// Tests for the simple document flow: one timeline entry per document.
// Run:  node --test tests/document-single-review.test.mjs
// Fully mocked: no Supabase, no Netlify, no OpenAI, no browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewController, combinePageText, MESSAGES } from '../document-review-draft.js';

const WO = 'K7M2Q';
const CAP = 'cap-1';
const AUTHOR = { id: 'u-1', name: 'Dana Reyes', role: 'mechanic' };

const capturePages = (n) => Array.from({ length: n }, (_, i) => ({
  pageId: `p${i + 1}`,
  archival: { blob: { size: 90000 + i }, width: 1800, height: 2400 },
  thumb: { blob: { size: 4000 }, url: `blob:thumb-${i + 1}` },
  ocr: { blob: { size: 40000 } },
}));

const reading = (texts, over = {}) => texts.map((text, i) => ({
  pageId: `p${i + 1}`, pageNumber: i + 1, text,
  state: text ? 'ready' : 'failed', confidenceScore: text ? 0.9 : null,
  lowConfidenceRegions: [], qualityTier: 'standard', pendingStrong: null,
  ...(over[`p${i + 1}`] || {}),
}));

function harness({ storage = null } = {}) {
  let n = 0;
  const finalizeCalls = [];
  const uploads = [];
  const ctl = createReviewController({
    storage,                     // the simple flow keeps no local drafts
    newId: () => `c${++n}`,
    uploadPage: async (page) => { uploads.push(page.pageNumber); },
    finalize: async (payload) => {
      finalizeCalls.push(payload);
      return {
        photos: payload.pages.map((p, i) => ({ id: `ph-${i + 1}`, documentCaptureId: CAP, documentPageNumber: p.pageNumber })),
        activities: payload.comments.map((c, i) => ({ id: `ac-${i + 1}`, body: c.body, documentCaptureId: CAP })),
        photosExisted: false, activitiesExisted: false,
      };
    },
  });
  const begin = (texts, body, over) => ctl.beginSingleReview({
    workOrderId: WO, documentCaptureId: CAP,
    capturePages: capturePages(texts.length),
    readingPages: reading(texts, over),
    body,
  });
  return { ctl, begin, finalizeCalls, uploads };
}

// ---- combinePageText ("Everything") -------------------------------------------

test('one page: its text as-is, no "Page 1" heading', () => {
  assert.equal(combinePageText(reading(['  Impeller kit x1  '])), 'Impeller kit x1');
});

test('several pages: page order with a heading per page', () => {
  const pages = reading(['First', 'Second', 'Third']).reverse();
  assert.equal(combinePageText(pages), 'Page 1\nFirst\n\nPage 2\nSecond\n\nPage 3\nThird');
});

test('empty and failed pages are skipped', () => {
  assert.equal(combinePageText(reading(['First', '', '   ', 'Fourth'])), 'Page 1\nFirst\n\nPage 4\nFourth');
  assert.equal(combinePageText(reading(['', ''])), '');
  assert.equal(combinePageText(null), '');
});

// ---- beginSingleReview ---------------------------------------------------------

test('builds exactly ONE entry with every page attached, staff-only by default', () => {
  const { ctl, begin } = harness();
  const r = begin(['A', 'B', 'C'], '• Impeller kit x1');
  assert.equal(r.ok, true);
  const s = ctl.getState();
  assert.equal(s.status, 'review');
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0].body, '• Impeller kit x1');
  assert.deepEqual(s.comments[0].pageNumbers, [1, 2, 3]);
  assert.equal(s.comments[0].visibility, 'private');
  assert.equal(s.canConfirm, true);
});

test('saving sends one comment, all pages, and the chosen visibility', async () => {
  const { ctl, begin, finalizeCalls, uploads } = harness();
  const r = begin(['A', 'B'], 'Everything text');
  ctl.setVisibility(r.commentId, 'public');
  const res = await ctl.confirm({ author: AUTHOR });
  assert.equal(res.ok, true);
  assert.deepEqual(uploads.sort(), [1, 2]);
  assert.equal(finalizeCalls.length, 1);
  const payload = finalizeCalls[0];
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].body, 'Everything text');
  assert.equal(payload.comments[0].visibility, 'public');
  assert.deepEqual(payload.comments[0].pageNumbers, [1, 2]);
  assert.equal(payload.comments[0].aiGenerated, true);
  assert.equal(payload.pages.length, 2);
});

test('edits made on the check screen are what gets saved', async () => {
  const { ctl, begin, finalizeCalls } = harness();
  const r = begin(['A'], 'Machine text');
  ctl.editComment(r.commentId, 'Fixed by the mechanic');
  await ctl.confirm({ author: AUTHOR });
  assert.equal(finalizeCalls[0].comments[0].body, 'Fixed by the mechanic');
});

test('an emptied entry cannot be saved', () => {
  const { ctl, begin } = harness();
  const r = begin(['A'], 'Machine text');
  ctl.editComment(r.commentId, '   ');
  assert.equal(ctl.getState().canConfirm, false);
});

test('refuses when no page produced text', () => {
  const { ctl, begin } = harness();
  const r = begin(['', ''], 'anything');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_transcribed_text');
  assert.equal(ctl.getState().comments.length, 0);
});

test('refuses an empty body', () => {
  const { begin } = harness();
  const r = begin(['A'], '  ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_body');
  assert.equal(r.message, MESSAGES.emptyBody);
});

test('refuses while a stronger-reading choice is undecided', () => {
  const { begin } = harness();
  const r = begin(['A', 'B'], 'x', { p2: { pendingStrong: { text: 'B2', qualityTier: 'strong' } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'pending_stronger_choice');
});

test('records strong tier and the lowest page confidence', async () => {
  const { ctl, begin, finalizeCalls } = harness();
  begin(['A', 'B'], 'x', { p1: { qualityTier: 'strong', confidenceScore: 0.8 }, p2: { confidenceScore: 0.6 } });
  await ctl.confirm({ author: AUTHOR });
  assert.equal(finalizeCalls[0].comments[0].qualityTier, 'strong');
  assert.equal(finalizeCalls[0].comments[0].originalConfidence, 0.6);
  assert.deepEqual(finalizeCalls[0].comments[0].lowConfidenceRegions, []);
});

test('starting again (e.g. after a stronger read) replaces the entry, never adds a second', () => {
  const { ctl, begin } = harness();
  begin(['A'], 'first pull');
  begin(['A'], 'second pull');
  const s = ctl.getState();
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0].body, 'second pull');
});

test('without local storage the flow still saves (no drafts kept)', async () => {
  const { ctl, begin } = harness({ storage: null });
  begin(['A'], 'text');
  const res = await ctl.confirm({ author: AUTHOR });
  assert.equal(res.ok, true);
});
