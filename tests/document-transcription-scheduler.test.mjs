// Step 5B tests — transcription orchestration.
// Run:  node --test tests/document-transcription-scheduler.test.mjs
// No network, no browser, no Supabase: transcribe and blobToDataUrl are doubles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptionScheduler, MAX_CONCURRENT, OFFLINE_MESSAGE, RESULT_LOST_MESSAGE }
  from '../document-transcription-scheduler.js';

const okResult = (text, over = {}) => ({
  ok: true, text, qualityTier: 'standard',
  confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false, ...over,
});
const failResult = (code, error = 'nope', over = {}) => ({ ok: false, code, error, retryable: false, ...over });

const WO = 'K7M2Q';
const CAP = 'cap-1';
const pageInputs = (n, tag = '') => Array.from({ length: n }, (_, i) => ({ pageId: `p${i + 1}`, ocrBlob: { id: `p${i + 1}${tag}` } }));

// Records calls, counts concurrency and live data URLs, and can hold named
// blobs open so ordering is deterministic.
function harness({ responder = async () => okResult('t'), hold = new Set() } = {}) {
  const log = { calls: [], converted: [], liveDataUrls: 0, peakDataUrls: 0, active: 0, peakActive: 0, emissions: [], released: [], minReportedActive: 0 };
  const gates = new Map();
  for (const id of hold) {
    let release; const p = new Promise((r) => { release = r; });
    let entered; const e = new Promise((r) => { entered = r; });
    gates.set(id, { p, release, e, entered });
  }
  const scheduler = createTranscriptionScheduler({
    newRequestId: () => `req-${log.calls.length + 1}`,
    blobToDataUrl: async (blob) => {
      log.converted.push(blob.id);
      log.liveDataUrls += 1;
      if (log.liveDataUrls > log.peakDataUrls) log.peakDataUrls = log.liveDataUrls;
      return `data:image/jpeg;base64,${blob.id}`;
    },
    // The live count is owned by the RELEASE BOUNDARY, not by transcribe():
    // a cancelled conversion never reaches transcribe, and its URL must still
    // be accounted as released.
    releaseDataUrl: (url) => { log.released.push(url); log.liveDataUrls -= 1; },
    transcribe: async (req) => {
      const id = req.imageDataUrl.split(',')[1];
      log.calls.push({ ...req, blobId: id });
      log.active += 1;
      if (log.active > log.peakActive) log.peakActive = log.active;
      const g = gates.get(id);
      if (g) { g.entered(); await g.p; }
      try { return await responder(req, id, log.calls.length); }
      finally { log.active -= 1; }
    },
    onChange: (s) => { log.emissions.push(s); if (s.activeCount < log.minReportedActive) log.minReportedActive = s.activeCount; },
  });
  const startSession = (n, tag = '') => scheduler.startSession({ workOrderId: WO, documentCaptureId: CAP, pages: pageInputs(n, tag) });
  return { scheduler, log, gates, startSession };
}

// ---------------------------------------------------------------------------
// One queue, two slots — for EVERY kind of job
// ---------------------------------------------------------------------------

test('never more than two requests or two live data URLs across five pages', async () => {
  const h = harness();
  h.startSession(5);
  await h.scheduler.start();
  assert.equal(h.log.calls.length, 5);
  assert.equal(h.log.peakActive, MAX_CONCURRENT);
  assert.equal(h.log.peakDataUrls, MAX_CONCURRENT);
  assert.equal(h.log.liveDataUrls, 0);
});

test('a strong reread WAITS for a slot and converts nothing until it gets one', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(3);
  const run = h.scheduler.start();
  await h.gates.get('p1').e; await h.gates.get('p2').e;

  const strong = h.scheduler.tryStrongerReading('p3');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.active, 2, 'still only two in flight');
  assert.equal(h.log.converted.includes('p3'), false, 'the strong job has not converted its blob');
  assert.equal(h.log.liveDataUrls, 2);

  h.gates.get('p1').release(); h.gates.get('p2').release();
  await run; await strong;
  assert.equal(h.log.peakActive, 2, 'the strong reread never made a third request');
  assert.equal(h.log.peakDataUrls, 2);
});

