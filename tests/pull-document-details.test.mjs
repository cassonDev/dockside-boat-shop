// Mocked tests for netlify/functions/pull-document-details.js
//
// Run:  node --test tests/pull-document-details.test.mjs
//
// Nothing here contacts Supabase or OpenAI: sign-in, the shop check and the model
// are all injected fakes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHandler, validateBody, buildUserMessage, cleanModelText, checkAccess, NOTHING_FOUND } =
  require('../netlify/functions/pull-document-details.js')._test;

const ENV = { OPENAI_API_KEY: 'k', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's' };
const USER = 'user-1';

const goodBody = (over = {}) => ({
  workOrderId: 'K7M2Q',
  instruction: 'just the parts and the serial numbers',
  pages: [{ pageNumber: 1, text: 'Impeller kit x1\nSerial 12345' }, { pageNumber: 2, text: 'Labour 2h' }],
  ...over,
});

function modelReply(content, { status = 200, finish = 'stop' } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({
      choices: [{ finish_reason: finish, message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });
}

function makeHandler({ fetchImpl = modelReply('• Impeller kit x1\nSerial 12345'), access = async () => 'ok',
  authenticate = async () => ({ userId: USER }), env = ENV } = {}) {
  const calls = { fetch: 0, access: 0, bodies: [] };
  const handler = createHandler({
    env,
    authenticate,
    access: async (...a) => { calls.access += 1; return access(...a); },
    fetchImpl: async (url, init) => { calls.fetch += 1; calls.bodies.push(JSON.parse(init.body)); return fetchImpl(url, init); },
    log: () => {},
  });
  return { handler, calls };
}

const post = (body, headers = { authorization: 'Bearer tok' }) =>
  ({ httpMethod: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const parse = (res) => JSON.parse(res.body);

test('happy path returns only the pulled text', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { ok: true, text: '• Impeller kit x1\nSerial 12345' });
  assert.equal(calls.fetch, 1);
  // The browser never picks the model.
  assert.equal(calls.bodies[0].model, 'gpt-5.6-luna');
});

test('a model field sent by the browser is ignored', async () => {
  const { handler, calls } = makeHandler();
  await handler(post(goodBody({ model: 'something-expensive' })));
  assert.equal(calls.bodies[0].model, 'gpt-5.6-luna');
});

test('OPENAI_DOCUMENT_MODEL overrides the default model', async () => {
  const { handler, calls } = makeHandler({ env: { ...ENV, OPENAI_DOCUMENT_MODEL: 'custom-model' } });
  await handler(post(goodBody()));
  assert.equal(calls.bodies[0].model, 'custom-model');
});

test('missing configuration fails closed before anything else', async () => {
  const { handler, calls } = makeHandler({ env: { SUPABASE_URL: 'x' } });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).code, 'SERVER_CONFIG');
  assert.equal(calls.fetch, 0);
});

test('no sign-in token: refused, no model call', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler(post(goodBody(), {}));
  assert.equal(res.statusCode, 401);
  assert.equal(calls.fetch, 0);
});

test('invalid token: refused, no model call', async () => {
  const { handler, calls } = makeHandler({ authenticate: async () => null });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 401);
  assert.equal(calls.fetch, 0);
});

test('another shop / unknown work order: refused, no model call', async () => {
  const { handler, calls } = makeHandler({ access: async () => 'forbidden' });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, 'NOT_AUTHORIZED');
  assert.equal(calls.fetch, 0);
});

test('feature switched off: refused, no model call', async () => {
  const { handler, calls } = makeHandler({ access: async () => 'feature_disabled' });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, 'FEATURE_DISABLED');
  assert.equal(calls.fetch, 0);
});

test('access check failing is not treated as allowed', async () => {
  const { handler, calls } = makeHandler({ access: async () => { throw new Error('db down'); } });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 503);
  assert.equal(calls.fetch, 0);
});

