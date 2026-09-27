// End-to-end test of the "Scan a document" screens as wired in index.html.
// Run:  node --test tests/document-flow-app.test.mjs
//
// Loads the real app component from index.html and drives the document flow
// with the REAL page, reading and review modules. Only the edges are fakes:
// image decoding, the network calls (reading, pulling, uploading, saving) and
// the app's own data loaders. Nothing contacts Supabase, Netlify or OpenAI.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pagesMod from '../document-page-pipeline.js';
import * as schedulerMod from '../document-transcription-scheduler.js';
import * as reviewMod from '../document-review-draft.js';

// ---- load the component class out of index.html ------------------------------

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

class DCLogic {
  constructor(props) { this.props = props || {}; this.state = this.state || {}; }
  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = { ...this.state, ...(next || {}) };
  }
  forceUpdate() {}
}

globalThis.window = globalThis;
globalThis.location = { origin: 'https://app.test', pathname: '/', search: '', hash: '' };
globalThis.innerWidth = 390;
globalThis.FileReader = class {
  readAsDataURL() { setImmediate(() => { this.result = 'data:image/jpeg;base64,AAAA'; this.onload(); }); }
};
const Component = new Function('DCLogic', `${script}\nreturn Component;`)(DCLogic);

// ---- fakes at the edges ----------------------------------------------------------

function fakePipeline() {
  let n = 0;
  return pagesMod.createPagePipeline({
    decodeImage: async () => ({ bitmap: { close() {} }, width: 3000, height: 4000 }),
    createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({ filter: '', translate() {}, rotate() {}, drawImage() {} }) }),
    canvasToBlob: async (c) => ({ size: 1000, width: c.width, height: c.height }),
    createObjectURL: () => `blob:thumb-${++n}`,
    revokeObjectURL: () => {},
  });
}

function makeApp({ transcribe, pull } = {}) {
  const calls = { transcribe: [], pull: [], upload: [], finalize: [] };
  let ids = 0;
  const app = new Component({});
  // A signed-in mechanic with the job open, so the render data is the real
  // job-screen view the document sheet sits on.
  const job = {
    id: 'K7M2Q', customerName: 'Pat Lee', phone: '', boatYear: '', boatMake: '', boatModel: '',
    customerEmail: '', boatMakeModel: '2019 Bayliner VR5', issue: 'Engine hesitates', photos: [],
    size: 'M', priority: 'normal', assignedMechanic: 'u-1', status: 'open', createdAt: Date.now(),
    intakeRawNotes: '', customerConcern: '', originalTranscript: '', originalCustomerConcern: '',
    originalExtraction: null, active: true, locationId: null, shopId: 'shop-1', archivedAt: null, entries: [],
  };
  app.state = { ...app.state, authChecking: false, session: { access_token: 't' }, loaded: true, loadError: '',
    screen: 'job', selectedJobId: 'K7M2Q', jobs: [job],
    profile: { id: 'u-1', name: 'Dana Reyes', role: 'mechanic', active: true } };
  app._docPages = pagesMod;
  app._docScheduler = schedulerMod;
  app._docReview = reviewMod;
  app._pagePipeline = () => (app.__fakePipeline || (app.__fakePipeline = fakePipeline()));
  app.activeShopRole = () => 'mechanic';
  app.loadActivities = async () => {};
  app.loadJobPhotos = async () => {};
  app._dataMod = {
    newDocumentCaptureId: () => `cap-${++ids}`,
    newTranscriptionRequestId: () => `req-${++ids}`,
    transcribeDocumentPage: async (req) => {
      calls.transcribe.push({ page: req.pageNumber, tier: req.qualityTier });
      if (transcribe) return transcribe(req);
      return { ok: true, text: `${req.qualityTier} text of page ${req.pageNumber}`, confidenceScore: 0.9,
        lowConfidenceRegions: [], needsReview: false, qualityTier: req.qualityTier };
    },
    pullDocumentDetails: async (req) => {
      calls.pull.push(req);
      return pull ? pull(req) : { ok: true, text: `• pulled for "${req.instruction}"` };
    },
    uploadDocumentPage: async (req) => { calls.upload.push(req.pageNumber); return {}; },
    finalizeDocumentCapture: async (payload) => {
      calls.finalize.push(payload);
      return {
        photos: payload.pages.map((p, i) => ({ id: `ph${i}`, documentCaptureId: payload.documentCaptureId, documentPageNumber: p.pageNumber })),
        activities: payload.comments.map((c, i) => ({ id: `ac${i}`, body: c.body, documentCaptureId: payload.documentCaptureId })),
      };
    },
  };
  return { app, calls };
}