test('a technical retry also waits for a slot', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(3);
  const run = h.scheduler.start();
  await h.gates.get('p1').e; await h.gates.get('p2').e;
  const retry = h.scheduler.retryPage('p3');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.active, 2);
  h.gates.get('p1').release(); h.gates.get('p2').release();
  await run; await retry;
  assert.equal(h.log.peakActive, 2);
});

test('mixed standard, retry, and strong jobs share one two-slot ceiling', async () => {
  let n = 0;
  const h = harness({ responder: async () => (++n === 2 ? failResult('AI_FAILED') : okResult('t')) });
  h.startSession(4);
  await h.scheduler.start();
  await Promise.all([
    h.scheduler.retryPage('p2'),
    h.scheduler.tryStrongerReading('p1'),
    h.scheduler.tryStrongerReading('p3'),
  ]);
  assert.equal(h.log.peakActive, 2, 'peak requests');
  assert.equal(h.log.peakDataUrls, 2, 'peak live data URLs');
  assert.equal(h.log.liveDataUrls, 0);
});

test('a strong request UPGRADES a queued-but-unstarted standard read', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(3);
  const run = h.scheduler.start();
  await h.gates.get('p1').e; await h.gates.get('p2').e;

  const strong = h.scheduler.tryStrongerReading('p3');   // p3 is queued, not started
  await new Promise((r) => setTimeout(r, 0));
  h.gates.get('p1').release(); h.gates.get('p2').release();
  const out = await strong;
  await run;

  assert.equal(out.started, true);
  assert.equal(out.upgraded, true, 'the queued job was upgraded, not joined by a second');
  const p3Calls = h.log.calls.filter((c) => c.blobId === 'p3');
  assert.equal(p3Calls.length, 1, 'exactly ONE provider request for p3');
  assert.equal(p3Calls[0].qualityTier, 'strong', 'and it is the strong one');
  assert.equal(h.log.converted.filter((id) => id === 'p3').length, 1, 'exactly ONE blob conversion');
});

test('a strong request is refused while that page is already reading', async () => {
  const h = harness({ hold: new Set(['p1']) });
  h.startSession(1);
  const run = h.scheduler.start();
  await h.gates.get('p1').e;
  const out = await h.scheduler.tryStrongerReading('p1');
  assert.equal(out.started, false);
  assert.equal(out.reason, 'busy');
  h.gates.get('p1').release();
  await run;
  assert.equal(h.log.calls.length, 1, 'no racing second request');
});

test('activeCount never goes negative and returns to zero on every path', async () => {
  // cancellation during conversion, success, provider failure, and a throw.
  let convertResolve;
  const sched = createTranscriptionScheduler({
    newRequestId: () => 'r',
    blobToDataUrl: () => new Promise((r) => { convertResolve = r; }),
    transcribe: async () => okResult('t'),
    onChange: () => {},
  });
  sched.startSession({ workOrderId: WO, documentCaptureId: CAP, pages: pageInputs(1) });
  const run = sched.start();
  await new Promise((r) => setTimeout(r, 0));
  sched.endSession();
  convertResolve('data:image/jpeg;base64,p1');
  await run;
  assert.equal(sched._debug.active(), 0, 'cancelled-during-conversion leaves active at zero, not -1');

  for (const responder of [async () => okResult('t'), async () => failResult('AI_FAILED'), async () => { throw new Error('x'); }]) {
    const h = harness({ responder });
    h.startSession(2);
    await h.scheduler.start();
    assert.equal(h.scheduler._debug.active(), 0);
    assert.equal(h.log.minReportedActive >= 0, true, 'no emission ever reported a negative active count');
  }
});

test('every conversion is released exactly once, on every path', async () => {
  const h = harness({ responder: async (req, id) => (id === 'p2' ? failResult('AI_FAILED') : okResult('t')) });
  h.startSession(3);
  await h.scheduler.start();
  assert.equal(h.log.released.length, h.log.converted.length, 'one release per conversion');
  assert.equal(new Set(h.log.released).size, h.log.released.length, 'no double release');
  assert.equal(h.log.liveDataUrls, 0);
  assert.ok(h.log.peakDataUrls <= 2);
});

