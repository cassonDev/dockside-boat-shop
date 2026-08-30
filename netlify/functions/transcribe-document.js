// Netlify Function: server-side, authenticated, rate-limited transcription of ONE
// photographed document page for the Document Photo Transcription feature.
//
// This endpoint is deliberately NOT modelled on ai-extract.js / extract-serial-number.js,
// which accept unauthenticated POSTs. This one is paid, multi-page, and per-shop metered,
// so no OpenAI request may begin until the server has authenticated, authorized, and
// atomically reserved the attempt. CORS is not security; a hidden button is not security.
//
// Order of operations (the image is validated BEFORE the reservation on purpose: a
// malformed or oversized page must never consume quota):
//
//   configuration -> coarse body guard -> request shape -> authentication
//     -> precise image validation -> atomic authorization + usage reservation -> OpenAI
//
// No OpenAI request may occur before a successful reservation.
//
// Client contract
//   POST  Authorization: Bearer <supabase access token>
//   {
//     "requestId":         uuid,      // idempotency key for ONE logical paid attempt
//     "workOrderId":       string,    // existing work-order id
//     "documentCaptureId": uuid,      // groups the pages of one capture
//     "pageNumber":        1..5,
//     "imageDataUrl":      "data:image/jpeg;base64,...",
//     "qualityTier":       "standard" | "strong"   // optional, defaults to "standard"
//   }
//
//   200 { ok:true, text, pageNumber, qualityTier, confidenceScore, lowConfidenceRegions, needsReview }
//   200 { ok:false, code:"AI_FAILED", error }          authorized, model failed after its one retry
//   400 { ok:false, code:"BAD_REQUEST", error }
//   401 { ok:false, code:"UNAUTHENTICATED", error }
//   403 { ok:false, code:"NOT_AUTHORIZED", error }     generic: never reveals cross-shop existence
//   409 { ok:false, code:"REQUEST_IN_PROGRESS" | "RESULT_NOT_REPLAYABLE" | "REQUEST_TERMINAL", error }
//   413 { ok:false, code:"IMAGE_TOO_LARGE", error }
//   429 { ok:false, code:"RATE_LIMITED", error }
//   500 { ok:false, code:"SERVER_CONFIG", error }      fail closed; no model call
//
// `standard` and `strong` are neutral routing labels. They share the same validation,
// system prompt, schema, sanitization, retry, error handling, and response contract; the
// ONLY difference is which environment-configured model the server selects. Nothing here
// may branch on tier for prompt quality, validation strictness, or recovery behaviour.
// A reservation that authorizes a DIFFERENT tier than the caller requested is a server
// contract failure, not a silent downgrade — see the tier-agreement check below.
//
// AUTHORIZATION MODEL (amended). The browser's bearer token is verified here and
// NOWHERE ELSE: the Function calls `admin.auth.getUser(token)`, takes the user id from
// that verified result, and then invokes both RPCs with the SERVICE-ROLE client, passing
// the id as an explicit `p_actor_id`. The caller's JWT is never forwarded to the database.
// Execute on both RPCs is granted only to `service_role`, so a mechanic cannot call them
// from devtools to exhaust the shop's quota or forge outcome and token telemetry.
// Consequence: `auth.uid()` is NULL inside those RPCs, so the database re-verifies the
// actor explicitly rather than relying on it. No identity field in the request body is ever
// read — `actorId`, `userId`, `profileId`, and `shopId` are ignored exactly as `model` is.
//
// Required env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//               DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS (=60),
//               DOCUMENT_TRANSCRIPTION_STALE_SECONDS (>= 90)
// Optional env: OPENAI_DOCUMENT_MODEL (default gpt-5.6-luna),
//               OPENAI_DOCUMENT_STRONG_MODEL (default gpt-5.6-terra),
//               DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES (default 2000000)
//
// SUPABASE_ANON_KEY is deliberately NOT required: nothing in this Function uses it once
// RPC invocation moved to the service-role client.
//
// NOTHING in this file logs image bytes, transcription text, low-confidence fragments,
// bearer tokens, API keys, or complete provider responses.