const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };
const pick = (app, name) => app.pickDocPages({ target: { files: [{ name, type: 'image/jpeg' }], value: name } });

async function readTwoPages(app) {
  app.openDocCapture();
  await pick(app, 'a.jpg');
  await pick(app, 'b.jpg');
  await settle();
  assert.equal(app.state.docCapture.pages.length, 2);
  app.startDocReading();
  await settle();
}

// The render data must build at every step without throwing.
function view(app) {
  try { return app.renderVals(); } catch (e) { assert.fail(`renderVals threw: ${e.stack}`); }
}

test('everything path: 2 pages -> read -> Everything -> share -> save as ONE entry', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  assert.equal(app.state.docStep, 'pull', 'moves on by itself once every page is read');
  assert.equal(calls.transcribe.length, 2);
  assert.equal(view(app).isDocPullStep, true);

  app.chooseDocEverything();
  assert.equal(app.state.docStep, 'review');
  let v = view(app);
  assert.equal(v.docReviewBody, 'Page 1\nstandard text of page 1\n\nPage 2\nstandard text of page 2');
  assert.equal(v.docReviewTitle, 'Here’s everything I read');
  assert.equal(calls.pull.length, 0, '"Everything" makes no AI call');
  assert.equal(v.docShareLabel.startsWith('Off'), true, 'staff only by default');

  app.toggleDocShare();
  v = view(app);
  assert.equal(v.docShareLabel.startsWith('On'), true);

  await app.confirmDocCapture();
  await settle();
  assert.equal(calls.finalize.length, 1);
  const saved = calls.finalize[0];
  assert.equal(saved.comments.length, 1, 'one timeline entry');
  assert.equal(saved.comments[0].visibility, 'public');
  assert.deepEqual(saved.comments[0].pageNumbers, [1, 2]);
  assert.equal(saved.pages.length, 2);
  assert.deepEqual(app.state.docSaved, { photos: 2, shared: true });
  v = view(app);
  assert.equal(v.isDocSavedStep, true);
  assert.equal(v.docSavedAudienceLabel, 'Team and customer');
  assert.equal(v.docSavedPagesLabel, '2');
});

test('ask path: typed request -> pulled text -> edit -> saved staff-only', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  app.setDocPullText({ target: { value: 'just the parts' } });
  await app.submitDocPull();
  await settle();
  assert.equal(app.state.docStep, 'review');
  assert.equal(calls.pull.length, 1);
  assert.equal(calls.pull[0].instruction, 'just the parts');
  assert.equal(calls.pull[0].workOrderId, 'K7M2Q');
  assert.deepEqual(calls.pull[0].pages.map((p) => p.pageNumber), [1, 2]);
  assert.equal(view(app).docReviewTitle, 'Here’s what I pulled');

  app.editDocReviewBody({ target: { value: 'Impeller kit x1' } });
  await app.confirmDocCapture();
  await settle();
  assert.equal(calls.finalize[0].comments[0].body, 'Impeller kit x1');
  assert.equal(calls.finalize[0].comments[0].visibility, 'private');
  assert.equal(view(app).docSavedAudienceLabel, 'Staff only');
});

test('GO with nothing typed asks for a request instead of calling the AI', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  await app.submitDocPull();
  assert.equal(app.state.docStep, 'pull');
  assert.ok(app.state.docPullError);
  assert.equal(calls.pull.length, 0);
});

test('a failed pull returns to the choice screen with the reason', async () => {
  const { app } = makeApp({ pull: () => ({ ok: false, error: 'Couldn’t pull the details this time.' }) });
  await readTwoPages(app);
  app.setDocPullText({ target: { value: 'parts' } });
  await app.submitDocPull();
  await settle();
  assert.equal(app.state.docStep, 'pull');
  assert.equal(view(app).docPullError, 'Couldn’t pull the details this time.');
});