test('a cancelled conversion releases its data URL and makes no paid call', async () => {
  let convertResolve;
  const released = [];
  const calls = [];
  const sched = createTranscriptionScheduler({
    newRequestId: () => 'r',
    blobToDataUrl: () => new Promise((r) => { convertResolve = r; }),
    releaseDataUrl: (u) => released.push(u),
    transcribe: async (req) => { calls.push(req); return okResult('t'); },
    onChange: () => {},
  });
  sched.startSession({ workOrderId: WO, documentCaptureId: CAP, pages: pageInputs(1) });
  const run = sched.start();
  await new Promise((r) => setTimeout(r, 0));
  sched.endSession();
  convertResolve('data:image/jpeg;base64,p1');
  await run;
  assert.deepEqual(calls, [], 'no paid call after cancellation');
  assert.deepEqual(released, ['data:image/jpeg;base64,p1'], 'the URL is still released exactly once');
  assert.equal(sched._debug.active(), 0);
});

test('after a cancelled conversion, new-session work still respects the ceiling', async () => {
  let convertGate = null;
  let live = 0, peakLive = 0, peakActive = 0, act = 0;
  const sched = createTranscriptionScheduler({
    newRequestId: () => 'r',
    blobToDataUrl: async (blob) => {
      if (blob.id === 'p1') { await new Promise((r) => { convertGate = r; }); }
      live += 1; if (live > peakLive) peakLive = live;
      return `data:image/jpeg;base64,${blob.id}`;
    },
    releaseDataUrl: () => { live -= 1; },
    transcribe: async () => { act += 1; if (act > peakActive) peakActive = act; await new Promise((r) => setTimeout(r, 0)); act -= 1; return okResult('t'); },
    onChange: () => {},
  });
  sched.startSession({ workOrderId: WO, documentCaptureId: CAP, pages: pageInputs(1) });
  const first = sched.start();
  await new Promise((r) => setTimeout(r, 0));
  sched.endSession();
  sched.startSession({ workOrderId: 'W2', documentCaptureId: 'c2', pages: pageInputs(4, '-b') });
  const second = sched.start();
  convertGate();
  await Promise.all([first, second]);
  assert.equal(peakActive <= 2, true, `peak requests ${peakActive}`);
  assert.equal(peakLive <= 2, true, `peak live data URLs ${peakLive}`);
  assert.equal(live, 0, 'every data URL released');
  assert.equal(sched._debug.active(), 0);
});

test('while halted, sync does not prequeue and a targeted retry sends only its page', async () => {
  let limited = true;
  const h = harness({ responder: async (req) => (limited && req.pageNumber === 1
    ? failResult('RATE_LIMITED', 'limit') : okResult('t')) });
  h.startSession(5);
  await h.scheduler.start();
  assert.ok(h.scheduler.getState().halted, 'halted');
  const afterHalt = h.log.calls.length;

  // rotate one page and add another WHILE halted
  const cur = h.scheduler._debug.pages().map((p) => ({ pageId: p.pageId, ocrBlob: p.ocrBlob }));
  cur[3].ocrBlob = { id: 'p4-rot' };
  h.scheduler.syncPages([...cur, { pageId: 'p6', ocrBlob: { id: 'p6' } }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.calls.length, afterHalt, 'sync must not dispatch while halted');
  assert.equal(h.scheduler._debug.queue().length, 0, 'and must not prequeue');

  limited = false;
  await h.scheduler.retryPage('p1');
  assert.equal(h.log.calls.length, afterHalt + 1, 'exactly one additional request');
  assert.equal(h.log.calls[h.log.calls.length - 1].blobId, 'p1');
  assert.ok(h.scheduler.getState().pages.filter((p) => p.state === 'waiting').length >= 3);

  const before = h.log.calls.length;
  await h.scheduler.resumeQueue();
  assert.ok(h.log.calls.length > before, 'only resumeQueue releases the remainder');
  assert.equal(h.log.peakActive, 2);
});

test('an operation promise settles for ITS job, not for an unrelated pump', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(3);
  const run = h.scheduler.start();                 // never awaited below
  await h.gates.get('p1').e; await h.gates.get('p2').e;

  const strong = h.scheduler.tryStrongerReading('p3');
  let settled = false;
  strong.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'must not resolve before its job runs');

  h.gates.get('p1').release(); h.gates.get('p2').release();
  const out = await strong;                        // awaiting ONLY the operation
  assert.equal(out.started, true);
  assert.equal(h.log.calls.filter((c) => c.blobId === 'p3').length, 1, 'the job really ran');
  await run;
});