const RESERVE_RPC = 'document_transcription_reserve';
const FINALIZE_RPC = 'document_transcription_finalize_attempt';

const DEFAULT_STANDARD_MODEL = 'gpt-5.6-luna';
const DEFAULT_STRONG_MODEL = 'gpt-5.6-terra';

// SIZE CONTRACT — one unmistakable unit.
//   DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES caps the length of the BASE64 PAYLOAD
//   (the characters after "data:image/jpeg;base64,"), because that is what actually drives
//   the Netlify request body. The default 2,000,000 encoded bytes is ~1.5 MB of decoded
//   JPEG — generous for the approved ~1600 px q0.7 OCR derivative (typically 200-600 KB
//   decoded) and comfortably below Netlify's 6 MB request-body limit.
//   The whole-request ceiling is that value plus a fixed JSON/prefix allowance, NOT a
//   multiple of it.
const DEFAULT_MAX_IMAGE_BASE64_BYTES = 2000000;
const MIN_MAX_IMAGE_BASE64_BYTES = 50000;
const MAX_MAX_IMAGE_BASE64_BYTES = 5000000;   // stays clear of Netlify's 6 MB body limit
const REQUEST_JSON_OVERHEAD_BYTES = 4096;     // ids, tier, data-URL prefix, JSON punctuation

// Netlify's synchronous Function execution limit is 60s and is not configurable; the stale
// threshold must clear it plus a buffer. Both are validated, never guessed, never defaulted.
const REQUIRED_FUNCTION_TIMEOUT_SECONDS = 60;
const MIN_STALE_BUFFER_SECONDS = 30;

const MAX_PAGES_PER_CAPTURE = 5;
const CONFIDENCE_REVIEW_THRESHOLD = 0.75;
const MODEL_MAX_COMPLETION_TOKENS = 4000;

// Small print and handwriting are exactly what low-detail image encoding destroys, so the
// detail level is set explicitly rather than inherited from a model-dependent default. It
// costs more input tokens per page than 'low'; that cost is the point of the feature.
// Identical for both tiers.
const MODEL_IMAGE_DETAIL = 'high';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JPEG_DATA_URL_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Failure categories. Only these are retryable within the single permitted technical retry:
// a transient transport fault, a provider 5xx, or a valid HTTP response whose expected JSON
// is missing, malformed, or schema-invalid.
//
// Deliberately NOT retryable:
//   provider_auth / provider_rate_limit / provider_client_error — repeating them cannot
//     succeed and only adds load;
//   incomplete_response — a second identical call under the same token ceiling is unlikely
//     to repair a `length` completion, and repeating a `content_filter` is unlikely to help
//     either. Both would double the page cost without changing the input. The mechanic can
//     still choose READ PAGE AGAIN, which arrives as a new request id.
const RETRYABLE_CATEGORIES = new Set([
  'network_error',
  'provider_server_error',
  'unparseable_response',
]);

// ---------------------------------------------------------------------------
// System prompt — identical for both tiers.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You transcribe ONE photographed page of a document for a boat repair shop. The page may be handwritten, printed, or both.

Transcribe VERBATIM. Preserve exactly what is visible: spelling (including misspellings), capitalization, punctuation, abbreviations, numbers, symbols, and meaningful line breaks.

Never summarize. Never correct. Never infer intent. Never turn the text into repair instructions, advice, or a rewritten note. Never invent characters, words, or values that are not legible on the page.

Be especially strict with part numbers, serial-like identifiers, dollar amounts, dates, phone numbers, measurements, quantities, addresses, and warranty identifiers. Never normalize or reformat these. If ANY character in such a value is uncertain, do not choose a plausible character — use [illegible] and describe the uncertainty.

Use exactly the token [illegible] for any run of text you cannot read reliably.

If nothing on the page can be read reliably, return an empty string for text.

confidenceScore is your confidence in the LEGIBILITY of your reading, from 0 to 1 — not your confidence that the document is important or well written.

Set needsReview to true when confidenceScore is below 0.75, when text is empty, when [illegible] appears anywhere, or when you list any uncertainty region.