test('stronger read is offered only on the results screen, re-reads every page once, and re-applies the same request', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  assert.equal(view(app).isDocReviewStep, false);
  app.setDocPullText({ target: { value: 'parts' } });
  await app.submitDocPull();
  await settle();
  assert.equal(view(app).docCanTryStronger, true);

  app.requestDocStronger();
  await settle();
  const strong = calls.transcribe.filter((c) => c.tier === 'strong');
  assert.equal(strong.length, 2, 'every page read again, more carefully');
  assert.equal(calls.pull.length, 2, 'the same request is applied again');
  assert.equal(calls.pull[1].instruction, 'parts');
  assert.equal(calls.pull[1].pages[0].text, 'strong text of page 1');
  assert.equal(app.state.docStep, 'review');
  assert.equal(view(app).docCanTryStronger, false, 'one stronger read per document');
});

test('stronger read after Everything rebuilds the text without an AI pull', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  app.chooseDocEverything();
  app.requestDocStronger();
  await settle();
  assert.equal(calls.pull.length, 0);
  assert.equal(view(app).docReviewBody, 'Page 1\nstrong text of page 1\n\nPage 2\nstrong text of page 2');
});

test('stronger read after editing asks first, and "keep my text" keeps it', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  app.chooseDocEverything();
  app.editDocReviewBody({ target: { value: 'my fixes' } });
  app.requestDocStronger();
  assert.equal(app.state.docConfirmStronger, true);
  app.cancelDocStronger();
  await settle();
  assert.equal(calls.transcribe.filter((c) => c.tier === 'strong').length, 0);
  assert.equal(view(app).docReviewBody, 'my fixes');
});

test('share choice survives pulling something different', async () => {
  const { app, calls } = makeApp();
  await readTwoPages(app);
  app.chooseDocEverything();
  app.toggleDocShare();
  app.backToDocPull();
  app.setDocPullText({ target: { value: 'labour' } });
  await app.submitDocPull();
  await settle();
  await app.confirmDocCapture();
  await settle();
  assert.equal(calls.finalize[0].comments[0].visibility, 'public');
});

test('a page that cannot be read waits for Try again / Skip; skipping moves on', async () => {
  const { app } = makeApp({
    transcribe: (req) => (req.pageNumber === 2
      ? { ok: false, code: 'BAD_REQUEST', error: 'That photo could not be read.', retryable: false }
      : { ok: true, text: 'page one', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false, qualityTier: 'standard' }),
  });
  await readTwoPages(app);
  assert.equal(app.state.docStep, 'reading');
  const v = view(app);
  assert.equal(v.docProblemPages.length, 1);
  assert.equal(v.docProblemPages[0].label, 'Page 2');
  v.docProblemPages[0].skip();
  await settle();
  assert.equal(app.state.docCapture.pages.length, 1);
  assert.equal(app.state.docStep, 'pull');
});

test('close with pages asks first; leaving discards the capture', async () => {
  const { app } = makeApp();
  await readTwoPages(app);
  app.requestCloseDocCapture();
  assert.ok(app.state.docConfirmClose);
  app.confirmCloseDocCapture();
  await settle();
  assert.equal(app.state.docCapture, null);
  assert.equal(view(app).showDocCapture, false);
});

test('close before any page closes straight away', async () => {
  const { app } = makeApp();
  app.openDocCapture();
  app.requestCloseDocCapture();
  await settle();
  assert.equal(app.state.docConfirmClose, null);
  assert.equal(app.state.docCapture, null);
});

test('scan another document after saving starts fresh', async () => {
  const { app } = makeApp();
  await readTwoPages(app);
  app.chooseDocEverything();
  app.toggleDocShare();
  await app.confirmDocCapture();
  await settle();
  app.scanAnotherDocument();
  await settle();
  const v = view(app);
  assert.equal(v.isDocSavedStep, false);
  assert.equal(v.isDocCaptureStep, true);
  assert.equal(v.docNoPagesYet, true);
  assert.equal(app.state.docShare, false, 'back to staff only');
});

test('screen 1-2 labels follow the page count', async () => {
  const { app } = makeApp();
  app.openDocCapture();
  let v = view(app);
  assert.equal(v.docCameraLabel, 'TAKE PHOTO OF PAGE 1');
  assert.equal(v.docCanStartReading, false);
  await pick(app, 'a.jpg');
  await settle();
  v = view(app);
  assert.equal(v.docPagesHeading, '1 page ready');
  assert.equal(v.docCameraLabel, '+ ADD ANOTHER PAGE');
  assert.equal(v.docReadLabel, 'THAT’S ALL — READ IT');
  assert.equal(v.docJobLabel, 'K7M2Q · Pat Lee');
});