test('a 429 settles the queued operations rather than stranding their promises', async () => {
  const h = harness({ responder: async (req) => (req.pageNumber === 1 ? failResult('RATE_LIMITED', 'limit') : okResult('t')) });
  h.startSession(5);
  const settledAll = await Promise.race([
    h.scheduler.start().then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('hung'), 50)),
  ]);
  assert.equal(settledAll, 'settled', 'no queued job promise may hang after a halt');
});

test('both slots stay occupied across a session replacement', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(2);
  const old = h.scheduler.start();
  await h.gates.get('p1').e; await h.gates.get('p2').e;
  assert.equal(h.log.active, 2, 'both slots held by the old session');

  h.scheduler.endSession();
  h.scheduler.startSession({ workOrderId: 'W2', documentCaptureId: 'c2', pages: pageInputs(2, '-b') });
  const fresh = h.scheduler.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.converted.some((id) => id.endsWith('-b')), false, 'no new conversion while both slots are held');
  assert.equal(h.log.calls.filter((c) => c.blobId.endsWith('-b')).length, 0);

  h.gates.get('p1').release();
  await new Promise((r) => setTimeout(r, 0));
  h.gates.get('p2').release();
  await old; await fresh;

  const newCalls = h.log.calls.filter((c) => c.blobId.endsWith('-b'));
  assert.equal(newCalls.length, 2);
  for (const c of newCalls) { assert.equal(c.workOrderId, 'W2'); assert.equal(c.documentCaptureId, 'c2'); }
  assert.equal(h.log.peakActive, 2);
  assert.equal(h.log.peakDataUrls, 2);
  assert.equal(h.scheduler._debug.active(), 0);
  assert.equal(h.scheduler.getState().pages.every((p) => p.pageId), true);
});

test('a rotated page is re-read automatically through the shared allocator', async () => {
  const h = harness();
  h.startSession(3);
  await h.scheduler.start();
  const before = h.log.calls.length;
  const cur = h.scheduler._debug.pages().map((p) => ({ pageId: p.pageId, ocrBlob: p.ocrBlob }));
  cur[1].ocrBlob = { id: 'p2-rot' };
  h.scheduler.syncPages(cur);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const after = h.log.calls.slice(before);
  assert.equal(after.length, 1, 'exactly one reread, for the changed page only');
  assert.equal(after[0].blobId, 'p2-rot');
  assert.equal(after[0].qualityTier, 'standard');
  assert.equal(h.log.peakActive, 2);
});

// ---------------------------------------------------------------------------
// Human edits are never observably overwritten
// ---------------------------------------------------------------------------

test('no emission ever shows the machine result replacing an edit before the choice', async () => {
  let n = 0;
  const h = harness({ responder: async () => (++n === 1 ? okResult('machine v1') : okResult('MACHINE V2', { qualityTier: 'strong' })) });
  h.startSession(1);
  await h.scheduler.start();
  h.scheduler.markEdited('p1', 'my careful correction');
  const before = h.log.emissions.length;

  await h.scheduler.tryStrongerReading('p1');

  for (const st of h.log.emissions.slice(before)) {
    assert.equal(st.pages[0].text, 'my careful correction',
      'every intermediate emission must still show the human text');
  }
  const p = h.scheduler.getState().pages[0];
  assert.equal(p.pendingStrong.text, 'MACHINE V2');
  assert.equal(p.edited, true);
});

test('KEEP MY EDITS and USE STRONGER READING resolve the choice', async () => {
  for (const [choice, expected] of [['keep', 'mine'], ['use', 'V2']]) {
    let n = 0;
    const h = harness({ responder: async () => (++n === 1 ? okResult('v1') : okResult('V2', { qualityTier: 'strong' })) });
    h.startSession(1);
    await h.scheduler.start();
    h.scheduler.markEdited('p1', 'mine');
    await h.scheduler.tryStrongerReading('p1');
    const r = h.scheduler.resolveStrongerChoice('p1', choice);
    assert.equal(r.used, choice === 'use');
    const p = h.scheduler.getState().pages[0];
    assert.equal(p.text, expected);
    assert.equal(p.pendingStrong, null, 'the unused machine result is discarded');
  }
});