test('validation happens before sign-in and access checks', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler(post(goodBody({ instruction: '   ' })));
  assert.equal(res.statusCode, 400);
  assert.equal(calls.access, 0);
  assert.equal(calls.fetch, 0);
});

test('validateBody rules', () => {
  assert.equal(validateBody(goodBody()), null);
  assert.match(validateBody(goodBody({ workOrderId: '../x' })), /work order/);
  assert.match(validateBody(goodBody({ instruction: 'x'.repeat(501) })), /500/);
  assert.match(validateBody(goodBody({ pages: [] })), /No page text/);
  assert.match(validateBody(goodBody({ pages: Array.from({ length: 6 }, (_, i) => ({ pageNumber: i + 1, text: 'a' })) })), /at most 5/);
  assert.match(validateBody(goodBody({ pages: [{ pageNumber: 1, text: 'a' }, { pageNumber: 1, text: 'b' }] })), /page number/);
  assert.match(validateBody(goodBody({ pages: [{ pageNumber: 0, text: 'a' }] })), /page number/);
  assert.match(validateBody(goodBody({ pages: [{ pageNumber: 1, text: 'x'.repeat(20001) }] })), /too much text/);
  assert.match(validateBody(goodBody({ pages: [{ pageNumber: 1, text: '   ' }] })), /No page text/);
});

test('oversized body is refused', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler(post('x'.repeat(150001)));
  assert.equal(res.statusCode, 413);
  assert.equal(calls.fetch, 0);
});

test('page text is fenced as data, in page order', () => {
  const msg = buildUserMessage(' parts ', [{ pageNumber: 2, text: 'B' }, { pageNumber: 1, text: 'A' }]);
  assert.ok(msg.startsWith('Request: parts\n'));
  assert.ok(msg.indexOf('<<<PAGE 1>>>') < msg.indexOf('<<<PAGE 2>>>'));
  assert.ok(msg.includes('<<<END PAGE 2>>>'));
});

test('markdown the model adds is cleaned up', () => {
  assert.equal(cleanModelText('## Parts\n**Impeller** kit\n- one\n* two'), 'Parts\nImpeller kit\n• one\n• two');
});

test('empty model answer becomes a clear "nothing found" line', async () => {
  const { handler } = makeHandler({ fetchImpl: modelReply('   ') });
  const res = await handler(post(goodBody()));
  assert.equal(parse(res).text, NOTHING_FOUND);
});

test('a cut-off answer is refused rather than shown as complete', async () => {
  const { handler, calls } = makeHandler({ fetchImpl: modelReply('• partial', { finish: 'length' }) });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 502);
  assert.equal(calls.fetch, 1);   // not retried: the same call would be cut off again
});

test('provider 5xx is retried once, then succeeds', async () => {
  let n = 0;
  const flaky = async (...a) => { n += 1; return n === 1 ? modelReply('', { status: 503 })(...a) : modelReply('• ok')(...a); };
  const { handler, calls } = makeHandler({ fetchImpl: flaky });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).text, '• ok');
  assert.equal(calls.fetch, 2);
});

test('provider 4xx is not retried', async () => {
  const { handler, calls } = makeHandler({ fetchImpl: modelReply('', { status: 401 }) });
  const res = await handler(post(goodBody()));
  assert.equal(res.statusCode, 502);
  assert.equal(calls.fetch, 1);
});

// ---- checkAccess against a fake query builder --------------------------------

function fakeDb(tables) {
  return {
    from(name) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(col, val) { filters[col] = val; return q; },
        async maybeSingle() {
          const row = (tables[name] || []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          return { data: row || null, error: null };
        },
      };
      return q;
    },
  };
}

const TABLES = {
  work_orders: [{ id: 'WO1', shop_id: 'A', active: true }, { id: 'WO2', shop_id: 'B', active: true }, { id: 'OLD', shop_id: 'A', active: false }],
  profiles: [{ id: 'u1', active: true }, { id: 'gone', active: false }],
  shop_memberships: [{ id: 'm1', profile_id: 'u1', shop_id: 'A', is_active: true }, { id: 'm2', profile_id: 'gone', shop_id: 'A', is_active: true }],
  shops: [{ id: 'A', settings: { features: { document_transcription: true } } }, { id: 'B', settings: {} }],
};

