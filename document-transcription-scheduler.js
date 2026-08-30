// ===========================================================================
// document-transcription-scheduler.js — Step 5B: transcription orchestration.
//
//   Pure factory: no imports, no globals, no module-scope side effects.
//
//   ONE QUEUE, ONE SLOT ALLOCATOR. Every operation — first read, technical
//   retry, READ PAGE AGAIN, and TRY STRONGER READING — is a job on the same
//   queue and competes for the same two slots. Nothing calls the pipeline
//   directly, because a direct call is how a third concurrent request (and a
//   third OCR data URL) appears.
//
//   IMMUTABLE SESSION IDENTITY. workOrderId and documentCaptureId are captured
//   when the reading session starts and travel with each job. They are never
//   re-read from mutable UI state after scheduling, so a sheet that closes or
//   reopens mid-conversion cannot retarget an in-flight request.
//
//   PAGE OBJECT IDENTITY IS STABLE. Pages are mutated in place and never
//   replaced, so an in-flight job holding a page reference and the live list
//   always refer to the same object. Every completion additionally asserts
//   `current === page` before applying.
// ===========================================================================

export const PAGE_STATES = ['waiting', 'reading', 'ready', 'needs_review', 'failed'];
export const MAX_CONCURRENT = 2;
export const OFFLINE_MESSAGE =
  'Document transcription and saving need an internet connection. Your reviewed text is still on this device; reconnect and try again.';
export const RESULT_LOST_MESSAGE = 'This page was read, but the result was lost when the connection dropped.';

const TERMINAL_CODES = new Set([
  'RESULT_NOT_REPLAYABLE', 'REQUEST_TERMINAL', 'NOT_AUTHORIZED',
  'IMAGE_TOO_LARGE', 'BAD_REQUEST', 'INVALID_TIER',
]);