test('an UNEDITED page takes the stronger result directly', async () => {
  let n = 0;
  const h = harness({ responder: async () => (++n === 1 ? okResult('weak') : okResult('strong', { qualityTier: 'strong' })) });
  h.startSession(1);
  await h.scheduler.start();
  await h.scheduler.tryStrongerReading('p1');
  assert.equal(h.scheduler.getState().pages[0].text, 'strong');
});

// ---------------------------------------------------------------------------
// Immutable session identity
// ---------------------------------------------------------------------------

test('every request carries the session identity captured at start', async () => {
  const h = harness();
  h.startSession(2);
  await h.scheduler.start();
  for (const c of h.log.calls) {
    assert.equal(c.workOrderId, WO);
    assert.equal(c.documentCaptureId, CAP);
  }
});

test('a session ended during blob conversion makes no paid call', async () => {
  let convertResolve;
  const scheduler = createTranscriptionScheduler({
    newRequestId: () => 'r',
    blobToDataUrl: () => new Promise((r) => { convertResolve = r; }),
    transcribe: async () => { throw new Error('must not be called'); },
    onChange: () => {},
  });
  scheduler.startSession({ workOrderId: WO, documentCaptureId: CAP, pages: pageInputs(1) });
  const run = scheduler.start();
  await new Promise((r) => setTimeout(r, 0));
  scheduler.endSession();
  convertResolve('data:image/jpeg;base64,p1');
  await run;                       // resolves without the transcribe throw
  assert.equal(scheduler.getState().pages.length, 1);
});

test('a response arriving after the session ended is discarded, and a reopened session uses its own identity', async () => {
  const h = harness({ hold: new Set(['p1']) });
  h.startSession(1);
  const run = h.scheduler.start();
  await h.gates.get('p1').e;

  h.scheduler.endSession();
  h.scheduler.startSession({ workOrderId: 'OTHER', documentCaptureId: 'cap-2', pages: pageInputs(1, '-b') });
  h.gates.get('p1').release();
  await run;

  assert.equal(h.scheduler.getState().pages[0].text, null, 'the stale response never lands');
  await h.scheduler.start();
  const last = h.log.calls[h.log.calls.length - 1];
  assert.equal(last.workOrderId, 'OTHER');
  assert.equal(last.documentCaptureId, 'cap-2');
  assert.equal(h.log.peakActive, 1, 'old and new sessions still share the ceiling');
});

// ---------------------------------------------------------------------------
// Targeted synchronisation with the 5A capture
// ---------------------------------------------------------------------------

test('an unrelated emission preserves text, edits, confidence, and a pending choice', async () => {
  let n = 0;
  const h = harness({ responder: async () => (++n === 1 ? okResult('read', { confidenceScore: 0.61 }) : okResult('STRONG', { qualityTier: 'strong' })) });
  h.startSession(1);
  await h.scheduler.start();
  h.scheduler.markEdited('p1', 'edited');
  await h.scheduler.tryStrongerReading('p1');
  const blob = h.scheduler._debug.pages()[0].ocrBlob;

  const callsBefore = h.log.calls.length;
  h.scheduler.syncPages([{ pageId: 'p1', ocrBlob: blob }]);   // same blob: nothing moved

  const p = h.scheduler.getState().pages[0];
  assert.equal(p.text, 'edited');
  assert.equal(p.edited, true);
  assert.equal(p.confidenceScore, 0.61);
  assert.ok(p.pendingStrong, 'the pending choice survives');
  assert.equal(h.log.calls.length, callsBefore, 'no paid reread');
});

test('rotating one page of five invalidates only that page', async () => {
  const h = harness();
  h.startSession(5);
  await h.scheduler.start();
  const current = h.scheduler._debug.pages().map((p) => ({ pageId: p.pageId, ocrBlob: p.ocrBlob }));
  current[2].ocrBlob = { id: 'p3-rotated' };
  h.scheduler.syncPages(current);

  const st = h.scheduler.getState();
  assert.ok(['waiting', 'reading'].includes(st.pages[2].state), 'requeued for a fresh read');
  assert.equal(st.pages[2].text, null);
  for (const i of [0, 1, 3, 4]) {
    assert.equal(st.pages[i].state, 'ready', `page ${i + 1} untouched`);
    assert.equal(st.pages[i].text, 't');
  }
});