test('checkAccess: member of the owning shop with the feature on', async () => {
  assert.equal(await checkAccess(fakeDb(TABLES), 'u1', 'WO1'), 'ok');
});

test('checkAccess: work order in another shop looks the same as a missing one', async () => {
  assert.equal(await checkAccess(fakeDb(TABLES), 'u1', 'WO2'), 'forbidden');
  assert.equal(await checkAccess(fakeDb(TABLES), 'u1', 'NOPE'), 'forbidden');
});

test('checkAccess: archived work order and deactivated profile are refused', async () => {
  assert.equal(await checkAccess(fakeDb(TABLES), 'u1', 'OLD'), 'forbidden');
  assert.equal(await checkAccess(fakeDb(TABLES), 'gone', 'WO1'), 'forbidden');
});

test('checkAccess: feature must be explicitly on', async () => {
  const tables = { ...TABLES, shops: [{ id: 'A', settings: { features: { document_transcription: 'yes' } } }] };
  assert.equal(await checkAccess(fakeDb(tables), 'u1', 'WO1'), 'feature_disabled');
});

// ---- the browser-side call (document-capture.js data layer) ------------------

import { createDocumentCaptureApi, DOCUMENT_PULL_ENDPOINT } from '../document-capture.js';

function apiWith(fetchImpl, session = { access_token: 'tok' }) {
  const sent = [];
  const api = createDocumentCaptureApi({
    supabase: {}, getSession: async () => session,
    fetchImpl: async (url, init) => { sent.push({ url, init }); return fetchImpl(url, init); },
  });
  return { api, sent };
}

const jsonRes = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });

test('browser call: posts to the protected Function with the sign-in token and only page text', async () => {
  const { api, sent } = apiWith(async () => jsonRes(200, { ok: true, text: '• parts' }));
  const r = await api.pullDocumentDetails({ workOrderId: 'K7M2Q', instruction: 'parts',
    pages: [{ pageNumber: 1, text: 'A', ocrBlob: { big: true }, pageId: 'p1' }] });
  assert.deepEqual(r, { ok: true, text: '• parts' });
  assert.equal(sent[0].url, DOCUMENT_PULL_ENDPOINT);
  assert.equal(sent[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(sent[0].init.body), { workOrderId: 'K7M2Q', instruction: 'parts', pages: [{ pageNumber: 1, text: 'A' }] });
});

test('browser call: signed out makes no request', async () => {
  const { api, sent } = apiWith(async () => jsonRes(200, { ok: true, text: 'x' }), null);
  const r = await api.pullDocumentDetails({ workOrderId: 'K7M2Q', instruction: 'parts', pages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNAUTHENTICATED');
  assert.equal(sent.length, 0);
});

test('browser call: offline and server errors come back as plain messages', async () => {
  const offline = apiWith(async () => { throw new Error('network'); });
  assert.equal((await offline.api.pullDocumentDetails({ workOrderId: 'K', instruction: 'x', pages: [] })).code, 'OFFLINE');
  const refused = apiWith(async () => jsonRes(403, { ok: false, code: 'FEATURE_DISABLED', error: 'Turned off.' }));
  assert.deepEqual(await refused.api.pullDocumentDetails({ workOrderId: 'K', instruction: 'x', pages: [] }),
    { ok: false, code: 'FEATURE_DISABLED', error: 'Turned off.' });
  const garbage = apiWith(async () => ({ status: 502, ok: false, text: async () => '<html>' }));
  const g = await garbage.api.pullDocumentDetails({ workOrderId: 'K', instruction: 'x', pages: [] });
  assert.equal(g.ok, false);
  assert.ok(g.error);
});