export function createTranscriptionScheduler(deps) {
  const {
    transcribe, blobToDataUrl, newRequestId,
    // Explicit release boundary for the OCR data URL. Production passes a no-op
    // (the string is dropped when the job's local reference goes), but making
    // the boundary injectable is what lets a test prove the URL is owned by
    // exactly one job and released exactly once on every path.
    releaseDataUrl = () => {},
    maxConcurrent = MAX_CONCURRENT,
    onChange = () => {},
  } = deps || {};

  let pages = [];
  let session = null;        // { workOrderId, documentCaptureId, generation }
  let sessionGen = 0;
  let halted = null;
  let active = 0;
  const queue = [];          // { page, tier, kind, gen, attempt, sessionGen }
  let pumping = false;

  const find = (id) => pages.find((p) => p.pageId === id);
  const renumber = () => pages.forEach((p, i) => { p.pageNumber = i + 1; });

  const viewPage = (p) => ({
    pageId: p.pageId, pageNumber: p.pageNumber, state: p.state,
    text: p.text, confidenceScore: p.confidenceScore,
    lowConfidenceRegions: p.lowConfidenceRegions, needsReview: p.needsReview,
    qualityTier: p.qualityTier, error: p.error, edited: p.edited,
    terminal: !!p.terminal, resultLost: !!p.resultLost,
    pendingStrong: p.pendingStrong ? { text: p.pendingStrong.text, qualityTier: p.pendingStrong.qualityTier } : null,
    canTryStronger: p.state !== 'reading' && !p.pendingStrong && !p.queued,
    prominentStronger: p.state === 'failed' || p.needsReview === true
      || (p.text != null && (p.text.trim() === '' || p.text.includes('[illegible]')))
      || (p.confidenceScore != null && p.confidenceScore < 0.75)
      || (p.lowConfidenceRegions || []).length > 0,
  });

  function progressLabel() {
    const total = pages.length;
    if (!total) return '';
    const reading = pages.find((p) => p.state === 'reading');
    const done = pages.filter((p) => p.state === 'ready' || p.state === 'needs_review').length;
    return reading ? `Reading page ${reading.pageNumber} of ${total}` : `${done} of ${total} pages ready`;
  }

  const snapshot = () => ({
    pages: pages.map(viewPage), activeCount: active, halted,
    queuedCount: queue.length, progressLabel: progressLabel(),
    sessionId: session ? session.documentCaptureId : null,
    // True only when work is genuinely paused: pages still waiting, nothing
    // queued, nothing in flight. This is what makes CONTINUE REMAINING PAGES
    // reachable after a 429 and a targeted retry — and hides it while the queue
    // is moving, so repeated taps cannot double-queue.
    canResumeQueue: active === 0 && queue.length === 0
      && pages.some((p) => p.state === 'waiting' && !p.queued),
    allSettled: pages.every((p) => p.state !== 'waiting' && p.state !== 'reading') && queue.length === 0,
  });
  const emit = () => onChange(snapshot());

  const makePage = (p, i) => ({
    pageId: p.pageId, pageNumber: i + 1,
    ocrBlob: p.ocr ? p.ocr.blob : p.ocrBlob,
    state: 'waiting', text: null, confidenceScore: null, lowConfidenceRegions: [],
    needsReview: null, qualityTier: 'standard', error: '', edited: false,
    generation: 0, attempt: 0, pendingStrong: null, queued: false, terminal: false, resultLost: false,
  });

  // Session identity is fixed here and never re-read from UI state afterwards.
  function startSession({ workOrderId, documentCaptureId, pages: input }) {
    sessionGen += 1;
    drainQueue('session_replaced');
    session = { workOrderId, documentCaptureId, generation: sessionGen };
    pages = (input || []).map(makePage);
    halted = null;
    emit();
    return session;
  }

  // Invalidates all waiting work for the current session. In-flight calls are
  // allowed to settle (they are already paid for and must stay counted server
  // side) but their responses are discarded.
  function endSession() {
    sessionGen += 1;
    drainQueue('session_ended');
    session = null;
    emit();
  }

  // ---- targeted synchronisation with the 5A capture ------------------------
  //
  // Compares by stable pageId AND OCR blob identity. An unrelated emission — a
  // busy-state change, another page's rotation — must not clear a page's text,
  // edits, confidence, or pending choice, and must not cause a paid reread.
  function syncPages(capturePages) {
    const incoming = (capturePages || []).map((p) => ({ pageId: p.pageId, ocrBlob: p.ocr ? p.ocr.blob : p.ocrBlob }));
    const seen = new Set(incoming.map((p) => p.pageId));

    // Removals: orphan only that page's in-flight response.
    for (const p of pages) if (!seen.has(p.pageId)) { p.generation += 1; p.queued = false; }
    pages = pages.filter((p) => seen.has(p.pageId));

    const byId = new Map(pages.map((p) => [p.pageId, p]));
    const next = [];
    let changed = 0;
    for (const inc of incoming) {
      const existing = byId.get(inc.pageId);
      if (!existing) { next.push(makePage(inc, 0)); changed += 1; continue; }
      if (existing.ocrBlob !== inc.ocrBlob) {
        // Only this page's image moved.
        existing.generation += 1;
        existing.ocrBlob = inc.ocrBlob;
        existing.state = 'waiting';
        existing.text = null; existing.confidenceScore = null; existing.lowConfidenceRegions = [];
        existing.needsReview = null; existing.error = ''; existing.edited = false;
        existing.pendingStrong = null; existing.queued = false; existing.terminal = false; existing.resultLost = false;
        changed += 1;
      }
      // Unchanged blob: the SAME object is kept, so text, edits, confidence,
      // result state, and any pending choice survive. Reordering only moves it.
      next.push(existing);
    }
    pages = next;
    renumber();
    // A page whose image moved needs a fresh standard read, through the shared
    // allocator like everything else — otherwise it would sit "waiting" forever
    // with no action offered.
    // While halted, synchronisation may update identity and state but must NOT
    // prequeue automatic rereads: a later targeted retry clears the halt and
    // would otherwise release everything that had been quietly queued, which is
    // "retry one page fires the rest" through a side door.
    if (session && !halted) {
      for (const p of pages) if (p.state === 'waiting' && !p.queued) enqueue(p, 'standard', 'read');
    }
    emit();
    if (session && !halted) pump();
    return { changed };
  }

  // ---- the single queue --------------------------------------------------
  //
  //   Every job owns a deferred, so a caller awaits ITS operation settling —
  //   not whether some other pump happened to finish. pump() is re-entrant and
  //   returns early when already running, which is exactly why the promise
  //   cannot come from pump().

  const makeDeferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const settle = (job, value) => { if (job && !job.settled) { job.settled = true; job.deferred.resolve(value); } };

  function enqueue(page, tier, kind) {
    if (!session) return null;
    const job = {
      page, tier, kind, gen: page.generation, sessionGen: session.generation,
      workOrderId: session.workOrderId, documentCaptureId: session.documentCaptureId,
      started: false, settled: false, deferred: makeDeferred(),
    };
    page.queued = true;
    page.queuedJob = job;
    page.state = 'waiting';
    queue.push(job);
    return job;
  }

  // Clearing the queue must SETTLE the waiting jobs, never leave a caller's
  // promise hanging forever.
  function drainQueue(reason) {
    for (const job of queue.splice(0)) {
      job.page.queued = false;
      job.page.queuedJob = null;
      settle(job, { applied: false, cancelled: true, reason });
    }
  }

  const isStale = (job) =>
    !session || job.sessionGen !== session.generation ||
    find(job.page.pageId) !== job.page || job.page.generation !== job.gen;

  async function runJob(job) {
    const { page } = job;
    job.started = true;
    page.queued = false;
    page.queuedJob = null;

    if (isStale(job)) { emit(); settle(job, { applied: false, stale: true }); return; }

    page.state = 'reading';
    page.error = '';
    page.attempt += 1;
    const attempt = page.attempt;

    // Incremented ONCE here and decremented ONCE in the finally, on every path:
    // cancellation before the call, success, provider failure, a thrown
    // conversion, or a thrown call. An earlier version decremented twice on the
    // cancellation path and drove the count negative, which would have let a
    // later dispatch exceed the ceiling.
    active += 1;
    emit();

    let result = null;
    let cancelled = false;
    // Acquired immediately before the request, held only here, released exactly
    // once in the finally — after success, after failure, after a throw, and on
    // the cancellation path where no paid call is made at all.
    let imageDataUrl = null;
    try {
      imageDataUrl = await blobToDataUrl(page.ocrBlob);
      if (isStale(job)) cancelled = true;                 // no paid call
      else {
        result = await transcribe({
          requestId: newRequestId(),
          workOrderId: job.workOrderId,
          documentCaptureId: job.documentCaptureId,
          pageNumber: page.pageNumber,
          imageDataUrl,
          qualityTier: job.tier,
        });
      }
    } catch (e) {
      result = { ok: false, code: 'OFFLINE', error: OFFLINE_MESSAGE, retryable: true };
    } finally {
      // Nested finally: a throwing release callback (instrumentation, a future
      // real implementation) must never prevent the slot from being returned.
      try {
        if (imageDataUrl !== null) { releaseDataUrl(imageDataUrl); imageDataUrl = null; }
      } finally {
        active -= 1;
      }
    }

    if (cancelled) { page.state = 'waiting'; emit(); settle(job, { applied: false, cancelled: true }); return; }
    if (isStale(job) || page.attempt !== attempt) { emit(); settle(job, { applied: false, stale: true }); return; }

    // An edited page is parked in ONE mutation, with no intermediate emit.
    if (job.kind === 'strong' && page.edited && result && result.ok) {
      page.pendingStrong = {
        text: result.text, qualityTier: result.qualityTier || 'strong',
        confidenceScore: result.confidenceScore,
        lowConfidenceRegions: result.lowConfidenceRegions || [],
        needsReview: !!result.needsReview,
      };
      page.state = 'needs_review';
      emit();
      settle(job, { applied: true, needsChoice: true });
      return;
    }

    applyResult(page, result, job.tier);
    emit();
    settle(job, { applied: true, needsChoice: false });
  }

  function applyResult(page, result, tier) {
    if (result && result.ok) {
      page.text = result.text;
      page.confidenceScore = result.confidenceScore;
      page.lowConfidenceRegions = result.lowConfidenceRegions || [];
      page.needsReview = !!result.needsReview;
      page.qualityTier = result.qualityTier || tier;
      page.state = result.needsReview ? 'needs_review' : 'ready';
      page.error = ''; page.terminal = false; page.resultLost = false; page.edited = false;
      return;
    }
    page.state = 'failed';
    page.qualityTier = tier;
    if (result && result.code === 'RATE_LIMITED') {
      halted = { code: 'RATE_LIMITED', message: result.error };
      page.error = result.error;
      drainQueue('rate_limited');     // settles, does not strand
    } else if (result && result.code === 'RESULT_NOT_REPLAYABLE') {
      page.error = RESULT_LOST_MESSAGE; page.resultLost = true;
    } else if (result && result.code === 'OFFLINE') {
      page.error = OFFLINE_MESSAGE;
    } else {
      page.error = (result && result.error) || 'AI could not read this page.';
    }
    page.terminal = !!(result && TERMINAL_CODES.has(result.code));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      const inFlight = new Set();
      while ((queue.length && !halted) || inFlight.size) {
        while (!halted && queue.length && active < maxConcurrent) {
          const job = queue.shift();
          const p = runJob(job).finally(() => inFlight.delete(p));
          inFlight.add(p);
        }
        if (inFlight.size) await Promise.race(inFlight);
        else break;
      }
    } finally { pumping = false; emit(); }
  }

  // ---- public operations ---------------------------------------------------

  function start() {
    if (!session) return Promise.resolve();
    const jobs = [];
    for (const p of pages) if (p.state === 'waiting' && !p.queued) jobs.push(enqueue(p, 'standard', 'read'));
    const done = Promise.all(jobs.filter(Boolean).map((j) => j.deferred.promise));
    pump();
    return done;
  }

  // ONE page, same tier, new request id. Does NOT resume a halted remainder.
  function retryPage(pageId) {
    const p = find(pageId);
    if (!p || p.state === 'reading') return Promise.resolve({ started: false, reason: 'busy' });
    halted = null;
    const existing = p.queuedJob && !p.queuedJob.started ? p.queuedJob : null;
    const job = existing || enqueue(p, p.qualityTier || 'standard', 'retry');
    if (!job) return Promise.resolve({ started: false });
    pump();
    return job.deferred.promise.then(() => ({ started: true }));
  }

  const readPageAgain = (pageId) => retryPage(pageId);

  function resumeQueue() {
    halted = null;
    const jobs = [];
    for (const p of pages) if (p.state === 'waiting' && !p.queued) jobs.push(enqueue(p, 'standard', 'read'));
    const done = Promise.all(jobs.filter(Boolean).map((j) => j.deferred.promise));
    pump();
    return done.then(() => ({ resumed: jobs.length }));
  }

  // Deliberate escalation. If a standard job for this page is queued but has not
  // started, it is UPGRADED in place rather than joined by a second job: one
  // queue position, one conversion, one provider request, and no standard read
  // for that page.
  function tryStrongerReading(pageId) {
    const p = find(pageId);
    if (!p || p.pendingStrong) return Promise.resolve({ started: false });
    if (p.state === 'reading') return Promise.resolve({ started: false, reason: 'busy' });
    halted = null;

    let job;
    let upgraded = false;
    if (p.queuedJob && !p.queuedJob.started) {
      job = p.queuedJob;
      job.tier = 'strong';
      job.kind = 'strong';
      upgraded = true;
    } else {
      job = enqueue(p, 'strong', 'strong');
    }
    if (!job) return Promise.resolve({ started: false });
    pump();
    return job.deferred.promise.then((r) => ({ started: true, upgraded, needsChoice: !!(r && r.needsChoice) }));
  }

  function resolveStrongerChoice(pageId, choice) {
    const p = find(pageId);
    if (!p || !p.pendingStrong) return { resolved: false };
    if (choice === 'use') {
      const s = p.pendingStrong;
      p.text = s.text; p.qualityTier = s.qualityTier;
      p.confidenceScore = s.confidenceScore; p.lowConfidenceRegions = s.lowConfidenceRegions;
      p.needsReview = s.needsReview; p.edited = false;
      p.state = s.needsReview ? 'needs_review' : 'ready';
    }
    p.pendingStrong = null;
    emit();
    return { resolved: true, used: choice === 'use' };
  }

  function markEdited(pageId, text) {
    const p = find(pageId);
    if (!p) return;
    p.text = text; p.edited = true;
    emit();
  }

  return {
    startSession, endSession, syncPages, start, resumeQueue,
    retryPage, readPageAgain, tryStrongerReading, resolveStrongerChoice, markEdited,
    getState: snapshot,
    _debug: { pages: () => pages, queue: () => queue, halted: () => halted, session: () => session, active: () => active },
  };
}