test('sync handles addition, removal, and reorder without losing state', async () => {
  const h = harness();
  h.startSession(3);
  await h.scheduler.start();
  h.scheduler.markEdited('p2', 'kept');
  const cur = h.scheduler._debug.pages().map((p) => ({ pageId: p.pageId, ocrBlob: p.ocrBlob }));

  // reorder p3 to the front, drop p1, add p4
  h.scheduler.syncPages([cur[2], cur[1], { pageId: 'p4', ocrBlob: { id: 'p4' } }]);
  const st = h.scheduler.getState();
  assert.deepEqual(st.pages.map((p) => [p.pageId, p.pageNumber]), [['p3', 1], ['p2', 2], ['p4', 3]]);
  assert.equal(st.pages[1].text, 'kept', 'the reordered page keeps its edit');
  assert.equal(st.pages[1].edited, true);
  assert.ok(['waiting', 'reading'].includes(st.pages[2].state), 'the added page is queued fresh');
});

test('removing a page during another page\'s in-flight request cannot strand the survivor', async () => {
  const h = harness({ hold: new Set(['p2']) });
  h.startSession(2);
  const run = h.scheduler.start();
  await h.gates.get('p2').e;

  // p1 is removed while p2 is mid-request. Object identity must survive so p2's
  // completion lands on the visible p2, not on an orphan.
  const cur = h.scheduler._debug.pages().filter((p) => p.pageId === 'p2').map((p) => ({ pageId: p.pageId, ocrBlob: p.ocrBlob }));
  h.scheduler.syncPages(cur);
  h.gates.get('p2').release();
  await run;

  const st = h.scheduler.getState();
  assert.equal(st.pages.length, 1);
  assert.equal(st.pages[0].pageId, 'p2');
  assert.equal(st.pages[0].pageNumber, 1);
  assert.notEqual(st.pages[0].state, 'reading', 'the survivor must not be stuck reading');
  assert.equal(st.pages[0].text, 't');
});

test('reorder during in-flight work keeps the same page objects', async () => {
  const h = harness({ hold: new Set(['p1']) });
  h.startSession(2);
  const run = h.scheduler.start();
  await h.gates.get('p1').e;
  const before = h.scheduler._debug.pages();
  h.scheduler.syncPages([{ pageId: 'p2', ocrBlob: before[1].ocrBlob }, { pageId: 'p1', ocrBlob: before[0].ocrBlob }]);
  h.gates.get('p1').release();
  await run;
  const after = h.scheduler._debug.pages();
  assert.equal(after[1], before[0], 'the same object, moved');
  assert.equal(after[1].text, 't', 'its in-flight result still landed');
});

// ---------------------------------------------------------------------------
// Halt and resume
// ---------------------------------------------------------------------------

test('a 429 halts dispatch and a single retry does NOT fire the rest', async () => {
  let limited = true;
  const h = harness({ responder: async (req) => (limited && req.pageNumber === 1
    ? failResult('RATE_LIMITED', 'limit reached') : okResult('t')) });
  h.startSession(5);
  await h.scheduler.start();
  const afterHalt = h.log.calls.length;
  assert.ok(afterHalt <= 2, `halt should stop dispatch, saw ${afterHalt} calls`);
  assert.equal(h.scheduler.getState().halted.code, 'RATE_LIMITED');

  limited = false;
  await h.scheduler.retryPage('p1');
  assert.equal(h.log.calls.length, afterHalt + 1, 'exactly ONE more request');
  assert.equal(h.log.calls[h.log.calls.length - 1].blobId, 'p1');
  assert.ok(h.scheduler.getState().pages.filter((p) => p.state === 'waiting').length >= 2,
    'the rest are still waiting, not dispatched');
});

test('resumeQueue is the explicit transition that dispatches the remainder', async () => {
  let limited = true;
  const h = harness({ responder: async (req) => (limited && req.pageNumber === 1
    ? failResult('RATE_LIMITED', 'limit') : okResult('t')) });
  h.startSession(5);
  await h.scheduler.start();
  limited = false;
  await h.scheduler.retryPage('p1');
  const before = h.log.calls.length;
  const out = await h.scheduler.resumeQueue();
  assert.ok(out.resumed >= 2);
  assert.ok(h.log.calls.length > before);
  assert.equal(h.scheduler.getState().allSettled, true);
  assert.equal(h.log.peakActive, 2);
});

