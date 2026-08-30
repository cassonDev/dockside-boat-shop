// Mocked tests for netlify/functions/transcribe-document.js
//
// Run:  node --test tests/transcribe-document.test.mjs
//
// NO external service is contacted. Supabase and OpenAI are both injected as fakes through
// the handler factory, so nothing here loads @supabase/supabase-js and nothing opens a
// socket. Any test that reaches the network is a bug in the test, not a feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../netlify/functions/transcribe-document.js');
const {
  createHandler, readConfig, validateShape, validateImage, normalizeTier, sanitizeResult,
  parseModelContent, validateModelPayload,
} = mod._test;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const CAPTURE_ID = '44444444-4444-4444-8444-444444444444';
const WORK_ORDER_ID = 'K7M2Q';

// A small encoded ceiling keeps the size-boundary tests fast; production defaults to
// 2,000,000 encoded bytes.
const TEST_MAX_B64 = 100000;

const GOOD_ENV = {
  OPENAI_API_KEY: 'test-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS: '60',
  DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '90',
  DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES: String(TEST_MAX_B64),
};

// Real JPEG magic bytes (FF D8 FF E0) followed by filler. The function decodes only the
// first few bytes, but the signature has to be genuine.
function jpegBytes(decodedBytes = 900) {
  const buf = Buffer.alloc(Math.max(decodedBytes, 64), 0x20);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  return buf;
}
function jpegDataUrl(decodedBytes = 900) {
  return `data:image/jpeg;base64,${jpegBytes(decodedBytes).toString('base64')}`;
}
// Base64 of exactly `n` encoded characters, carrying a valid JPEG signature.
function jpegDataUrlOfEncodedLength(n) {
  const decoded = (n / 4) * 3;
  const b64 = jpegBytes(decoded).toString('base64');
  return `data:image/jpeg;base64,${b64.slice(0, n)}`;
}
// PNG magic bytes wearing a JPEG label.
function disguisedNonJpegDataUrl(decodedBytes = 900) {
  const buf = Buffer.alloc(decodedBytes, 0x20);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function body(overrides = {}) {
  return JSON.stringify({
    requestId: REQUEST_ID,
    documentCaptureId: CAPTURE_ID,
    workOrderId: WORK_ORDER_ID,
    pageNumber: 1,
    imageDataUrl: jpegDataUrl(),
    qualityTier: 'standard',
    ...overrides,
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: body(),
    ...overrides,
  };
}

const GOOD_PAYLOAD = { text: 'Replace impeller', confidenceScore: 0.93, lowConfidenceRegions: [], needsReview: false };

function modelResponse(payload, { status = 200, usage = { prompt_tokens: 120, completion_tokens: 40 }, finishReason = 'stop', omitFinishReason = false } = {}) {
  const choice = { message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } };
  if (!omitFinishReason) choice.finish_reason = finishReason;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ choices: [choice], usage }),
  };
}
function networkFailure() {
  return () => { throw new Error('socket hang up'); };
}

function build({
  env = GOOD_ENV,
  authResult = { userId: USER_ID },
  reserve = { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID },
  modelResponses = [modelResponse(GOOD_PAYLOAD)],
  rpcError = null,
} = {}) {
  const spy = { rpcCalls: [], modelCalls: [], logs: [] };
  let modelIndex = 0;

  const handler = createHandler({
    env,
    authenticate: async () => authResult,
    callRpc: async (name, params) => {
      spy.rpcCalls.push({ name, params });
      if (rpcError) return { data: null, error: { message: rpcError } };
      if (name === mod._test.RESERVE_RPC) return { data: reserve, error: null };
      return { data: { ok: true }, error: null };
    },
    fetchImpl: async (url, init) => {
      spy.modelCalls.push({ url, payload: JSON.parse(init.body) });
      const next = modelResponses[Math.min(modelIndex, modelResponses.length - 1)];
      modelIndex += 1;
      return typeof next === 'function' ? next() : next;
    },
    log: (fields) => spy.logs.push(fields),
  });

  return { handler, spy };
}

const parse = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test('OPTIONS returns 204 with CORS headers and no model call', async () => {
  const { handler, spy } = build();
  const res = await handler({ httpMethod: 'OPTIONS' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
  assert.equal(spy.modelCalls.length, 0);
});

test('non-POST method is rejected', async () => {
  const { handler, spy } = build();
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(spy.modelCalls.length, 0);
});

test('malformed JSON returns 400 and calls nothing', async () => {
  const { handler, spy } = build();
  const res = await handler(event({ body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.equal(spy.rpcCalls.length, 0);
  assert.equal(spy.modelCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Configuration — fail closed
// ---------------------------------------------------------------------------

test('missing OPENAI_API_KEY fails closed with 500 and no reservation', async () => {
  const env = { ...GOOD_ENV };
  delete env.OPENAI_API_KEY;
  const { handler, spy } = build({ env });
  const res = await handler(event());
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).code, 'SERVER_CONFIG');
  assert.equal(spy.rpcCalls.length, 0);
  assert.equal(spy.modelCalls.length, 0);
});

test('each missing Supabase setting fails closed', async () => {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const env = { ...GOOD_ENV };
    delete env[key];
    const { handler, spy } = build({ env });
    const res = await handler(event());
    assert.equal(res.statusCode, 500, `expected fail-closed without ${key}`);
    assert.equal(spy.modelCalls.length, 0);
  }
});

test('SUPABASE_ANON_KEY is neither required nor read', async () => {
  // RPC invocation moved to the service-role client, so the anon key is dead
  // configuration and must not be kept "just in case".
  const env = { ...GOOD_ENV };
  delete env.SUPABASE_ANON_KEY;
  const config = readConfig(env);
  assert.equal(config.ok, true);
  assert.equal('anonKey' in config, false);
  assert.equal(config.problems.includes('SUPABASE_ANON_KEY'), false);

  const { handler } = build({ env });
  const res = await handler(event());
  assert.equal(res.statusCode, 200, 'the Function works with no anon key configured at all');
});

test('missing stale timeout fails closed', async () => {
  const env = { ...GOOD_ENV };
  delete env.DOCUMENT_TRANSCRIPTION_STALE_SECONDS;
  const { handler, spy } = build({ env });
  const res = await handler(event());
  assert.equal(res.statusCode, 500);
  assert.equal(spy.modelCalls.length, 0);
});

test('stale timeout boundary: 90 accepted, 89 and 60 rejected, non-integer rejected', () => {
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '90' }).ok, true);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '89' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '60' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '90.5' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: 'soon' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_STALE_SECONDS: '300' }).ok, true);
});