Each entry in lowConfidenceRegions describes one uncertain passage: the text as you read it (or [illegible]) and a short reason such as "handwriting is unclear" or "shadow across the line".

Return ONLY a JSON object with exactly these keys: text, confidenceScore, lowConfidenceRegions, needsReview. No commentary, no markdown fences, no extra keys.`;

const RESPONSE_JSON_SCHEMA = {
  name: 'document_page_transcription',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
      lowConfidenceRegions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, reason: { type: 'string' } },
          required: ['text', 'reason'],
          additionalProperties: false,
        },
      },
      needsReview: { type: 'boolean' },
    },
    required: ['text', 'confidenceScore', 'lowConfidenceRegions', 'needsReview'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no I/O)
// ---------------------------------------------------------------------------

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function fail(statusCode, code, error) {
  return json(statusCode, { ok: false, code, error });
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// The tier arrives from the browser and is the ONLY routing input it may influence.
// Anything missing, malformed, or unrecognised normalizes to 'standard' — backward
// compatible and cost-safe. A browser-supplied model name is never read anywhere.
function normalizeTier(raw) {
  return raw === 'strong' ? 'strong' : 'standard';
}

// Reads and validates every server setting. Fail-closed: a missing or unsafe value means
// no model call at all, and no silently guessed fallback.
function readConfig(env) {
  const problems = [];

  const openaiKey = env.OPENAI_API_KEY;
  if (!openaiKey) problems.push('OPENAI_API_KEY');

  const supabaseUrl = env.SUPABASE_URL;
  if (!supabaseUrl) problems.push('SUPABASE_URL');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) problems.push('SUPABASE_SERVICE_ROLE_KEY');

  // Netlify's synchronous limit is a documented platform constant, so this variable exists
  // to be asserted against — not to be tuned.
  const functionTimeoutSeconds = Number(env.DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS);
  if (!Number.isInteger(functionTimeoutSeconds) || functionTimeoutSeconds !== REQUIRED_FUNCTION_TIMEOUT_SECONDS) {
    problems.push('DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS');
  }

  // The internal model retry happens INSIDE the same invocation, so it is already covered by
  // the 60s window and must not be added to this threshold a second time.
  const staleSeconds = Number(env.DOCUMENT_TRANSCRIPTION_STALE_SECONDS);
  const staleOk =
    Number.isInteger(staleSeconds) &&
    staleSeconds > functionTimeoutSeconds &&
    staleSeconds >= REQUIRED_FUNCTION_TIMEOUT_SECONDS + MIN_STALE_BUFFER_SECONDS;
  if (!staleOk) problems.push('DOCUMENT_TRANSCRIPTION_STALE_SECONDS');

  const rawMax = env.DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES;
  let maxImageBase64Bytes = DEFAULT_MAX_IMAGE_BASE64_BYTES;
  if (rawMax != null && rawMax !== '') {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < MIN_MAX_IMAGE_BASE64_BYTES || parsed > MAX_MAX_IMAGE_BASE64_BYTES) {
      problems.push('DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES');
    } else {
      maxImageBase64Bytes = parsed;
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    openaiKey,
    supabaseUrl,
    serviceRoleKey,
    functionTimeoutSeconds,
    staleSeconds,
    maxImageBase64Bytes,
    maxRequestBodyBytes: maxImageBase64Bytes + REQUEST_JSON_OVERHEAD_BYTES,
    models: {
      standard: env.OPENAI_DOCUMENT_MODEL || DEFAULT_STANDARD_MODEL,
      strong: env.OPENAI_DOCUMENT_STRONG_MODEL || DEFAULT_STRONG_MODEL,
    },
  };
}

// Shape validation only — nothing here reads document content, so it is safe (and cheap)
// to run before authentication.
function validateShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!isUuid(body.requestId)) return 'requestId must be a UUID.';
  if (!isUuid(body.documentCaptureId)) return 'documentCaptureId must be a UUID.';
  if (typeof body.workOrderId !== 'string' || !WORK_ORDER_ID_RE.test(body.workOrderId)) return 'workOrderId is missing or malformed.';
  if (!Number.isInteger(body.pageNumber) || body.pageNumber < 1 || body.pageNumber > MAX_PAGES_PER_CAPTURE) {
    return `pageNumber must be an integer from 1 to ${MAX_PAGES_PER_CAPTURE}.`;
  }
  if (typeof body.imageDataUrl !== 'string' || body.imageDataUrl.length === 0) return 'imageDataUrl is required.';
  return null;
}

// JPEG only, and actually a JPEG. The declared media type is not evidence: we decode the
// first few bytes and require the SOI + marker signature FF D8 FF, so arbitrary binary
// cannot be smuggled in under an image/jpeg label. Only those bytes are decoded — the full
// image is never copied into a second buffer for validation.
function validateImage(imageDataUrl, maxImageBase64Bytes) {
  const match = JPEG_DATA_URL_RE.exec(imageDataUrl);
  if (!match) return { error: 'imageDataUrl must be a base64 data URL of type image/jpeg.', code: 'BAD_REQUEST', status: 400 };

  const b64 = match[1];
  if (b64.length < 64) return { error: 'imageDataUrl contains no usable image data.', code: 'BAD_REQUEST', status: 400 };
  if (b64.length % 4 !== 0) return { error: 'imageDataUrl is not valid base64.', code: 'BAD_REQUEST', status: 400 };
  if (b64.length > maxImageBase64Bytes) {
    return { error: 'That page image is too large. Retake or re-select the page.', code: 'IMAGE_TOO_LARGE', status: 413 };
  }

  let head;
  try {
    head = Buffer.from(b64.slice(0, 8), 'base64');   // 8 base64 chars -> 6 bytes
  } catch (e) {
    return { error: 'imageDataUrl is not valid base64.', code: 'BAD_REQUEST', status: 400 };
  }
  if (head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
    return { error: 'That file is not a JPEG image.', code: 'BAD_REQUEST', status: 400 };
  }

  // Secondary sanity check only; the encoded length above is the contract.
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const decodedBytesEstimate = (b64.length / 4) * 3 - padding;

  return { base64Bytes: b64.length, decodedBytesEstimate };
}

function clampConfidence(v, hasText) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return hasText ? 0.5 : 0;
  return Math.max(0, Math.min(1, v));
}

// The model is never trusted for page identity, review status, or region page numbers.
// Everything the caller relies on is recomputed here from the request.
function sanitizeResult(parsed, pageNumber) {
  const text = parsed && parsed.text != null ? String(parsed.text) : '';
  const trimmed = text.trim();
  const confidenceScore = clampConfidence(parsed && parsed.confidenceScore, trimmed.length > 0);

  const rawRegions = parsed && Array.isArray(parsed.lowConfidenceRegions) ? parsed.lowConfidenceRegions : [];
  const lowConfidenceRegions = rawRegions
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      pageNumber,
      text: r.text != null ? String(r.text) : '',
      reason: r.reason != null ? String(r.reason) : '',
    }))
    .filter((r) => r.text.length > 0 || r.reason.length > 0);

  const needsReview =
    parsed && parsed.needsReview === true
      ? true
      : trimmed.length === 0 ||
        confidenceScore < CONFIDENCE_REVIEW_THRESHOLD ||
        text.includes('[illegible]') ||
        lowConfidenceRegions.length > 0;

  return { text, pageNumber, confidenceScore, lowConfidenceRegions, needsReview };
}

// STRICT parsing. We ask for Structured Outputs with a strict schema and a JSON-only
// system prompt, so anything that is not a clean JSON object is a protocol violation, not
// something to salvage. No substring extraction, no fence stripping — commentary,
// prefixes, suffixes, fenced blocks, arrays, and malformed JSON are all unparseable, and
// unparseable is retryable exactly once.
function parseModelContent(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// The provider contract is validated locally, not assumed. Structured Outputs plus a strict
// schema should already guarantee this shape, but an empty object, a wrong type, or an extra
// key means the response is not the thing we asked for — and defensive sanitization must not
// be used to paper over that. A violation is an unparseable response, and unparseable is
// retryable exactly once.
function validateModelPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  const keys = Object.keys(parsed);
  const expected = ['text', 'confidenceScore', 'lowConfidenceRegions', 'needsReview'];
  if (keys.length !== expected.length) return false;
  for (const k of expected) if (!Object.prototype.hasOwnProperty.call(parsed, k)) return false;

  if (typeof parsed.text !== 'string') return false;
  if (typeof parsed.confidenceScore !== 'number' || !Number.isFinite(parsed.confidenceScore)) return false;
  if (parsed.confidenceScore < 0 || parsed.confidenceScore > 1) return false;
  if (typeof parsed.needsReview !== 'boolean') return false;
  if (!Array.isArray(parsed.lowConfidenceRegions)) return false;

  for (const region of parsed.lowConfidenceRegions) {
    if (!region || typeof region !== 'object' || Array.isArray(region)) return false;
    const rk = Object.keys(region);
    if (rk.length !== 2) return false;
    if (typeof region.text !== 'string') return false;
    if (typeof region.reason !== 'string') return false;
  }
  return true;
}

// Reservation decision -> HTTP response. Kept as one table so the mapping is reviewable
// and so no branch can quietly become tier-dependent.
function responseForDecision(decision, extra) {
  switch (decision) {
    case 'rate_limited':
      return fail(429, 'RATE_LIMITED', 'Document transcription limit reached. Please try again later.');
    case 'duplicate_active':
      return fail(409, 'REQUEST_IN_PROGRESS', 'This page is still being read. Wait for it to finish before trying again.');
    case 'duplicate_completed':
      return fail(409, 'RESULT_NOT_REPLAYABLE', 'This page was already read, but the result could not be restored.');
    case 'duplicate_failed':
      return fail(409, 'REQUEST_TERMINAL', 'This reading already failed. Start a new reading for this page.');
    case 'feature_disabled':
    case 'forbidden':
      // One generic message for both, so a caller can never learn that a work order
      // exists in another shop.
      return fail(403, 'NOT_AUTHORIZED', 'Document transcription is not available for this work order.');
    default:
      return fail(500, 'SERVER_CONFIG', (extra && extra.message) || 'Document transcription is temporarily unavailable.');
  }
}

// ---------------------------------------------------------------------------
// Handler factory — every external dependency is injected so tests never touch
// the network, Supabase, or OpenAI.
// ---------------------------------------------------------------------------

function createHandler(deps) {
  const {
    env = process.env,
    authenticate,          // (token, config) -> { userId } | null
    callRpc,               // (name, params, token, config) -> { data, error }
    fetchImpl,             // fetch-compatible
    log = safeLog,
  } = deps || {};

  return async function handler(event) {
    const started = Date.now();
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');

    // 1. Configuration. Fail closed before anything else: an unverifiable stale threshold
    //    means the reservation state machine cannot be operated safely, so no paid call.
    const config = readConfig(env);
    if (!config.ok) {
      log({ event: 'config_invalid', missingOrInvalid: config.problems });
      return fail(500, 'SERVER_CONFIG', 'Document transcription is temporarily unavailable.');
    }

    // 2. Coarse whole-body ceiling: the encoded image allowance plus a fixed JSON overhead.
    const rawBody = event.body || '';
    if (rawBody.length > config.maxRequestBodyBytes) {
      return fail(413, 'IMAGE_TOO_LARGE', 'That page image is too large. Retake or re-select the page.');
    }

    let body;
    try { body = JSON.parse(rawBody || '{}'); } catch (e) {
      return fail(400, 'BAD_REQUEST', 'Invalid JSON body.');
    }

    // 3. Shape validation (no document content read).
    const shapeError = validateShape(body);
    if (shapeError) return fail(400, 'BAD_REQUEST', shapeError);

    // The browser may influence routing ONLY through the validated tier label. Any `model`
    // field in the body is ignored outright — it is never read anywhere in this function.
    const requestedTier = normalizeTier(body.qualityTier);
    const { requestId, documentCaptureId, workOrderId, pageNumber } = body;

    // 4. Authentication (same precedent as manage-users.js).
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return fail(401, 'UNAUTHENTICATED', 'Missing Authorization bearer token.');

    let auth = null;
    try { auth = await authenticate(token, config); } catch (e) { auth = null; }
    if (!auth || !auth.userId) return fail(401, 'UNAUTHENTICATED', 'Invalid or expired session.');

    // 5. Precise image validation — before the reservation, so a malformed or oversized
    //    page never consumes quota, and always before the model.
    const image = validateImage(body.imageDataUrl, config.maxImageBase64Bytes);
    if (image.error) return fail(image.status, image.code, image.error);

    // 6. Atomic authorization + usage reservation. Everything that decides whether this call
    //    may happen — membership, work-order/shop relationship, feature flag, user and shop
    //    limits, duplicate state — is settled by the database in ONE operation. The call is
    //    made AS THE SERVER, with the verified actor passed explicitly; nothing here trusts a
    //    browser-supplied shop, role, identity, or usage count.
    let reservation = null;
    try {
      const { data, error } = await callRpc(
        RESERVE_RPC,
        {
          p_actor_id: auth.userId,
          p_request_id: requestId,
          p_document_capture_id: documentCaptureId,
          p_work_order_id: workOrderId,
          p_page_number: pageNumber,
          p_quality_tier: requestedTier,
          p_stale_seconds: config.staleSeconds,
        },
        token,
        config,
      );
      if (error) throw new Error(error.message || 'reservation failed');
      reservation = data;
    } catch (e) {
      log({ event: 'reservation_unavailable', requestId, workOrderId, qualityTier: requestedTier, errorCategory: 'reservation_error' });
      return fail(500, 'SERVER_CONFIG', 'Document transcription is temporarily unavailable.');
    }

    const decision = reservation && reservation.decision;
    if (decision !== 'authorized') {
      log({
        event: 'reservation_refused',
        requestId, workOrderId, qualityTier: requestedTier, pageNumber,
        shopId: reservation && reservation.shop_id,
        userId: auth.userId,
        decision: decision || 'unknown',
        limitScope: (reservation && reservation.limit_scope) || null,
      });
      return responseForDecision(decision, null);
    }

    // 6b. Tier agreement. An authorized reservation MUST be for the tier the caller asked
    //     for. A silent downgrade would make the response claim a reading that did not
    //     happen and would misattribute cost and usage; a silent upgrade would spend more
    //     than the user asked for. If Step 3 needs to deny a strong reading it must return
    //     an explicit refusal decision instead. Either mismatch fails closed, before the
    //     paid call.
    const reservedTier = reservation.quality_tier;
    if (reservedTier !== requestedTier) {
      // No paid call happened, so token counts stay null — but the reservation must not be
      // left occupying `processing` until stale recovery reclaims it.
      await finalize(callRpc, token, config, log, {
        requestId, actorId: auth.userId, outcome: 'failed', errorCategory: 'tier_contract_violation', usage: null,
      });
      log({
        event: 'tier_disagreement',
        requestId, workOrderId, pageNumber, userId: auth.userId,
        shopId: reservation.shop_id,
        qualityTier: requestedTier,
        decision: 'tier_mismatch',
        errorCategory: 'tier_contract_violation',
      });
      return fail(500, 'SERVER_CONFIG', 'Document transcription is temporarily unavailable.');
    }

    const effectiveTier = requestedTier;
    const model = config.models[effectiveTier];

    // 7. The paid call. One technical retry, SAME tier, SAME reservation, SAME request id,
    //    and ONLY for retryable categories. No tier fallback, no escalation on low
    //    confidence — escalation is a deliberate user action arriving as a separate request
    //    with a new request id.
    let parsed = null;
    let lastErrorCategory = null;

    // Usage ACCUMULATES across every model response in this invocation. If the first call
    // burns tokens and then fails schema validation, those tokens were still spent — the
    // retry's usage must add to them, never replace them.
    const usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
    let sawUsage = false;
    const addUsage = (u) => {
      if (!u) return;
      sawUsage = true;
      if (Number.isFinite(u.prompt_tokens)) usageTotal.prompt_tokens += u.prompt_tokens;
      if (Number.isFinite(u.completion_tokens)) usageTotal.completion_tokens += u.completion_tokens;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      let category = null;
      try {
        const out = await callModel({
          fetchImpl, apiKey: config.openaiKey, model,
          imageDataUrl: body.imageDataUrl, pageNumber,
        });
        addUsage(out.usage);
        if (out.category) {
          category = out.category;                 // abnormal finish reason
        } else {
          const candidate = parseModelContent(out.content);
          if (candidate && validateModelPayload(candidate)) {
            parsed = candidate;
            break;
          }
          category = 'unparseable_response';
        }
      } catch (e) {
        category = (e && e.category) || 'network_error';
      }
      lastErrorCategory = category;
      if (!RETRYABLE_CATEGORIES.has(category)) break;
    }

    const usage = sawUsage ? usageTotal : null;

    if (!parsed) {
      await finalize(callRpc, token, config, log, {
        requestId, actorId: auth.userId, outcome: 'failed', errorCategory: lastErrorCategory || 'unknown', usage,
      });
      log({
        event: 'transcription_failed',
        requestId, workOrderId, pageNumber, qualityTier: effectiveTier, model,
        shopId: reservation.shop_id, userId: auth.userId,
        errorCategory: lastErrorCategory || 'unknown',
        latencyMs: Date.now() - started,
      });
      return json(200, {
        ok: false,
        code: 'AI_FAILED',
        error: 'AI could not read this page. Please try again or enter the note manually.',
      });
    }

    const result = sanitizeResult(parsed, pageNumber);

    // 8. Record completion. A failure here does not lose the user's result: the reservation
    //    simply ages out under the stale policy, and the paid attempt stays counted.
    await finalize(callRpc, token, config, log, { requestId, actorId: auth.userId, outcome: 'completed', errorCategory: null, usage });

    log({
      event: 'transcription_completed',
      requestId, workOrderId, pageNumber, qualityTier: effectiveTier, model,
      shopId: reservation.shop_id, userId: auth.userId,
      confidenceScore: result.confidenceScore,
      needsReview: result.needsReview,
      regionCount: result.lowConfidenceRegions.length,
      textLength: result.text.length,       // length only — never the text
      inputTokens: usage ? usage.prompt_tokens : null,
      outputTokens: usage ? usage.completion_tokens : null,
      latencyMs: Date.now() - started,
    });

    return json(200, {
      ok: true,
      text: result.text,
      pageNumber: result.pageNumber,
      qualityTier: effectiveTier,
      confidenceScore: result.confidenceScore,
      lowConfidenceRegions: result.lowConfidenceRegions,
      needsReview: result.needsReview,
    });
  };
}

async function finalize(callRpc, token, config, log, { requestId, actorId, outcome, errorCategory, usage }) {
  try {
    const { error } = await callRpc(
      FINALIZE_RPC,
      {
        p_actor_id: actorId,
        p_request_id: requestId,
        p_outcome: outcome,
        p_error_category: errorCategory,
        p_input_tokens: usage ? usage.prompt_tokens || null : null,
        p_output_tokens: usage ? usage.completion_tokens || null : null,
      },
      token,
      config,
    );
    if (error) throw new Error(error.message || 'finalize failed');
  } catch (e) {
    // Never surfaced to the caller: the transcription (if any) is still valid, and the
    // reservation ages out under the stale policy rather than blocking the user. Step 3's
    // accounting counts the paid attempt from the reservation row, independently of whether
    // this write lands.
    log({ event: 'finalize_failed', requestId, outcome, errorCategory: 'finalize_error' });
  }
}

// One model call. Identical for both tiers except the `model` argument.
async function callModel({ fetchImpl, apiKey, model, imageDataUrl, pageNumber }) {
  const payload = {
    model,
    // Lowest documented reasoning setting: verbatim transcription needs reading, not thinking.
    reasoning_effort: 'none',
    max_completion_tokens: MODEL_MAX_COMPLETION_TOKENS,
    // NOTE: no `temperature` and no `seed` — the GPT-5.6 reasoning models do not accept them.
    // Determinism comes from the deterministic server-side sanitization above, not sampling
    // parameters.
    response_format: { type: 'json_schema', json_schema: RESPONSE_JSON_SCHEMA },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Transcribe page ${pageNumber} of this document verbatim.` },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: MODEL_IMAGE_DETAIL } },
        ],
      },
    ],
  };

  let res;
  try {
    res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const err = new Error('transport failure');
    err.category = 'network_error';
    throw err;
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* fall through */ }

  if (!res.ok) {
    const err = new Error('provider error');
    err.status = res.status;
    // 401/403 are authorization faults and 429 is a provider-side limit: repeating any of
    // them inside the same invocation cannot succeed and only adds load.
    err.category =
      res.status === 401 || res.status === 403 ? 'provider_auth'
        : res.status === 429 ? 'provider_rate_limit'
          : res.status >= 500 ? 'provider_server_error'
            : 'provider_client_error';
    throw err;
  }

  const choice = parsed && parsed.choices && parsed.choices[0];
  const usage = (parsed && parsed.usage) || null;

  // A truncated or filtered completion can still contain parseable JSON — and that JSON
  // would be a partial transcription presented as a whole one. Acceptance requires an
  // AFFIRMATIVE normal stop: a missing, null, empty, or unrecognised finish reason is not
  // evidence of completion and is treated as incomplete (terminal, no automatic retry).
  const finishReason = choice && (choice.finish_reason != null ? choice.finish_reason : choice.finishReason);
  if (finishReason !== 'stop') {
    return { content: null, usage, category: 'incomplete_response' };
  }

  const content = choice && choice.message && choice.message.content;
  return { content, usage };
}

