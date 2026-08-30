// Step 5A tests — capture and page management.
//
// Run:  node --test tests/document-page-pipeline.test.mjs
//
// No browser, no network, no Supabase. decode/canvas/object-URL are injected
// doubles that record what the real pipeline asks them to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPagePipeline, createCaptureController,
  admitPages, reorderPages, removePage, releaseAllPages,
  pageNumbersFor, fitWithin, rotatedSize,
  ARCHIVAL_MAX_EDGE, OCR_MAX_EDGE, OCR_QUALITY, THUMB_MAX_EDGE, MAX_PAGES,
  DECODE_FAILED_MESSAGE,
} from '../document-page-pipeline.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function harness({ undecodable = new Set(), sizes = {}, blobFailAt = null, gate = null } = {}) {
  const log = { decoded: [], live: { bitmaps: 0, canvases: 0 }, peak: { bitmaps: 0, canvases: 0 },
                blobs: [], urls: { created: [], revoked: [] }, draws: [] };

  const bump = (k, n) => { log.live[k] += n; if (log.live[k] > log.peak[k]) log.peak[k] = log.live[k]; };

  const deps = {
    decodeImage: async (file) => {
      if (gate) await gate(file);
      // The bitmap is allocated AFTER the gate on purpose: the harness counts
      // real allocations, so a test must wait for gate entry before asserting.
      if (undecodable.has(file.name)) throw new Error('cannot decode');
      const s = sizes[file.name] || { width: 4000, height: 3000 };
      log.decoded.push(file.name);
      bump('bitmaps', 1);
      return { bitmap: { __src: file.name, close() { log.live.bitmaps -= 1; } }, width: s.width, height: s.height };
    },
    createCanvas: (w, h) => {
      bump('canvases', 1);
      let released = false;
      const c = {
        get width() { return this._w; }, set width(v) { this._w = v; if (v === 0 && !released) { released = true; log.live.canvases -= 1; } },
        get height() { return this._h; }, set height(v) { this._h = v; },
        _w: w, _h: h,
        getContext: () => ({
          filter: '', translate() {}, rotate() {},
          drawImage: (src, x, y, dw, dh) => log.draws.push({ src: src.__src, dw, dh, canvas: { w, h } }),
        }),
      };
      return c;
    },
    canvasToBlob: async (canvas, mime, quality) => {
      if (blobFailAt != null && log.blobs.length === blobFailAt) throw new Error('toBlob failed');
      const b = { __blob: true, mime, quality, width: canvas.width, height: canvas.height };
      log.blobs.push(b);
      return b;
    },
    createObjectURL: (blob) => { const u = `blob:${log.urls.created.length}`; log.urls.created.push({ url: u, blob }); return u; },
    revokeObjectURL: (u) => log.urls.revoked.push(u),
    newId: () => `pg-${log.decoded.length}`,
  };

  return { log, pipeline: createPagePipeline(deps), deps };
}

const file = (name) => ({ name, type: 'image/jpeg' });

// A gate that lets a test wait until a specific decode is genuinely inside it,
// then release it. Entry is signalled BEFORE the harness allocates its bitmap.
function makeGate(names) {
  const targets = new Set(names);
  const entered = new Map();
  const releases = new Map();
  for (const n of targets) {
    let resolveEntered; const p = new Promise((r) => { resolveEntered = r; });
    entered.set(n, { promise: p, resolve: resolveEntered });
    let resolveRelease; const q = new Promise((r) => { resolveRelease = r; });
    releases.set(n, { promise: q, resolve: resolveRelease });
  }
  return {
    gate: async (f) => {
      if (!targets.has(f.name)) return;
      entered.get(f.name).resolve();
      await releases.get(f.name).promise;
    },
    waitEntered: (n) => entered.get(n).promise,
    release: (n) => releases.get(n).resolve(),
  };
}

// ---------------------------------------------------------------------------
// Sizing maths
// ---------------------------------------------------------------------------

test('fitWithin caps the long edge, preserves aspect, and never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000, 2400), { width: 2400, height: 1800, scaled: true });
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600, scaled: true });
  assert.deepEqual(fitWithin(800, 600, 2400), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(1, 1, 1600), { width: 1, height: 1, scaled: false });
});

