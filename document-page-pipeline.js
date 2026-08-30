// ===========================================================================
// document-page-pipeline.js — Step 5A: capture and page management.
//
//   Pure factory module: imports nothing, references no global, no module-scope
//   side effects. Every browser API (decode, canvas, object URLs) is injected,
//   so `node --test` exercises the real logic with doubles.
//
//   MEMORY CONTRACT — the reason this module exists.
//   Pages are processed STRICTLY ONE AT A TIME. Within one page the decoded
//   bitmap and every intermediate canvas are released before the function
//   returns, so at most ONE decoded full-resolution image exists at any moment,
//   no matter how many pages are queued. The OCR derivative is kept as a BLOB,
//   never a data URL: the base64 string is minted just-in-time in 5B, for one
//   page, and dropped as soon as that request settles.
//
//   Order is fixed and matters: decode -> ROTATE -> enhance -> archival ->
//   thumbnail -> OCR derivative. The OCR image therefore inherits the user's
//   rotation, which is the single biggest lever on transcription accuracy.
// ===========================================================================

export const ARCHIVAL_MAX_EDGE = 2400;   // document originals only
export const ARCHIVAL_QUALITY = 0.85;
export const THUMB_MAX_EDGE = 320;
export const THUMB_QUALITY = 0.7;
export const OCR_MAX_EDGE = 1600;        // approved OCR derivative
export const OCR_QUALITY = 0.7;
export const MAX_PAGES = 5;

export const DECODE_FAILED_MESSAGE = 'Couldn’t read this photo — try again.';
export const PAGE_LIMIT_MESSAGE = `A document can have at most ${MAX_PAGES} pages.`;