// Whitelisted operational logging. Anything not on this list never reaches the log.
const SAFE_LOG_FIELDS = [
  'event', 'requestId', 'workOrderId', 'shopId', 'userId', 'pageNumber', 'qualityTier',
  'model', 'decision', 'limitScope', 'errorCategory', 'confidenceScore', 'needsReview',
  'regionCount', 'textLength', 'inputTokens', 'outputTokens', 'latencyMs', 'missingOrInvalid',
];

function safeLog(fields) {
  const out = {};
  for (const key of SAFE_LOG_FIELDS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  console.log('[transcribe-document]', JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// Production wiring. @supabase/supabase-js is already a functions dependency
// (netlify/functions/package.json) and is required lazily so tests never load it.
// ---------------------------------------------------------------------------

function defaultAuthenticate(token, config) {
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });
  return admin.auth.getUser(token).then(({ data, error }) => {
    if (error || !data || !data.user) return null;
    return { userId: data.user.id };
  });
}

// The RPCs are invoked AS THE SERVER with the service-role key, and execute is granted only
// to `service_role`, so the browser cannot reach them directly. The caller's JWT is
// deliberately NOT forwarded: identity travels as the verified `p_actor_id` argument, and
// the database re-verifies it. Factored so tests can inject a fake createClient and prove
// both properties without a network call.
function makeCallRpc(createClientImpl) {
  return function callRpc(name, params, _token, config) {
    const asServer = createClientImpl(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return asServer.rpc(name, params);
  };
}

function defaultCallRpc(name, params, token, config) {
  const { createClient } = require('@supabase/supabase-js');
  return makeCallRpc(createClient)(name, params, token, config);
}

exports.handler = createHandler({
  authenticate: defaultAuthenticate,
  callRpc: defaultCallRpc,
  fetchImpl: (...args) => fetch(...args),
});

// Exposed for automated tests only — not part of the HTTP contract.
exports._test = {
  createHandler,
  makeCallRpc,
  readConfig,
  validateShape,
  validateImage,
  normalizeTier,
  sanitizeResult,
  parseModelContent,
  validateModelPayload,
  clampConfidence,
  responseForDecision,
  RETRYABLE_CATEGORIES,
  SYSTEM_PROMPT,
  RESPONSE_JSON_SCHEMA,
  RESERVE_RPC,
  FINALIZE_RPC,
  DEFAULT_STANDARD_MODEL,
  DEFAULT_STRONG_MODEL,
  DEFAULT_MAX_IMAGE_BASE64_BYTES,
  REQUEST_JSON_OVERHEAD_BYTES,
  MODEL_IMAGE_DETAIL,
};