// ---------------------------------------------------------------------------
// Retained behaviour
// ---------------------------------------------------------------------------

test('a retry keeps the same tier and issues a new request id', async () => {
  let first = true;
  const h = harness({ responder: async () => (first ? (first = false, failResult('AI_FAILED')) : okResult('second')) });
  h.startSession(1);
  await h.scheduler.start();
  await h.scheduler.retryPage('p1');
  assert.equal(h.log.calls.length, 2);
  assert.equal(h.log.calls[1].qualityTier, 'standard');
  assert.notEqual(h.log.calls[1].requestId, h.log.calls[0].requestId);
});

test('no page is ever escalated automatically', async () => {
  const h = harness({ responder: async () => okResult('', { needsReview: true, confidenceScore: 0.2 }) });
  h.startSession(3);
  await h.scheduler.start();
  assert.equal(h.log.calls.every((c) => c.qualityTier === 'standard'), true);
});

test('the stronger control is available on every page; confidence changes prominence only', async () => {
  const h = harness({ responder: async (req) => (req.pageNumber === 1
    ? okResult('crisp', { confidenceScore: 0.95 })
    : okResult('Replace [illegible] hose', { needsReview: true, confidenceScore: 0.5 })) });
  h.startSession(2);
  await h.scheduler.start();
  const st = h.scheduler.getState();
  assert.equal(st.pages[0].canTryStronger, true);
  assert.equal(st.pages[0].prominentStronger, false);
  assert.equal(st.pages[1].prominentStronger, true);
});

test('a failed page does not clear successful results', async () => {
  const h = harness({ responder: async (req) => (req.pageNumber === 2 ? failResult('AI_FAILED') : okResult('good')) });
  h.startSession(3);
  await h.scheduler.start();
  const st = h.scheduler.getState();
  assert.deepEqual(st.pages.map((p) => p.state), ['ready', 'failed', 'ready']);
  assert.equal(st.pages[2].text, 'good');
});

test('offline and lost-result messaging', async () => {
  const off = harness({ responder: async () => { throw new Error('socket'); } });
  off.startSession(1);
  await off.scheduler.start();
  assert.equal(off.scheduler.getState().pages[0].error, OFFLINE_MESSAGE);

  const lost = harness({ responder: async () => failResult('RESULT_NOT_REPLAYABLE', 'x') });
  lost.startSession(1);
  await lost.scheduler.start();
  const p = lost.scheduler.getState().pages[0];
  assert.equal(p.error, RESULT_LOST_MESSAGE);
  assert.equal(p.terminal, true);
});

test('READ PAGE AGAIN issues a new request id after a lost result', async () => {
  let n = 0;
  const h = harness({ responder: async () => (++n === 1 ? failResult('RESULT_NOT_REPLAYABLE', 'x') : okResult('fresh')) });
  h.startSession(1);
  await h.scheduler.start();
  await h.scheduler.readPageAgain('p1');
  assert.notEqual(h.log.calls[1].requestId, h.log.calls[0].requestId);
  assert.equal(h.scheduler.getState().pages[0].text, 'fresh');
});

test('a terminal refusal is not retried automatically', async () => {
  const h = harness({ responder: async () => failResult('NOT_AUTHORIZED', 'no') });
  h.startSession(2);
  await h.scheduler.start();
  assert.equal(h.log.calls.length, 2);
});

test('progress reports per page and overall', async () => {
  const h = harness({ hold: new Set(['p1']) });
  h.startSession(3);
  const run = h.scheduler.start();
  await h.gates.get('p1').e;
  assert.match(h.scheduler.getState().progressLabel, /Reading page \d of 3/);
  h.gates.get('p1').release();
  await run;
  assert.equal(h.scheduler.getState().progressLabel, '3 of 3 pages ready');
});

// ---------------------------------------------------------------------------
// Scope guards
// ---------------------------------------------------------------------------

test('no data URL survives settlement and the module makes no direct calls', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../document-transcription-scheduler.js', import.meta.url), 'utf8');
  for (const forbidden of ['supabase', 'netlify/functions', 'fetch(', 'toDataURL', 'import ']) {
    assert.equal(src.includes(forbidden), false, `5B must not contain ${forbidden}`);
  }
  const h = harness();
  h.startSession(4);
  await h.scheduler.start();
  assert.equal(h.log.liveDataUrls, 0);
  assert.equal(JSON.stringify(h.scheduler.getState()).includes('data:image'), false);
});