// Longest edge capped, aspect preserved, never upscaled.
export function fitWithin(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const k = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

export function rotatedSize(width, height, rotation) {
  return (rotation === 90 || rotation === 270) ? { width: height, height: width } : { width, height };
}

export function createPagePipeline(deps) {
  const {
    decodeImage,        // (file) -> { bitmap, width, height }  — throws on undecodable input
    createCanvas,       // (w, h) -> canvas with getContext('2d')
    canvasToBlob,       // (canvas, mime, quality) -> Blob
    releaseBitmap = (b) => { if (b && typeof b.close === 'function') b.close(); },
    createObjectURL,
    revokeObjectURL,
    newId = () => `pg-${Math.random().toString(16).slice(2)}`,
  } = deps || {};

  // Draws source -> a fresh canvas at the target size, applying rotation and the
  // enhancement filter. The canvas is returned to the caller, which releases it.
  function renderTo(source, srcW, srcH, maxEdge, { rotation = 0, brightness = 100, contrast = 100, saturation = 100 } = {}) {
    const r = rotatedSize(srcW, srcH, rotation);
    const fit = fitWithin(r.width, r.height, maxEdge);
    const canvas = createCanvas(fit.width, fit.height);
    const ctx = canvas.getContext('2d');
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    ctx.translate(fit.width / 2, fit.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    const drawW = (rotation === 90 || rotation === 270) ? fit.height : fit.width;
    const drawH = (rotation === 90 || rotation === 270) ? fit.width : fit.height;
    ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
    return { canvas, width: fit.width, height: fit.height };
  }

  // ONE page. Everything large is released before this resolves.
  async function processPage(file, options = {}) {
    const pageId = options.pageId || newId();
    let decoded = null;
    let canvases = [];
    // Tracks the CANVAS, not the wrapper object. An earlier version pushed the
    // { canvas, width, height } wrapper and then zeroed the wrapper's own
    // width/height, which released nothing at all and leaked three canvases per
    // page.
    const render = (...args) => {
      const out = renderTo(...args);
      canvases.push(out.canvas);
      return out;
    };
    const releaseAll = () => {
      for (const c of canvases) { try { c.width = 0; c.height = 0; } catch (e) { /* detached */ } }
      canvases = [];
      if (decoded) { releaseBitmap(decoded.bitmap); decoded = null; }
    };

    try {
      decoded = await decodeImage(file);
    } catch (e) {
      // HEIC or any other undecodable input fails for THIS PAGE ONLY.
      return { ok: false, pageId, code: 'DECODE_FAILED', message: DECODE_FAILED_MESSAGE };
    }

    try {
      const { bitmap, width, height } = decoded;

      // 1. archival original — rotated and enhanced, long edge capped.
      const a = render(bitmap, width, height, ARCHIVAL_MAX_EDGE, options);
      const archivalBlob = await canvasToBlob(a.canvas, 'image/jpeg', ARCHIVAL_QUALITY);

      // 2. thumbnail — from the same source, not by re-decoding.
      const t = render(bitmap, width, height, THUMB_MAX_EDGE, options);
      const thumbBlob = await canvasToBlob(t.canvas, 'image/jpeg', THUMB_QUALITY);

      // 3. OCR derivative — LAST, and after rotation, so it reads the page the
      //    way the user sees it. Kept as a Blob; the data URL is minted in 5B.
      const o = render(bitmap, width, height, OCR_MAX_EDGE, options);
      const ocrBlob = await canvasToBlob(o.canvas, 'image/jpeg', OCR_QUALITY);

      const thumbUrl = createObjectURL(thumbBlob);

      return {
        ok: true, pageId,
        sourceWidth: width, sourceHeight: height,
        rotation: options.rotation || 0,
        brightness: options.brightness != null ? options.brightness : 100,
        contrast: options.contrast != null ? options.contrast : 100,
        saturation: options.saturation != null ? options.saturation : 100,
        archival: { blob: archivalBlob, width: a.width, height: a.height },
        thumb: { blob: thumbBlob, width: t.width, height: t.height, url: thumbUrl },
        ocr: { blob: ocrBlob, width: o.width, height: o.height },
      };
    } catch (e) {
      // A toBlob rejection after one or more canvases exist still lands in the
      // finally below, so nothing is left allocated.
      return { ok: false, pageId, code: 'RENDER_FAILED', message: DECODE_FAILED_MESSAGE };
    } finally {
      // The decoded bitmap and every canvas die here — before the next page is
      // touched, and on every exit path.
      releaseAll();
    }
  }

  // Sequential by construction: `await` inside the loop, so page N+1 is not
  // decoded until page N has released everything.
  async function processPagesSequentially(files, optionsFor = () => ({}), onPage = () => {}) {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const result = await processPage(files[i], optionsFor(files[i], i));
      results.push(result);
      onPage(result, i);
    }
    return results;
  }

  return { processPage, processPagesSequentially, renderTo };
}

// ---------------------------------------------------------------------------
// Capture controller — owns cancellation, concurrency, and staleness.
//
//   Every one of these hazards is a race, so none of them can be handled in the
//   view layer alone: a page can finish rendering after the sheet was closed,
//   after its page was removed, or after a newer edit superseded it. The
//   controller holds two tokens:
//     * a CAPTURE GENERATION, bumped on open and close;
//     * a per-page OPERATION SEQUENCE, bumped on every reprocess.
//   A result whose tokens no longer match is discarded — and its freshly created
//   thumbnail URL is revoked, because that URL is the leak.
// ---------------------------------------------------------------------------

export function createCaptureController({ pipeline, revokeObjectURL, onChange = () => {}, maxPages = MAX_PAGES }) {
  let state = { captureId: null, open: false, pages: [], busy: false, processingLabel: '', error: '' };
  let generation = 0;
  const ops = new Map();

  // CONTROLLER-WIDE in-flight count. Deliberately NOT reset by open() or
  // close(): a generation change cannot abort a processPage() that is already
  // decoding, so a mechanic who closes the sheet, reopens it, and picks a new
  // photo would otherwise start a second decode while the first is still
  // holding a bitmap. This is the guard that keeps "one decoded image at a
  // time" true across capture boundaries.
  let inFlight = 0;

  // Every decrement re-emits, so the currently open capture stops reporting
  // inherited busy the moment the stale work settles — without the mechanic
  // having to attempt and lose a selection. If the current capture has since
  // started its own work, state.busy is true and the emitted value stays busy.
  const enterFlight = () => { inFlight += 1; };
  const leaveFlight = () => { inFlight -= 1; if (inFlight === 0) emit(); };

  // state.busy is THIS capture's own work. The value handed to the UI also folds
  // in controller-wide in-flight work, because a capture opened while a stale
  // operation is still settling is not usable yet — and a picker that looks
  // enabled but silently discards the choice is worse than a disabled one.
  const view = () => ({ ...state, busy: state.busy || inFlight > 0, pages: state.pages.slice() });
  const emit = () => onChange(view());
  const set = (patch) => { state = { ...state, ...patch }; emit(); };
  const get = view;

  function open(captureId) {
    generation += 1;
    ops.clear();
    // Replacing an already-open capture must not strand its thumbnail URLs.
    releaseAllPages(state.pages, revokeObjectURL);
    state = { captureId, open: true, pages: [], busy: false, processingLabel: '', error: '' };
    emit();
    return generation;
  }

  function close() {
    generation += 1;
    ops.clear();
    releaseAllPages(state.pages, revokeObjectURL);
    state = { captureId: null, open: false, pages: [], busy: false, processingLabel: '', error: '' };
    emit();
  }

  // Discards a result that finished too late, revoking only the URL it created.
  function discardStale(result) {
    if (result && result.ok && result.thumb && result.thumb.url && revokeObjectURL) revokeObjectURL(result.thumb.url);
  }

  async function addFiles(files) {
    if (!state.open) return { started: false, reason: 'closed' };
    // Guarded in CODE, not only by a disabled control: two change events can
    // arrive before any re-render. inFlight also covers work left over from a
    // previous capture generation, which state.busy cannot see.
    if (state.busy || inFlight > 0) return { started: false, reason: 'busy' };

    const list = Array.from(files || []);
    if (!list.length) return { started: false, reason: 'empty' };

    const admit = admitPages(state.pages.length, list.length, maxPages);
    if (admit.message) set({ error: admit.message });
    const accepted = list.slice(0, admit.accepted);
    if (!accepted.length) return { started: false, reason: 'limit' };

    const myGen = generation;
    set({ busy: true, processingLabel: `Preparing page 1 of ${accepted.length}…` });

    try {
    for (let i = 0; i < accepted.length; i++) {
      if (generation !== myGen) return { started: true, cancelled: true, processed: i };
      set({ processingLabel: `Preparing page ${i + 1} of ${accepted.length}…` });

      enterFlight();
      let result;
      try {
        result = await pipeline.processPage(accepted[i], { rotation: 0, brightness: 100, contrast: 100, saturation: 100 });
      } finally {
        leaveFlight();
      }

      if (generation !== myGen) {
        // Closed or reopened while this page was rendering: drop it, revoke the
        // URL it just created, and decode nothing further.
        discardStale(result);
        return { started: true, cancelled: true, processed: i };
      }
      if (!result.ok) { set({ error: result.message }); continue; }
      state.pages = [...state.pages, { ...result, sourceFile: accepted[i] }];
      emit();
    }

    return { started: true, cancelled: false, processed: accepted.length };
    } finally {
      // Runs on the normal path, on an early cancelled return, and on any
      // unexpected throw.
      if (generation === myGen) set({ busy: false, processingLabel: '' });
    }
  }

  // Rotation and enhancement are the same operation: re-render ONE page from its
  // retained source so all three derivatives move together.
  async function reprocessPage(pageId, changes) {
    if (!state.open) return { applied: false, reason: 'closed' };
    if (state.busy || inFlight > 0) return { applied: false, reason: 'busy' };
    const page = state.pages.find((p) => p.pageId === pageId);
    if (!page || !page.sourceFile) return { applied: false, reason: 'missing' };

    const myGen = generation;
    const myOp = (ops.get(pageId) || 0) + 1;
    ops.set(pageId, myOp);

    const options = {
      pageId,
      rotation: changes.rotation != null ? changes.rotation : page.rotation,
      brightness: changes.brightness != null ? changes.brightness : page.brightness,
      contrast: changes.contrast != null ? changes.contrast : page.contrast,
      saturation: changes.saturation != null ? changes.saturation : page.saturation,
    };

    set({ busy: true });
    enterFlight();
    let result;
    try {
      result = await pipeline.processPage(page.sourceFile, options);
    } finally {
      // Both the controller-wide count and this generation's own busy flag are
      // cleared on every exit path, so an unexpected pipeline rejection cannot
      // strand the capture as permanently busy.
      leaveFlight();
      if (generation === myGen) set({ busy: false });
    }

    const superseded = generation !== myGen || ops.get(pageId) !== myOp;
    const stillPresent = state.pages.some((p) => p.pageId === pageId);

    if (superseded || !stillPresent) {
      // Revoke ONLY the URL this stale run created. The current page's thumbnail
      // is untouched, and no state is resurrected.
      discardStale(result);
      return { applied: false, reason: superseded ? 'superseded' : 'removed' };
    }
    if (!result.ok) { set({ error: result.message }); return { applied: false, reason: 'failed' }; }

    // The superseded thumbnail is revoked only now, after the replacement is
    // accepted.
    const previous = state.pages.find((p) => p.pageId === pageId);
    state.pages = state.pages.map((p) => (p.pageId === pageId ? { ...result, sourceFile: page.sourceFile } : p));
    if (previous && previous.thumb && previous.thumb.url && revokeObjectURL) revokeObjectURL(previous.thumb.url);
    emit();
    return { applied: true };
  }

  const rotatePage = (pageId) => {
    const page = state.pages.find((p) => p.pageId === pageId);
    if (!page) return Promise.resolve({ applied: false, reason: 'missing' });
    return reprocessPage(pageId, { rotation: ((page.rotation || 0) + 90) % 360 });
  };

  const enhancePage = (pageId, values) => reprocessPage(pageId, values || {});

  function remove(pageId) {
    if (state.busy || inFlight > 0) return { applied: false, reason: 'busy' };
    state.pages = removePage(state.pages, pageId, revokeObjectURL);
    set({ error: '' });
    return { applied: true };
  }

  function move(index, delta) {
    if (state.busy || inFlight > 0) return { applied: false, reason: 'busy' };
    state.pages = reorderPages(state.pages, index, index + delta);
    emit();
    return { applied: true };
  }

  return { open, close, addFiles, rotatePage, enhancePage, reprocessPage, remove, move, getState: get,
           isBusy: () => state.busy || inFlight > 0,
           ownBusy: () => state.busy,
           _debug: { generation: () => generation, inFlight: () => inFlight, ops } };
}

// ---------------------------------------------------------------------------
// Page-collection helpers. Pure; no browser APIs.
// ---------------------------------------------------------------------------

// Accepts what fits and reports the rest, rather than silently dropping files.
export function admitPages(existingCount, incomingCount, maxPages = MAX_PAGES) {
  const room = Math.max(0, maxPages - existingCount);
  const accepted = Math.min(room, incomingCount);
  const rejected = incomingCount - accepted;
  return {
    accepted, rejected,
    atLimit: existingCount + accepted >= maxPages,
    message: rejected > 0
      ? (accepted > 0
          ? `Added ${accepted} of ${incomingCount} pages. ${PAGE_LIMIT_MESSAGE}`
          : PAGE_LIMIT_MESSAGE)
      : '',
  };
}

export function reorderPages(pages, fromIndex, toIndex) {
  if (fromIndex === toIndex) return pages;
  if (fromIndex < 0 || fromIndex >= pages.length || toIndex < 0 || toIndex >= pages.length) return pages;
  const next = pages.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

// Removing a page revokes its thumbnail URL immediately — the leak that shows up
// as a slow crawl to a crash on a phone.
export function removePage(pages, pageId, revokeObjectURL) {
  const gone = pages.find((p) => p.pageId === pageId);
  if (gone && gone.thumb && gone.thumb.url && revokeObjectURL) revokeObjectURL(gone.thumb.url);
  return pages.filter((p) => p.pageId !== pageId);
}

export function releaseAllPages(pages, revokeObjectURL) {
  for (const p of pages || []) {
    if (p && p.thumb && p.thumb.url && revokeObjectURL) revokeObjectURL(p.thumb.url);
  }
  return [];
}

// Page numbers are positional and 1-based: they are assigned at save time from
// the reviewed order, so reordering never leaves a gap.
export function pageNumbersFor(pages) {
  return pages.map((p, i) => ({ ...p, pageNumber: i + 1 }));
}