test('function timeout must be exactly the documented 60', () => {
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS: '26' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS: '10' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS: '900' }).ok, false);
});

test('image ceiling is an encoded-base64 byte count with a fixed body allowance', () => {
  const c = readConfig(GOOD_ENV);
  assert.equal(c.maxImageBase64Bytes, TEST_MAX_B64);  assert.equal(c.maxRequestBodyBytes, TEST_MAX_B64 + mod._test.REQUEST_JSON_OVERHEAD_BYTES);
  const d = readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES: undefined });
  assert.equal(d.maxImageBase64Bytes, mod._test.DEFAULT_MAX_IMAGE_BASE64_BYTES);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES: '1000' }).ok, false);
  assert.equal(readConfig({ ...GOOD_ENV, DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES: '9000000' }).ok, false);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('missing bearer token returns 401 before any reservation', async () => {
  const { handler, spy } = build();
  const res = await handler(event({ headers: {} }));
  assert.equal(res.statusCode, 401);
  assert.equal(spy.rpcCalls.length, 0);
  assert.equal(spy.modelCalls.length, 0);
});

test('invalid bearer token returns 401', async () => {
  const { handler, spy } = build({ authResult: null });
  const res = await handler(event());
  assert.equal(res.statusCode, 401);
  assert.equal(spy.modelCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

test('missing or non-UUID identifiers are rejected', async () => {
  const { handler } = build();
  for (const override of [
    { requestId: undefined },
    { requestId: 'not-a-uuid' },
    { documentCaptureId: undefined },
    { documentCaptureId: '1234' },
    { workOrderId: '' },
    { workOrderId: 'bad id with spaces' },
  ]) {
    const res = await handler(event({ body: body(override) }));
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(override)}`);
  }
});

test('pageNumber must be an integer from 1 to 5', async () => {
  const { handler, spy } = build();
  for (const pageNumber of [0, -1, 6, 99, 1.5, '2', null]) {
    const res = await handler(event({ body: body({ pageNumber }) }));
    assert.equal(res.statusCode, 400, `expected 400 for pageNumber=${pageNumber}`);
  }
  assert.equal(spy.modelCalls.length, 0);
  for (const pageNumber of [1, 2, 3, 4, 5]) {
    const res = await handler(event({ body: body({ pageNumber }) }));
    assert.equal(res.statusCode, 200);
  }
});

// ---------------------------------------------------------------------------
// Image validation — media type, real JPEG bytes, size
// ---------------------------------------------------------------------------

test('non-JPEG data URLs are rejected', async () => {
  const { handler, spy } = build();
  const filler = 'A'.repeat(200);
  for (const imageDataUrl of [
    `data:image/png;base64,${filler}`,
    `data:image/webp;base64,${filler}`,
    `data:image/svg+xml;base64,${filler}`,
    `data:text/html;base64,${filler}`,
    'https://example.com/page.jpg',
  ]) {
    const res = await handler(event({ body: body({ imageDataUrl }) }));
    assert.equal(res.statusCode, 400, `expected 400 for ${imageDataUrl.slice(0, 24)}`);
  }
  assert.equal(spy.modelCalls.length, 0);
});

test('valid JPEG magic bytes are accepted', async () => {
  const { handler } = build();
  const res = await handler(event({ body: body({ imageDataUrl: jpegDataUrl(1200) }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).ok, true);
});

test('non-JPEG bytes disguised as image/jpeg are rejected before the model', async () => {
  const { handler, spy } = build();
  const res = await handler(event({ body: body({ imageDataUrl: disguisedNonJpegDataUrl() }) }));
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /not a JPEG/i);
  assert.equal(spy.modelCalls.length, 0);
  assert.equal(spy.rpcCalls.length, 0, 'a bad image must not consume quota');
});

test('invalid base64 and undersized payloads are rejected', async () => {
  const { handler } = build();
  const notMultipleOfFour = await handler(event({ body: body({ imageDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(101) }) }));
  assert.equal(notMultipleOfFour.statusCode, 400);
  const tiny = await handler(event({ body: body({ imageDataUrl: 'data:image/jpeg;base64,AAAA' }) }));
  assert.equal(tiny.statusCode, 400);
});

test('encoded-size boundary: at the ceiling accepted, just over rejected with 413', async () => {
  const atLimit = build();
  const okRes = await atLimit.handler(event({ body: body({ imageDataUrl: jpegDataUrlOfEncodedLength(TEST_MAX_B64) }) }));
  assert.equal(okRes.statusCode, 200);

  const over = build();
  const tooBig = await over.handler(event({ body: body({ imageDataUrl: jpegDataUrlOfEncodedLength(TEST_MAX_B64 + 4) }) }));
  assert.equal(tooBig.statusCode, 413);
  assert.equal(parse(tooBig).code, 'IMAGE_TOO_LARGE');
  assert.equal(over.spy.modelCalls.length, 0);
  assert.equal(over.spy.rpcCalls.length, 0, 'an oversized image must not consume quota');
});

test('a body beyond the whole-request ceiling is rejected before JSON parsing', async () => {
  const { handler, spy } = build();
  const res = await handler(event({ body: 'x'.repeat(TEST_MAX_B64 + mod._test.REQUEST_JSON_OVERHEAD_BYTES + 1) }));
  assert.equal(res.statusCode, 413);
  assert.equal(spy.modelCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Authorization and reservation
// ---------------------------------------------------------------------------

test('feature disabled and inaccessible work order return the same generic 403', async () => {
  const disabled = build({ reserve: { decision: 'feature_disabled' } });
  const forbidden = build({ reserve: { decision: 'forbidden' } });
  const a = await disabled.handler(event());
  const b = await forbidden.handler(event());
  assert.equal(a.statusCode, 403);
  assert.equal(b.statusCode, 403);
  assert.deepEqual(parse(a), parse(b), 'responses must be indistinguishable');
  assert.equal(disabled.spy.modelCalls.length, 0);
  assert.equal(forbidden.spy.modelCalls.length, 0);
});

test('rate limit returns 429 with no model call', async () => {
  const { handler, spy } = build({ reserve: { decision: 'rate_limited', limit_scope: 'shop_day' } });
  const res = await handler(event());
  assert.equal(res.statusCode, 429);
  assert.equal(parse(res).code, 'RATE_LIMITED');
  assert.equal(spy.modelCalls.length, 0);
});

test('reservation failure fails closed with no model call', async () => {
  const { handler, spy } = build({ rpcError: 'connection refused' });
  const res = await handler(event());
  assert.equal(res.statusCode, 500);
  assert.equal(spy.modelCalls.length, 0);
});

test('order is reserve, then model, then finalize', async () => {
  const { handler, spy } = build();
  await handler(event());
  assert.equal(spy.rpcCalls[0].name, mod._test.RESERVE_RPC);
  assert.equal(spy.modelCalls.length, 1);
  assert.equal(spy.rpcCalls[spy.rpcCalls.length - 1].name, mod._test.FINALIZE_RPC);
});

test('the reservation carries the validated stale threshold, page identity, and verified actor', async () => {
  const { handler, spy } = build();
  await handler(event({ body: body({ pageNumber: 4 }) }));
  const params = spy.rpcCalls[0].params;
  assert.equal(params.p_stale_seconds, 90);
  assert.equal(params.p_page_number, 4);
  assert.equal(params.p_request_id, REQUEST_ID);
  assert.equal(params.p_document_capture_id, CAPTURE_ID);
  assert.equal(params.p_actor_id, USER_ID);
});

// ---------------------------------------------------------------------------
// Server-side identity: service-role invocation with an explicit verified actor
// ---------------------------------------------------------------------------

test('finalize carries the same verified actor as the reservation', async () => {
  const { handler, spy } = build();
  await handler(event());
  const reserve = spy.rpcCalls.find((c) => c.name === mod._test.RESERVE_RPC);
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(reserve.params.p_actor_id, USER_ID);
  assert.equal(finalizeCall.params.p_actor_id, USER_ID);
});

test('a tier-contract failure still finalizes with the verified actor', async () => {
  const { handler, spy } = build({ reserve: { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID } });
  await handler(event({ body: body({ qualityTier: 'strong' }) }));
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(finalizeCall.params.p_actor_id, USER_ID);
  assert.equal(finalizeCall.params.p_error_category, 'tier_contract_violation');
});

test('body-supplied identity fields are ignored entirely', async () => {
  const { handler, spy } = build();
  await handler(event({
    body: body({
      actorId: '99999999-9999-4999-8999-999999999999',
      userId: '99999999-9999-4999-8999-999999999999',
      profileId: '99999999-9999-4999-8999-999999999999',
      shopId: '88888888-8888-4888-8888-888888888888',
    }),
  }));
  for (const call of spy.rpcCalls) {
    assert.equal(call.params.p_actor_id, USER_ID, 'actor must come from the verified token only');
    assert.equal(JSON.stringify(call.params).includes('9999999'), false);
    assert.equal(JSON.stringify(call.params).includes('8888888'), false);
    assert.equal('p_shop_id' in call.params, false, 'the browser never supplies a shop');
  }
});

test('p_actor_id is never the bearer token or any body value', async () => {
  const { handler, spy } = build();
  await handler(event({ headers: { authorization: 'Bearer some-opaque-jwt' } }));
  for (const call of spy.rpcCalls) {
    assert.equal(call.params.p_actor_id, USER_ID);
    assert.notEqual(call.params.p_actor_id, 'some-opaque-jwt');
    assert.equal(JSON.stringify(call.params).includes('some-opaque-jwt'), false);
  }
});

test('production RPC wiring uses the service-role key and forwards no caller JWT', () => {
  const seen = [];
  const fakeCreateClient = (url, key, options) => {
    seen.push({ url, key, options });
    return { rpc: (name, params) => ({ data: { name, params }, error: null }) };
  };
  const callRpc = mod._test.makeCallRpc(fakeCreateClient);
  const config = readConfig(GOOD_ENV);

  const out = callRpc('some_rpc', { p_actor_id: USER_ID }, 'Bearer-should-not-travel', config);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.supabase.co');
  assert.equal(seen[0].key, 'service-role', 'must call as the server, not as the caller');
  const optionsDump = JSON.stringify(seen[0].options || {});
  assert.equal(optionsDump.includes('Authorization'), false, 'no caller JWT may be forwarded');
  assert.equal(optionsDump.includes('Bearer-should-not-travel'), false);
  assert.equal(seen[0].options.auth.persistSession, false);
  assert.equal(out.data.name, 'some_rpc');
  assert.equal(out.data.params.p_actor_id, USER_ID);
});

// ---------------------------------------------------------------------------
// Duplicate request state machine
// ---------------------------------------------------------------------------

test('duplicate while processing returns in-progress and no second model call', async () => {
  const { handler, spy } = build({ reserve: { decision: 'duplicate_active' } });
  const res = await handler(event());
  assert.equal(res.statusCode, 409);
  assert.equal(parse(res).code, 'REQUEST_IN_PROGRESS');
  assert.equal(spy.modelCalls.length, 0);
});

test('duplicate after completion returns RESULT_NOT_REPLAYABLE and no second model call', async () => {
  const { handler, spy } = build({ reserve: { decision: 'duplicate_completed' } });
  const res = await handler(event());
  assert.equal(res.statusCode, 409);
  const parsed = parse(res);
  assert.equal(parsed.code, 'RESULT_NOT_REPLAYABLE');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /already read/i);
  assert.equal(spy.modelCalls.length, 0);
});

test('terminal failed request id is not retried automatically', async () => {
  const { handler, spy } = build({ reserve: { decision: 'duplicate_failed' } });
  const res = await handler(event());
  assert.equal(res.statusCode, 409);
  assert.equal(parse(res).code, 'REQUEST_TERMINAL');
  assert.equal(spy.modelCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Tier routing — neutral labels, no silent substitution
// ---------------------------------------------------------------------------

test('standard tier routes to the standard model', async () => {
  const { handler, spy } = build();
  await handler(event());
  assert.equal(spy.modelCalls[0].payload.model, mod._test.DEFAULT_STANDARD_MODEL);
});

test('strong tier routes to the strong model', async () => {
  const { handler, spy } = build({ reserve: { decision: 'authorized', quality_tier: 'strong', shop_id: SHOP_ID } });
  const res = await handler(event({ body: body({ qualityTier: 'strong' }) }));
  assert.equal(spy.modelCalls[0].payload.model, mod._test.DEFAULT_STRONG_MODEL);
  assert.equal(parse(res).qualityTier, 'strong');
});

test('missing or unrecognised tier defaults to standard', async () => {
  for (const qualityTier of [undefined, '', 'STRONG', 'premium', 42, null]) {
    const { handler, spy } = build();
    await handler(event({ body: body({ qualityTier }) }));
    assert.equal(spy.modelCalls[0].payload.model, mod._test.DEFAULT_STANDARD_MODEL, `tier=${qualityTier}`);
    assert.equal(spy.rpcCalls[0].params.p_quality_tier, 'standard');
  }
  assert.equal(normalizeTier('strong'), 'strong');
  assert.equal(normalizeTier('anything-else'), 'standard');
});

test('a silent downgrade from strong to standard never reaches the model', async () => {
  const { handler, spy } = build({ reserve: { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID } });
  const res = await handler(event({ body: body({ qualityTier: 'strong' }) }));
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).code, 'SERVER_CONFIG');
  assert.equal(spy.modelCalls.length, 0);
});

test('a silent upgrade from standard to strong never reaches the model', async () => {
  const { handler, spy } = build({ reserve: { decision: 'authorized', quality_tier: 'strong', shop_id: SHOP_ID } });
  const res = await handler(event({ body: body({ qualityTier: 'standard' }) }));
  assert.equal(res.statusCode, 500);
  assert.equal(spy.modelCalls.length, 0);
});

test('a reservation with no tier at all is a contract failure', async () => {
  const { handler, spy } = build({ reserve: { decision: 'authorized', shop_id: SHOP_ID } });
  const res = await handler(event());
  assert.equal(res.statusCode, 500);
  assert.equal(spy.modelCalls.length, 0);
});

test('every tier-contract failure finalizes the reservation as failed', async () => {
  const cases = [
    { reserve: { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID }, tier: 'strong', label: 'downgrade' },
    { reserve: { decision: 'authorized', quality_tier: 'strong', shop_id: SHOP_ID }, tier: 'standard', label: 'upgrade' },
    { reserve: { decision: 'authorized', shop_id: SHOP_ID }, tier: 'standard', label: 'missing' },
  ];
  for (const c of cases) {
    const { handler, spy } = build({ reserve: c.reserve });
    await handler(event({ body: body({ qualityTier: c.tier }) }));
    assert.equal(spy.modelCalls.length, 0, `${c.label}: model must not be called`);
    const finalizeCall = spy.rpcCalls.find((x) => x.name === mod._test.FINALIZE_RPC);
    assert.ok(finalizeCall, `${c.label}: reservation must be finalized, not left processing`);
    assert.equal(finalizeCall.params.p_outcome, 'failed');
    assert.equal(finalizeCall.params.p_error_category, 'tier_contract_violation');
    assert.equal(finalizeCall.params.p_input_tokens, null);
    assert.equal(finalizeCall.params.p_output_tokens, null);
  }
});

test('a tier-contract failure survives a failing finalize', async () => {
  const handler = createHandler({
    env: GOOD_ENV,
    authenticate: async () => ({ userId: USER_ID }),
    callRpc: async (name) => {
      if (name === mod._test.FINALIZE_RPC) return { data: null, error: { message: 'write failed' } };
      return { data: { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID }, error: null };
    },
    fetchImpl: async () => { throw new Error('the model must never be called here'); },
    log: () => {},
  });
  const res = await handler(event({ body: body({ qualityTier: 'strong' }) }));
  assert.equal(res.statusCode, 500);
});

test('a browser-supplied model name never selects the model', async () => {
  const { handler, spy } = build();
  await handler(event({ body: body({ model: 'gpt-4o-mini', OPENAI_DOCUMENT_MODEL: 'evil' }) }));
  assert.equal(spy.modelCalls[0].payload.model, mod._test.DEFAULT_STANDARD_MODEL);
});

test('both tiers behave identically apart from the selected model', async () => {
  const std = build({ modelResponses: [modelResponse(GOOD_PAYLOAD)] });
  const strong = build({
    reserve: { decision: 'authorized', quality_tier: 'strong', shop_id: SHOP_ID },
    modelResponses: [modelResponse(GOOD_PAYLOAD)],
  });

  const a = parse(await std.handler(event()));
  const b = parse(await strong.handler(event({ body: body({ qualityTier: 'strong' }) })));
  assert.deepEqual({ ...a, qualityTier: null }, { ...b, qualityTier: null });

  const pa = std.spy.modelCalls[0].payload;
  const pb = strong.spy.modelCalls[0].payload;
  assert.notEqual(pa.model, pb.model);
  assert.deepEqual({ ...pa, model: null }, { ...pb, model: null }, 'only `model` may differ between tiers');
});

// ---------------------------------------------------------------------------
// Model request parameters
// ---------------------------------------------------------------------------

test('model request uses reasoning_effort none, a completion-token cap, explicit image detail, and no temperature or seed', async () => {
  const { handler, spy } = build();
  await handler(event());
  const payload = spy.modelCalls[0].payload;
  assert.equal(payload.reasoning_effort, 'none');
  assert.equal(typeof payload.max_completion_tokens, 'number');
  assert.equal('temperature' in payload, false);
  assert.equal('seed' in payload, false);
  assert.equal('max_tokens' in payload, false);
  assert.equal(payload.response_format.type, 'json_schema');
  assert.equal(payload.response_format.json_schema.strict, true);
  const imagePart = payload.messages[1].content.find((p) => p.type === 'image_url');
  assert.equal(imagePart.image_url.detail, mod._test.MODEL_IMAGE_DETAIL);
});

test('image detail is identical for both tiers', async () => {
  const std = build();
  await std.handler(event());
  const strong = build({ reserve: { decision: 'authorized', quality_tier: 'strong', shop_id: SHOP_ID } });
  await strong.handler(event({ body: body({ qualityTier: 'strong' }) }));
  const detailOf = (spy) => spy.modelCalls[0].payload.messages[1].content.find((p) => p.type === 'image_url').image_url.detail;
  assert.equal(detailOf(std.spy), detailOf(strong.spy));
});

// ---------------------------------------------------------------------------
// Strict Structured Output parsing
// ---------------------------------------------------------------------------

test('parseModelContent accepts only a clean JSON object', () => {
  assert.deepEqual(parseModelContent('{"text":"a"}'), { text: 'a' });
  assert.equal(parseModelContent('```json\n{"text":"a"}\n```'), null, 'markdown fences must not be salvaged');
  assert.equal(parseModelContent('Here is the page:\n{"text":"a"}'), null, 'prefixed commentary must not be salvaged');
  assert.equal(parseModelContent('{"text":"a"}\nHope that helps!'), null, 'trailing commentary must not be salvaged');
  assert.equal(parseModelContent('[{"text":"a"}]'), null, 'arrays are not the contract');
  assert.equal(parseModelContent('"just a string"'), null);
  assert.equal(parseModelContent('null'), null);
  assert.equal(parseModelContent('{oops}'), null);
  assert.equal(parseModelContent(''), null);
  assert.equal(parseModelContent(undefined), null);
});

test('a fenced or commented response is treated as unparseable and uses the one retry', async () => {
  const { handler, spy } = build({
    modelResponses: [modelResponse('```json\n' + JSON.stringify(GOOD_PAYLOAD) + '\n```'), modelResponse(GOOD_PAYLOAD)],
  });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
  assert.equal(spy.modelCalls.length, 2);
});

test('two unparseable responses end as an authorized AI failure', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse('commentary only'), modelResponse('still commentary')] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'AI_FAILED');
  assert.equal(spy.modelCalls.length, 2);
});

test('the provider payload schema is validated locally', () => {
  const good = { text: 'a', confidenceScore: 0.5, lowConfidenceRegions: [], needsReview: false };
  assert.equal(validateModelPayload(good), true);
  assert.equal(validateModelPayload({}), false, 'empty object is not the contract');
  assert.equal(validateModelPayload({ ...good, extra: 1 }), false, 'extra top-level key');
  assert.equal(validateModelPayload({ text: 'a', confidenceScore: 0.5, needsReview: false }), false, 'missing field');
  assert.equal(validateModelPayload({ ...good, text: 42 }), false, 'wrong text type');
  assert.equal(validateModelPayload({ ...good, needsReview: 'yes' }), false, 'wrong boolean type');
  assert.equal(validateModelPayload({ ...good, confidenceScore: '0.5' }), false, 'confidence as string');
  assert.equal(validateModelPayload({ ...good, confidenceScore: Number.NaN }), false, 'NaN confidence');
  assert.equal(validateModelPayload({ ...good, confidenceScore: Infinity }), false, 'non-finite confidence');
  assert.equal(validateModelPayload({ ...good, confidenceScore: 1.4 }), false, 'confidence above 1');
  assert.equal(validateModelPayload({ ...good, confidenceScore: -0.2 }), false, 'confidence below 0');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: {} }), false, 'regions must be an array');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: [{ text: 'a' }] }), false, 'region missing reason');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: [{ text: 'a', reason: 'b', pageNumber: 1 }] }), false, 'extra region key');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: [{ text: 'a', reason: 9 }] }), false, 'wrong region type');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: [null] }), false, 'null region');
  assert.equal(validateModelPayload({ ...good, lowConfidenceRegions: [{ text: 'a', reason: 'b' }] }), true);
});

test('a schema-invalid but clean JSON object is unparseable and uses the one retry', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}), modelResponse(GOOD_PAYLOAD)] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
  assert.equal(spy.modelCalls.length, 2);
});

test('a wrong-typed payload twice ends as an authorized AI failure', async () => {
  const bad = { text: 5, confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false };
  const { handler, spy } = build({ modelResponses: [modelResponse(bad), modelResponse(bad)] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'AI_FAILED');
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'unparseable_response');
  assert.equal(spy.modelCalls.length, 2);
});

test('the provider schema pins confidence to the 0..1 range', () => {
  const props = mod._test.RESPONSE_JSON_SCHEMA.schema.properties;
  assert.equal(props.confidenceScore.minimum, 0);
  assert.equal(props.confidenceScore.maximum, 1);
});

// ---------------------------------------------------------------------------
// Completion state
// ---------------------------------------------------------------------------

test('a length-truncated completion fails immediately, with no second paid call', async () => {
  const { handler, spy } = build({
    modelResponses: [modelResponse(GOOD_PAYLOAD, { finishReason: 'length' }), modelResponse(GOOD_PAYLOAD)],
  });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'AI_FAILED');
  assert.equal(spy.modelCalls.length, 1, 'a truncated completion must not be retried automatically');
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'incomplete_response');
});

test('a content-filtered completion fails immediately, with no second paid call', async () => {
  const { handler, spy } = build({
    modelResponses: [modelResponse(GOOD_PAYLOAD, { finishReason: 'content_filter' }), modelResponse(GOOD_PAYLOAD)],
  });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(spy.modelCalls.length, 1);
});

test('any other non-stop completion fails immediately', async () => {
  for (const finishReason of ['tool_calls', 'function_call', 'unexpected']) {
    const { handler, spy } = build({
      modelResponses: [modelResponse(GOOD_PAYLOAD, { finishReason }), modelResponse(GOOD_PAYLOAD)],
    });
    const res = parse(await handler(event()));
    assert.equal(res.ok, false, `finish_reason=${finishReason}`);
    assert.equal(spy.modelCalls.length, 1);
  }
});

test('acceptance requires an affirmative stop: missing, null, and empty finish reasons all fail', async () => {
  const cases = [
    { label: 'missing', opts: { omitFinishReason: true } },
    { label: 'null', opts: { finishReason: null } },
    { label: 'empty string', opts: { finishReason: '' } },
  ];
  for (const c of cases) {
    const { handler, spy } = build({
      modelResponses: [modelResponse(GOOD_PAYLOAD, c.opts), modelResponse(GOOD_PAYLOAD)],
    });
    const res = parse(await handler(event()));
    assert.equal(res.ok, false, `${c.label} finish reason must not be accepted`);
    assert.equal(res.code, 'AI_FAILED');
    assert.equal(spy.modelCalls.length, 1, `${c.label}: terminal, no automatic retry`);
    assert.equal(
      spy.rpcCalls.find((x) => x.name === mod._test.FINALIZE_RPC).params.p_error_category,
      'incomplete_response',
    );
  }
});

test('finish_reason "stop" is the only accepted value', async () => {
  const { handler } = build({ modelResponses: [modelResponse(GOOD_PAYLOAD, { finishReason: 'stop' })] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

test('provider 401 is not retried', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 401 })] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(spy.modelCalls.length, 1);
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'provider_auth');
});

test('provider 403 is not retried', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 403 })] });
  await handler(event());
  assert.equal(spy.modelCalls.length, 1);
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'provider_auth');
});

test('provider 429 is not retried inside this invocation', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 429 })] });
  await handler(event());
  assert.equal(spy.modelCalls.length, 1);
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'provider_rate_limit');
});

test('a provider 400 is not retried', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 400 })] });
  await handler(event());
  assert.equal(spy.modelCalls.length, 1);
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'provider_client_error');
});

test('a provider 5xx is retried exactly once', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 503 }), modelResponse(GOOD_PAYLOAD)] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
  assert.equal(spy.modelCalls.length, 2);
});

test('two provider 5xx responses stop after the single retry', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 500 }), modelResponse({}, { status: 500 }), modelResponse(GOOD_PAYLOAD)] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(spy.modelCalls.length, 2);
});

test('a transport failure is retried once and classified as a network error', async () => {
  const { handler, spy } = build({ modelResponses: [networkFailure(), networkFailure()] });
  const res = parse(await handler(event()));
  assert.equal(res.ok, false);
  assert.equal(spy.modelCalls.length, 2);
  assert.equal(spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC).params.p_error_category, 'network_error');
});

test('the retry never changes tier, never re-reserves, and never escalates', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse('bad'), modelResponse('bad'), modelResponse(GOOD_PAYLOAD)] });
  await handler(event());
  assert.equal(spy.modelCalls.length, 2);
  assert.equal(spy.modelCalls[0].payload.model, spy.modelCalls[1].payload.model);
  assert.equal(spy.modelCalls[1].payload.model, mod._test.DEFAULT_STANDARD_MODEL, 'must never escalate automatically');
  assert.equal(spy.rpcCalls.filter((c) => c.name === mod._test.RESERVE_RPC).length, 1);
});

// ---------------------------------------------------------------------------
// Response sanitization
// ---------------------------------------------------------------------------

test('usage is accumulated across both paid calls, never overwritten', async () => {
  const { handler, spy } = build({
    modelResponses: [
      modelResponse('unparseable commentary', { usage: { prompt_tokens: 700, completion_tokens: 30 } }),
      modelResponse(GOOD_PAYLOAD, { usage: { prompt_tokens: 700, completion_tokens: 45 } }),
    ],
  });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
  assert.equal(spy.modelCalls.length, 2);
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(finalizeCall.params.p_input_tokens, 1400, 'both calls burned prompt tokens');
  assert.equal(finalizeCall.params.p_output_tokens, 75);
  const completedLog = spy.logs.find((l) => l.event === 'transcription_completed');
  assert.equal(completedLog.inputTokens, 1400);
  assert.equal(completedLog.outputTokens, 75);
});

test('usage from a failed first call is still counted when the second also fails', async () => {
  const { handler, spy } = build({
    modelResponses: [
      modelResponse('bad', { usage: { prompt_tokens: 500, completion_tokens: 10 } }),
      modelResponse('bad', { usage: { prompt_tokens: 500, completion_tokens: 12 } }),
    ],
  });
  await handler(event());
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(finalizeCall.params.p_outcome, 'failed');
  assert.equal(finalizeCall.params.p_input_tokens, 1000);
  assert.equal(finalizeCall.params.p_output_tokens, 22);
});

test('a provider error with no usage payload reports null token counts', async () => {
  const { handler, spy } = build({ modelResponses: [modelResponse({}, { status: 500 }), modelResponse({}, { status: 500 })] });
  await handler(event());
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(finalizeCall.params.p_input_tokens, null);
  assert.equal(finalizeCall.params.p_output_tokens, null);
});

test('confidence is clamped into 0..1', () => {
  assert.equal(sanitizeResult({ text: 'x', confidenceScore: 4.2 }, 1).confidenceScore, 1);
  assert.equal(sanitizeResult({ text: 'x', confidenceScore: -3 }, 1).confidenceScore, 0);
  assert.equal(sanitizeResult({ text: 'x', confidenceScore: 'high' }, 1).confidenceScore, 0.5);
  assert.equal(sanitizeResult({ text: '', confidenceScore: 'high' }, 1).confidenceScore, 0);
});

test('[illegible] forces review even when the model claims confidence', () => {
  assert.equal(sanitizeResult({ text: 'Replace [illegible] hose', confidenceScore: 0.99, needsReview: false }, 1).needsReview, true);
});

test('empty text forces review', () => {
  assert.equal(sanitizeResult({ text: '   ', confidenceScore: 0.99, needsReview: false }, 1).needsReview, true);
});

test('a low-confidence region forces review', () => {
  const r = sanitizeResult(
    { text: 'Prop shaft', confidenceScore: 0.98, needsReview: false, lowConfidenceRegions: [{ text: 'shaft', reason: 'smudged' }] },
    1,
  );
  assert.equal(r.needsReview, true);
});

test('confidence below 0.75 forces review', () => {
  assert.equal(sanitizeResult({ text: 'ok', confidenceScore: 0.74, needsReview: false }, 1).needsReview, true);
  assert.equal(sanitizeResult({ text: 'ok', confidenceScore: 0.75, needsReview: false }, 1).needsReview, false);
});

test('page identity comes from the request, not the model', async () => {
  // The schema carries no page identity at all, so there is nothing for the model to assert:
  // the response page number and every region's page number are stamped from the request.
  const { handler } = build({
    modelResponses: [modelResponse({
      text: 'Check trim sender',
      confidenceScore: 0.62,
      lowConfidenceRegions: [{ text: 'sender', reason: 'ink smudge' }, { text: '[illegible]', reason: 'fold' }],
      needsReview: true,
    })],
  });
  const res = parse(await handler(event({ body: body({ pageNumber: 3 }) })));
  assert.equal(res.ok, true);
  assert.equal(res.pageNumber, 3);
  assert.equal(res.lowConfidenceRegions.length, 2);
  for (const region of res.lowConfidenceRegions) assert.equal(region.pageNumber, 3);
});

test('a model response that tries to assert page identity is schema-invalid', async () => {
  // Neither a top-level nor a region-level pageNumber is part of the contract, so a response
  // carrying one is rejected outright rather than being allowed to override the request.
  assert.equal(validateModelPayload({
    text: 'x', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false, pageNumber: 99,
  }), false, 'top-level pageNumber is an extra key');
  assert.equal(validateModelPayload({
    text: 'x', confidenceScore: 0.9, needsReview: false,
    lowConfidenceRegions: [{ text: 'y', reason: 'z', pageNumber: 77 }],
  }), false, 'region-level pageNumber is an extra key');

  const { handler, spy } = build({
    modelResponses: [
      modelResponse({ text: 'x', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false, pageNumber: 99 }),
      modelResponse({ text: 'x', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false, pageNumber: 99 }),
    ],
  });
  const res = parse(await handler(event({ body: body({ pageNumber: 3 }) })));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'AI_FAILED');
  assert.equal(spy.modelCalls.length, 2, 'schema-invalid output is retryable once');
});

// ---------------------------------------------------------------------------
// Logging and content safety
// ---------------------------------------------------------------------------

test('logs never contain image data, transcription text, or the bearer token', async () => {
  const secret = 'Customer says the [illegible] gearbox is leaking';
  const { handler, spy } = build({
    modelResponses: [modelResponse({ text: secret, confidenceScore: 0.6, lowConfidenceRegions: [{ text: 'gearbox', reason: 'smudged' }], needsReview: true })],
  });
  await handler(event());
  const dump = JSON.stringify(spy.logs);
  assert.equal(dump.includes(secret), false);
  assert.equal(dump.includes('gearbox'), false);
  assert.equal(dump.includes('data:image'), false);
  assert.equal(dump.includes('valid-token'), false);
  assert.equal(dump.includes('test-key'), false);
  assert.match(dump, /textLength/);
});

test('finalize payloads carry token counts but no content', async () => {
  const { handler, spy } = build();
  await handler(event());
  const finalizeCall = spy.rpcCalls.find((c) => c.name === mod._test.FINALIZE_RPC);
  assert.equal(finalizeCall.params.p_outcome, 'completed');
  assert.equal(finalizeCall.params.p_input_tokens, 120);
  assert.equal(finalizeCall.params.p_output_tokens, 40);
  const keys = Object.keys(finalizeCall.params);
  assert.equal(keys.some((k) => /text|image|body|content/i.test(k)), false);
  assert.equal(JSON.stringify(finalizeCall.params).includes('data:image'), false);
});

test('a finalize failure does not lose the user result', async () => {
  const handler = createHandler({
    env: GOOD_ENV,
    authenticate: async () => ({ userId: USER_ID }),
    callRpc: async (name) => {
      if (name === mod._test.FINALIZE_RPC) return { data: null, error: { message: 'write failed' } };
      return { data: { decision: 'authorized', quality_tier: 'standard', shop_id: SHOP_ID }, error: null };
    },
    fetchImpl: async () => modelResponse({ text: 'Still delivered', confidenceScore: 0.9, lowConfidenceRegions: [], needsReview: false }),
    log: () => {},
  });
  const res = parse(await handler(event()));
  assert.equal(res.ok, true);
  assert.equal(res.text, 'Still delivered');
});

// ---------------------------------------------------------------------------
// Pure helper coverage
// ---------------------------------------------------------------------------

test('validateShape accepts a well-formed body and rejects a non-object', () => {
  assert.equal(validateShape(JSON.parse(body())), null);
  assert.notEqual(validateShape(null), null);
  assert.notEqual(validateShape([]), null);
});

test('validateImage reports encoded and estimated decoded size for a good JPEG', () => {
  const out = validateImage(jpegDataUrl(1000), 2000000);
  assert.equal(out.error, undefined);
  assert.ok(out.base64Bytes > 0);
  assert.ok(out.decodedBytesEstimate > 0);
});

test('only the three documented categories are retryable', () => {
  const retryable = mod._test.RETRYABLE_CATEGORIES;
  for (const c of ['network_error', 'provider_server_error', 'unparseable_response']) {
    assert.equal(retryable.has(c), true, `${c} should be retryable`);
  }
  for (const c of ['provider_auth', 'provider_rate_limit', 'provider_client_error', 'incomplete_response']) {
    assert.equal(retryable.has(c), false, `${c} must not be retryable`);
  }
});

test('no test in this file performs a real network call', () => {
  // Every handler in this suite is constructed through createHandler with an injected
  // fetchImpl and callRpc. The production wiring (which requires @supabase/supabase-js and
  // the global fetch) is never invoked here.
  assert.equal(typeof mod.handler, 'function');
  assert.equal(typeof mod._test.createHandler, 'function');
});