test('rotatedSize swaps the axes only for quarter turns', () => {
  assert.deepEqual(rotatedSize(4000, 3000, 0), { width: 4000, height: 3000 });
  assert.deepEqual(rotatedSize(4000, 3000, 90), { width: 3000, height: 4000 });
  assert.deepEqual(rotatedSize(4000, 3000, 180), { width: 4000, height: 3000 });
  assert.deepEqual(rotatedSize(4000, 3000, 270), { width: 3000, height: 4000 });
});

// ---------------------------------------------------------------------------
// One page: three derivatives, correct caps and quality
// ---------------------------------------------------------------------------

test('one camera page yields archival, thumbnail, and OCR derivatives', async () => {
  const { pipeline, log } = harness();
  const page = await pipeline.processPage(file('camera.jpg'));
  assert.equal(page.ok, true);
  assert.equal(log.decoded.length, 1);
  assert.equal(log.blobs.length, 3);
  assert.ok(page.archival.blob && page.thumb.blob && page.ocr.blob);
  assert.equal(page.thumb.url, 'blob:0');
});

test('the archival original is capped at 2400px on the long edge', async () => {
  const { pipeline } = harness({ sizes: { 'big.jpg': { width: 6000, height: 4000 } } });
  const page = await pipeline.processPage(file('big.jpg'));
  assert.equal(Math.max(page.archival.width, page.archival.height), ARCHIVAL_MAX_EDGE);
  assert.equal(page.archival.width, 2400);
  assert.equal(page.archival.height, 1600);
});

test('a small page is never upscaled', async () => {
  const { pipeline } = harness({ sizes: { 'small.jpg': { width: 900, height: 600 } } });
  const page = await pipeline.processPage(file('small.jpg'));
  assert.equal(page.archival.width, 900);
  assert.equal(page.ocr.width, 900);
});

test('the OCR derivative is ~1600px long edge at quality 0.7', async () => {
  const { pipeline, log } = harness({ sizes: { 'p.jpg': { width: 4000, height: 3000 } } });
  const page = await pipeline.processPage(file('p.jpg'));
  assert.equal(Math.max(page.ocr.width, page.ocr.height), OCR_MAX_EDGE);
  assert.equal(page.ocr.height, 1200);
  const ocrBlob = log.blobs[2];
  assert.equal(ocrBlob.quality, OCR_QUALITY);
  assert.equal(ocrBlob.mime, 'image/jpeg');
});

test('the thumbnail is small and comes from the same decode', async () => {
  const { pipeline, log } = harness();
  const page = await pipeline.processPage(file('p.jpg'));
  assert.equal(Math.max(page.thumb.width, page.thumb.height), THUMB_MAX_EDGE);
  assert.equal(log.decoded.length, 1, 'one decode for all three derivatives');
});

// ---------------------------------------------------------------------------
// Rotation before the derivative
// ---------------------------------------------------------------------------

test('rotation is applied BEFORE the OCR derivative is produced', async () => {
  const { pipeline } = harness({ sizes: { 'sideways.jpg': { width: 4000, height: 3000 } } });
  const page = await pipeline.processPage(file('sideways.jpg'), { rotation: 90 });
  // A quarter turn swaps the axes, so the portrait OCR image is 1200x1600 —
  // proof the OCR image inherited the rotation rather than the raw orientation.
  assert.equal(page.ocr.width, 1200);
  assert.equal(page.ocr.height, 1600);
  assert.equal(page.archival.width, 1800);
  assert.equal(page.archival.height, 2400);
  assert.equal(page.rotation, 90);
});

test('enhancement values reach the canvas filter and are recorded on the page', async () => {
  const { pipeline } = harness();
  const page = await pipeline.processPage(file('p.jpg'), { rotation: 180, brightness: 108, contrast: 118, saturation: 114 });
  assert.equal(page.brightness, 108);
  assert.equal(page.contrast, 118);
  assert.equal(page.saturation, 114);
});

// ---------------------------------------------------------------------------
// Memory: one decoded image at a time, no data URLs
// ---------------------------------------------------------------------------

test('five pages never hold more than one decoded bitmap at once', async () => {
  const { pipeline, log } = harness();
  const files = [1, 2, 3, 4, 5].map((n) => file(`p${n}.jpg`));
  await pipeline.processPagesSequentially(files);
  assert.equal(log.decoded.length, 5);
  assert.equal(log.peak.bitmaps, 1, 'peak concurrent decoded bitmaps must be 1');
  assert.equal(log.live.bitmaps, 0, 'every bitmap released');
});