test('5B writes nothing: the exported API has no save, upload, or finalize', () => {
  const api = createTranscriptionScheduler({ transcribe: async () => okResult('t'), blobToDataUrl: async () => 'd', newRequestId: () => 'r' });
  assert.deepEqual(Object.keys(api).filter((k) => k !== '_debug').sort(), [
    'endSession', 'getState', 'markEdited', 'readPageAgain', 'resolveStrongerChoice',
    'resumeQueue', 'retryPage', 'startSession', 'start', 'syncPages', 'tryStrongerReading',
  ].sort());
});

// ---------------------------------------------------------------------------
// The resume transition must be reachable
// ---------------------------------------------------------------------------

test('after a 429 and a targeted retry, resume is offered exactly once and dispatches only then', async () => {
  let limited = true;
  const h = harness({ responder: async (req) => (limited && req.pageNumber === 1
    ? failResult('RATE_LIMITED', 'limit') : okResult('t')) });
  h.startSession(5);
  await h.scheduler.start();

  const paused = h.scheduler.getState();
  assert.ok(paused.halted, 'halted');
  assert.ok(paused.pages.filter((p) => p.state === 'waiting').length >= 3, 'the rest are paused');
  assert.equal(paused.canResumeQueue, true, 'resume is offered while paused');

  limited = false;
  const afterHalt = h.log.calls.length;
  await h.scheduler.retryPage('p1');
  assert.equal(h.log.calls.length, afterHalt + 1, 'the targeted retry adds exactly one request');
  assert.equal(h.scheduler.getState().canResumeQueue, true, 'and resume is still offered afterwards');

  const before = h.log.calls.length;
  const out = await h.scheduler.resumeQueue();
  assert.ok(out.resumed >= 2);
  assert.ok(h.log.calls.length > before, 'only resume dispatches the remainder');
  assert.equal(h.log.peakActive, 2, 'still the shared two-slot allocator');

  const done = h.scheduler.getState();
  assert.equal(done.canResumeQueue, false, 'nothing left to resume');
  assert.equal(done.allSettled, true);
});

test('resume is not offered while jobs are queued or reading, so taps cannot double-queue', async () => {
  const h = harness({ hold: new Set(['p1', 'p2']) });
  h.startSession(4);
  const run = h.scheduler.start();
  await h.gates.get('p1').e; await h.gates.get('p2').e;
  assert.equal(h.scheduler.getState().canResumeQueue, false, 'hidden while the queue is moving');

  const a = h.scheduler.resumeQueue();
  const b = h.scheduler.resumeQueue();          // a second tap
  h.gates.get('p1').release(); h.gates.get('p2').release();
  await Promise.all([run, a, b]);

  const perPage = {};
  for (const c of h.log.calls) perPage[c.blobId] = (perPage[c.blobId] || 0) + 1;
  assert.deepEqual(Object.values(perPage), [1, 1, 1, 1], 'no page was requested twice');
  assert.equal(h.log.peakActive, 2);
});

test('a second 429 halts the resumed queue again', async () => {
  let failOn = 1;
  const h = harness({ responder: async (req) => (req.pageNumber === failOn
    ? failResult('RATE_LIMITED', 'limit') : okResult('t')) });
  h.startSession(5);
  await h.scheduler.start();
  assert.ok(h.scheduler.getState().halted);

  failOn = 3;                                   // the next wall
  await h.scheduler.retryPage('p1');
  const before = h.log.calls.length;
  await h.scheduler.resumeQueue();
  assert.ok(h.scheduler.getState().halted, 'the resumed queue halts again');
  assert.ok(h.log.calls.length > before);
  assert.ok(h.scheduler.getState().pages.some((p) => p.state === 'waiting'), 'pages remain paused');
  assert.equal(h.scheduler.getState().canResumeQueue, true, 'and resume is offered again');
});

test('canResumeQueue is false when every page has settled', async () => {
  const h = harness();
  h.startSession(3);
  await h.scheduler.start();
  assert.equal(h.scheduler.getState().canResumeQueue, false);
});