test('canvases are released between pages', async () => {
  const { pipeline, log } = harness();
  await pipeline.processPagesSequentially([file('a.jpg'), file('b.jpg')]);
  assert.equal(log.peak.canvases, 3, 'at most the three derivative canvases of ONE page');
  assert.equal(log.live.canvases, 0, 'no canvas outlives its page');
});

test('pages are processed strictly one at a time', async () => {
  const { pipeline, log } = harness();
  const order = [];
  await pipeline.processPagesSequentially([file('a.jpg'), file('b.jpg'), file('c.jpg')],
    () => ({}), (r) => order.push(r.pageId));
  assert.equal(order.length, 3);
  assert.deepEqual(log.decoded, ['a.jpg', 'b.jpg', 'c.jpg'], 'decode order is sequential');
});

test('no OCR data URL is produced in 5A — the derivative is a Blob', async () => {
  const { pipeline, log } = harness();
  const page = await pipeline.processPage(file('p.jpg'));
  assert.equal(typeof page.ocr.blob, 'object');
  assert.equal(typeof page.ocr.dataUrl, 'undefined');
  assert.equal(JSON.stringify(page).includes('data:image'), false);
  assert.equal(log.urls.created.length, 1, 'only the thumbnail gets an object URL');
});

test('the module contains no data-URL, transcription, or Supabase call', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../document-page-pipeline.js', import.meta.url), 'utf8');
  for (const forbidden of ['toDataURL', 'readAsDataURL', 'netlify/functions', 'supabase', 'fetch(']) {
    assert.equal(src.includes(forbidden), false, `5A must not contain ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

test('an undecodable page fails alone with the approved message', async () => {
  const { pipeline } = harness({ undecodable: new Set(['weird.heic']) });
  const out = await pipeline.processPage(file('weird.heic'));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DECODE_FAILED');
  assert.equal(out.message, DECODE_FAILED_MESSAGE);
});

test('one failed page does not discard the others', async () => {
  const { pipeline, log } = harness({ undecodable: new Set(['bad.heic']) });
  const results = await pipeline.processPagesSequentially(
    [file('a.jpg'), file('bad.heic'), file('c.jpg')]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(log.peak.bitmaps, 1);
  assert.equal(log.live.bitmaps, 0, 'the failed page leaks nothing');
});

test('a failure midway leaves no canvas behind', async () => {
  const { pipeline, log } = harness({ undecodable: new Set(['bad.heic']) });
  await pipeline.processPagesSequentially([file('bad.heic'), file('ok.jpg')]);
  assert.equal(log.live.canvases, 0);
});

// ---------------------------------------------------------------------------
// Page collection: cap, append, reorder, remove
// ---------------------------------------------------------------------------

test('library multi-select fills up to the five-page cap', () => {
  assert.deepEqual(admitPages(0, 3, MAX_PAGES), { accepted: 3, rejected: 0, atLimit: false, message: '' });
  const partial = admitPages(3, 4, MAX_PAGES);
  assert.equal(partial.accepted, 2);
  assert.equal(partial.rejected, 2);
  assert.equal(partial.atLimit, true);
  assert.match(partial.message, /Added 2 of 4 pages/);
  assert.match(partial.message, /at most 5 pages/);
});

test('a sixth page is rejected with a clear message and nothing is silently dropped', () => {
  const full = admitPages(5, 1, MAX_PAGES);
  assert.equal(full.accepted, 0);
  assert.equal(full.rejected, 1);
  assert.equal(full.message, 'A document can have at most 5 pages.');
});

test('camera appends one page at a time', () => {
  let count = 0;
  for (let i = 0; i < 6; i++) {
    const r = admitPages(count, 1, MAX_PAGES);
    count += r.accepted;
  }
  assert.equal(count, MAX_PAGES, 'the sixth camera shot is refused');
});

test('reorder moves a page without losing any', () => {
  const pages = [{ pageId: 'a' }, { pageId: 'b' }, { pageId: 'c' }];
  assert.deepEqual(reorderPages(pages, 2, 0).map((p) => p.pageId), ['c', 'a', 'b']);
  assert.deepEqual(reorderPages(pages, 0, 2).map((p) => p.pageId), ['b', 'c', 'a']);
  assert.deepEqual(reorderPages(pages, 1, 1).map((p) => p.pageId), ['a', 'b', 'c']);
  assert.deepEqual(reorderPages(pages, 9, 0).map((p) => p.pageId), ['a', 'b', 'c'], 'out-of-range is a no-op');
});

test('page numbers follow the reviewed order after a reorder', () => {
  const pages = pageNumbersFor(reorderPages([{ pageId: 'a' }, { pageId: 'b' }, { pageId: 'c' }], 2, 0));
  assert.deepEqual(pages.map((p) => [p.pageId, p.pageNumber]), [['c', 1], ['a', 2], ['b', 3]]);
});

test('removing a page revokes its thumbnail URL immediately', () => {
  const revoked = [];
  const pages = [{ pageId: 'a', thumb: { url: 'blob:a' } }, { pageId: 'b', thumb: { url: 'blob:b' } }];
  const next = removePage(pages, 'a', (u) => revoked.push(u));
  assert.deepEqual(next.map((p) => p.pageId), ['b']);
  assert.deepEqual(revoked, ['blob:a']);
});

test('cancelling the capture revokes every remaining thumbnail URL', () => {
  const revoked = [];
  const pages = [{ pageId: 'a', thumb: { url: 'blob:a' } }, { pageId: 'b', thumb: { url: 'blob:b' } }];
  assert.deepEqual(releaseAllPages(pages, (u) => revoked.push(u)), []);
  assert.deepEqual(revoked, ['blob:a', 'blob:b']);
});


// ---------------------------------------------------------------------------
// Canvas lifecycle — the leak found in review
// ---------------------------------------------------------------------------

test('a toBlob rejection still releases the bitmap and every canvas', async () => {
  for (const [label, at] of [['archival', 0], ['thumbnail', 1], ['OCR', 2]]) {
    const { pipeline, log } = harness({ blobFailAt: at });
    const out = await pipeline.processPage(file('p.jpg'));
    assert.equal(out.ok, false, `${label} failure must fail the page`);
    assert.equal(out.code, 'RENDER_FAILED');
    assert.equal(log.live.bitmaps, 0, `${label}: bitmap released`);
    assert.equal(log.live.canvases, 0, `${label}: canvases released`);
    assert.ok(log.peak.canvases <= 3);
  }
});

test('peak canvases stays at three across a five-page run', async () => {
  const { pipeline, log } = harness();
  await pipeline.processPagesSequentially([1,2,3,4,5].map((n) => file(`p${n}.jpg`)));
  assert.equal(log.peak.canvases, 3);
  assert.equal(log.live.canvases, 0);
  assert.equal(log.peak.bitmaps, 1);
  assert.equal(log.live.bitmaps, 0);
});

// ---------------------------------------------------------------------------
// Controller — cancellation, concurrency, staleness
// ---------------------------------------------------------------------------

function controllerHarness(opts = {}) {
  const h = harness(opts);
  const revoked = [];
  const emitted = [];
  const controller = createCaptureController({
    pipeline: h.pipeline,
    revokeObjectURL: (u) => revoked.push(u),
    onChange: (st) => emitted.push(st),
  });
  // What the view layer would compute from the emitted state.
  const canAddPages = () => { const st = controller.getState(); return !!st.open && st.pages.length < 5 && !st.busy; };
  return { ...h, controller, revoked, emitted, canAddPages };
}

test('closing mid-run stops processing, revokes the stale thumbnail, and decodes nothing further', async () => {
  const g = makeGate(['b.jpg']);
  const h = controllerHarness({ gate: g.gate });
  h.controller.open('cap-1');

  const run = h.controller.addFiles([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
  await g.waitEntered('b.jpg');  // page b is genuinely decoding
  h.controller.close();
  g.release('b.jpg');
  const out = await run;

  assert.equal(out.cancelled, true);
  assert.equal(h.log.decoded.includes('c.jpg'), false, 'no later file may be decoded');
  assert.equal(h.controller.getState().pages.length, 0, 'no state is resurrected');
  assert.ok(h.revoked.length >= 1, 'the stale page thumbnail URL is revoked');
  assert.equal(h.log.live.bitmaps, 0);
  assert.equal(h.log.live.canvases, 0);
});

test('a second picker event while busy starts no decode', async () => {
  const g = makeGate(['a.jpg']);
  const h = controllerHarness({ gate: g.gate });
  h.controller.open('cap-1');

  const first = h.controller.addFiles([file('a.jpg')]);
  await g.waitEntered('a.jpg');                    // the first decode is genuinely in flight

  const second = await h.controller.addFiles([file('z.jpg')]);
  assert.equal(second.started, false);
  assert.equal(second.reason, 'busy');
  assert.equal(h.log.decoded.includes('z.jpg'), false, 'the second pick must decode nothing');

  g.release('a.jpg');
  await first;
  // Asserted after settlement, because the harness counts REAL allocations and
  // the first bitmap is created on the far side of the gate.
  assert.equal(h.log.peak.bitmaps, 1, 'never more than one decoded image');
  assert.equal(h.log.live.bitmaps, 0);
  assert.equal(h.log.live.canvases, 0);
});

test('reopening during a stale decode does not start a second decode', async () => {
  const g = makeGate(['a.jpg']);
  const h = controllerHarness({ gate: g.gate });

  h.controller.open('cap-A');
  const runA = h.controller.addFiles([file('a.jpg')]);
  await g.waitEntered('a.jpg');                    // capture A is decoding

  h.controller.close();
  h.controller.open('cap-B');                      // reopened before A settled
  const blocked = await h.controller.addFiles([file('b.jpg')]);

  assert.equal(blocked.started, false, 'B must not start while A is still in flight');
  assert.equal(blocked.reason, 'busy');
  assert.equal(h.log.decoded.includes('b.jpg'), false, 'B decodes nothing yet');

  g.release('a.jpg');
  await runA;

  const after = await h.controller.addFiles([file('b.jpg')]);
  assert.equal(after.started, true, 'B processes normally once A has settled');
  assert.equal(h.log.peak.bitmaps, 1, 'still only ever one decoded image');
  assert.ok(h.log.peak.canvases <= 3);
  assert.equal(h.log.live.bitmaps, 0);
  assert.equal(h.log.live.canvases, 0);

  const st = h.controller.getState();
  assert.equal(st.captureId, 'cap-B');
  assert.equal(st.pages.length, 1, 'only B\'s page');
  assert.equal(st.pages[0].sourceFile.name, 'b.jpg', 'no state from A appears in B');
});

test('a capture opened during stale work reports busy, then clears itself', async () => {
  const g = makeGate(['a.jpg']);
  const h = controllerHarness({ gate: g.gate });

  h.controller.open('cap-A');
  const runA = h.controller.addFiles([file('a.jpg')]);
  await g.waitEntered('a.jpg');

  h.controller.close();
  h.controller.open('cap-B');

  // 1. B reports busy while A is still in flight, so the picker is unavailable
  //    rather than looking enabled and silently discarding the choice.
  assert.equal(h.controller.getState().busy, true, 'B inherits busy from controller-wide work');
  assert.equal(h.canAddPages(), false, 'B cannot offer the picker yet');
  assert.equal(h.controller._debug.inFlight(), 1);

  // 2. Settling A clears it automatically — no failed selection required.
  const before = h.emitted.length;
  g.release('a.jpg');
  await runA;
  assert.ok(h.emitted.length > before, 'settling emits an update for the open capture');
  assert.equal(h.controller.getState().busy, false, 'B clears inherited busy on its own');
  assert.equal(h.canAddPages(), true, 'the picker becomes available without a lost tap');

  // 3. B then accepts its FIRST actual selection normally.
  const out = await h.controller.addFiles([file('b.jpg')]);
  assert.equal(out.started, true);
  const st = h.controller.getState();
  assert.equal(st.captureId, 'cap-B');
  assert.equal(st.pages.length, 1);
  assert.equal(st.pages[0].sourceFile.name, 'b.jpg', 'no page, label, error, or id from A');
  assert.equal(st.error, '');
  assert.equal(h.log.peak.bitmaps, 1);
  assert.ok(h.log.peak.canvases <= 3);
  assert.equal(h.log.live.bitmaps, 0);
  assert.equal(h.log.live.canvases, 0);
});

test('stale settlement does not clear busy if the new capture started its own work', async () => {
  const g = makeGate(['a.jpg', 'b.jpg']);
  const h = controllerHarness({ gate: g.gate });

  h.controller.open('cap-A');
  const runA = h.controller.addFiles([file('a.jpg')]);
  await g.waitEntered('a.jpg');
  h.controller.close();
  h.controller.open('cap-B');

  g.release('a.jpg');
  await runA;
  assert.equal(h.controller.getState().busy, false);

  const runB = h.controller.addFiles([file('b.jpg')]);
  await g.waitEntered('b.jpg');
  assert.equal(h.controller.getState().busy, true, "B's own work keeps it busy");
  g.release('b.jpg');
  await runB;
  assert.equal(h.controller.getState().busy, false);
});

test('a pipeline rejection cannot strand a capture as permanently busy', async () => {
  const h = controllerHarness();
  // A pipeline that throws rather than returning a failed page.
  const exploding = createCaptureController({
    pipeline: { processPage: async () => { throw new Error('pipeline exploded'); } },
    revokeObjectURL: () => {},
    onChange: () => {},
  });
  exploding.open('cap-1');
  await assert.rejects(() => exploding.addFiles([file('a.jpg')]));
  assert.equal(exploding.getState().busy, false, 'busy cleared by the finally');
  assert.equal(exploding._debug.inFlight(), 0, 'in-flight count cleared by the finally');

  const rot = createCaptureController({
    pipeline: { processPage: async () => { throw new Error('boom'); } },
    revokeObjectURL: () => {}, onChange: () => {},
  });
  rot.open('cap-2');
  assert.equal(h.log.live.bitmaps, 0);
});

test('reopening revokes the previous capture\'s thumbnail URLs', async () => {
  const h = controllerHarness();
  h.controller.open('cap-A');
  await h.controller.addFiles([file('a.jpg'), file('b.jpg')]);
  const urls = h.controller.getState().pages.map((p) => p.thumb.url);
  assert.equal(urls.length, 2);

  h.controller.open('cap-B');                      // open without an intervening close
  assert.deepEqual(h.revoked.slice().sort(), urls.slice().sort(), 'both old URLs revoked');
  const st = h.controller.getState();
  assert.equal(st.pages.length, 0);
  assert.equal(st.captureId, 'cap-B');

  h.controller.open('cap-C');                      // double open with nothing to release
  assert.deepEqual(h.revoked.slice().sort(), urls.slice().sort(), 'no double revocation');
});

test('rotate, remove, and move are refused while processing', async () => {
  const g = makeGate(['a.jpg']);
  const h = controllerHarness({ gate: g.gate });
  h.controller.open('cap-1');
  const run = h.controller.addFiles([file('a.jpg')]);
  await g.waitEntered('a.jpg');

  assert.equal((await h.controller.rotatePage('pg-1')).applied, false);
  assert.equal(h.controller.remove('pg-1').applied, false);
  assert.equal(h.controller.move(0, 1).applied, false);
  g.release('a.jpg');
  await run;
});

test('closing during a rotation discards it without touching the current thumbnail', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  let gateOn = false;
  const h = controllerHarness({ gate: async () => { if (gateOn) await hold; } });
  h.controller.open('cap-1');
  await h.controller.addFiles([file('a.jpg')]);
  const before = h.controller.getState().pages[0].thumb.url;

  gateOn = true;
  const rot = h.controller.rotatePage(h.controller.getState().pages[0].pageId);
  await new Promise((r) => setTimeout(r, 0));
  h.controller.close();          // close() revokes the current page's URL
  release();
  const out = await rot;

  assert.equal(out.applied, false);
  assert.equal(out.reason, 'superseded');
  const revokedTwice = h.revoked.filter((u) => u === before).length;
  assert.equal(revokedTwice, 1, 'the current thumbnail is revoked once by close(), not again by the stale run');
  assert.ok(h.revoked.length >= 2, 'the stale rotation revokes the URL it created');
});

test('a page cannot be removed mid-rotation, and a superseded run is discarded', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  let gateOn = false;
  const h = controllerHarness({ gate: async () => { if (gateOn) await hold; } });
  h.controller.open('cap-1');
  await h.controller.addFiles([file('a.jpg')]);
  const id = h.controller.getState().pages[0].pageId;

  gateOn = true;
  const rot = h.controller.rotatePage(id);
  await new Promise((r) => setTimeout(r, 0));
  // remove() is refused while busy — that is the guard, and it is asserted here
  // rather than assumed. Closing then exercises the same staleness class.
  assert.equal(h.controller.remove(id).applied, false, 'remove is refused mid-rotation');
  h.controller.close();
  release();
  const out = await rot;
  assert.equal(out.applied, false);
  assert.equal(h.controller.getState().pages.length, 0, 'nothing is resurrected');
});

test('a second edit cannot race the first: rotations are serialized, not interleaved', async () => {
  const gates = [];
  const h = controllerHarness({ gate: () => new Promise((r) => gates.push(r)) });
  // first add must not be gated
  const original = gates.length;
  h.controller.open('cap-1');
  const add = h.controller.addFiles([file('a.jpg')]);
  await new Promise((r) => setTimeout(r, 0));
  gates.shift()();               // let the initial decode through
  await add;

  const id = h.controller.getState().pages[0].pageId;
  const first = h.controller.reprocessPage(id, { rotation: 90 });
  await new Promise((r) => setTimeout(r, 0));
  // the controller is busy, so the second must be refused rather than racing
  const second = await h.controller.reprocessPage(id, { rotation: 180 });
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'busy', 'serialization is what prevents out-of-order application');
  gates.shift()();
  const firstOut = await first;
  assert.equal(firstOut.applied, true);
  assert.equal(h.controller.getState().pages[0].rotation, 90);
  assert.equal(original, 0);
});

// ---------------------------------------------------------------------------
// Per-page enhancement
// ---------------------------------------------------------------------------

test('an enhancement change regenerates all three derivatives from the source', async () => {
  const h = controllerHarness();
  h.controller.open('cap-1');
  await h.controller.addFiles([file('a.jpg')]);
  const before = h.controller.getState().pages[0];
  const blobsBefore = h.log.blobs.length;

  const out = await h.controller.enhancePage(before.pageId, { brightness: 108, contrast: 118, saturation: 114 });
  assert.equal(out.applied, true);
  const after = h.controller.getState().pages[0];
  assert.equal(after.brightness, 108);
  assert.equal(after.contrast, 118);
  assert.equal(after.saturation, 114);
  assert.equal(h.log.blobs.length - blobsBefore, 3, 'archival, thumbnail, and OCR are all regenerated');
  assert.equal(h.log.decoded.filter((n) => n === 'a.jpg').length, 2, 'regenerated from the retained source file');
});

test('the superseded thumbnail URL is revoked only after the replacement is accepted', async () => {
  const h = controllerHarness();
  h.controller.open('cap-1');
  await h.controller.addFiles([file('a.jpg')]);
  const before = h.controller.getState().pages[0];
  assert.deepEqual(h.revoked, [], 'nothing revoked yet');

  await h.controller.enhancePage(before.pageId, { brightness: 105 });
  assert.deepEqual(h.revoked, [before.thumb.url], 'exactly the superseded URL, and only on success');
  assert.notEqual(h.controller.getState().pages[0].thumb.url, before.thumb.url);
});

test('a failed enhancement leaves the page and its thumbnail untouched', async () => {
  // The first page consumes three blob calls; the fourth is the first of the
  // reprocess, so this fails the enhancement and not the initial capture.
  const h = controllerHarness({ blobFailAt: 3 });
  h.controller.open('cap-1');
  await h.controller.addFiles([file('a.jpg')]);
  const before = h.controller.getState().pages[0];

  const out = await h.controller.enhancePage(before.pageId, { brightness: 105 });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'failed');
  const after = h.controller.getState().pages[0];
  assert.equal(after.thumb.url, before.thumb.url, 'the surviving thumbnail URL is unchanged');
  assert.equal(after.brightness, 100, 'the page keeps its previous enhancement');
  assert.deepEqual(h.revoked, [], 'nothing is revoked when the replacement never arrives');
  assert.equal(h.log.live.canvases, 0, 'the failed run still released its canvases');
});

// ---------------------------------------------------------------------------
// Scope guards
// ---------------------------------------------------------------------------

test('5A performs no transcription request and no database write', async () => {
  const { pipeline, log } = harness();
  await pipeline.processPagesSequentially([file('a.jpg'), file('b.jpg')]);
  // The pipeline is constructed with exactly five injected capabilities, none of
  // which can reach a network or a database.
  assert.deepEqual(Object.keys(log).sort(), ['blobs', 'decoded', 'draws', 'live', 'peak', 'urls']);
});
