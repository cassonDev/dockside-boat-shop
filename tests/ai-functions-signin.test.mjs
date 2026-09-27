// Sign-in checks for the older AI Functions (ai-extract, extract-serial-number)
// and the shared verify-shop-member helper.
// Run:  node --test tests/ai-functions-signin.test.mjs
// No network: Supabase is a fake client, and global fetch is replaced so any
// attempt to reach OpenAI is counted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY = 'test-key';
const aiExtract = require('../netlify/functions/ai-extract.js');
const serial = require('../netlify/functions/extract-serial-number.js');
const { verifyShopMember, bearerToken } = require('../netlify/functions/lib/verify-shop-member.js');

// ---- count every call that would reach OpenAI ---------------------------------

let openAiCalls = 0;
globalThis.fetch = async (url) => {
  openAiCalls += 1;
  const content = String(url).includes('openai')
    ? JSON.stringify({ serialNumber: 'AB123', confidenceScore: 0.9, alternateCandidates: [], needsReview: false, customerName: 'Pat' })
    : '{}';
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }),
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
};

const SIGNED_OUT = { ok: false, statusCode: 401, code: 'UNAUTHENTICATED', error: 'You are signed out. Sign in again.' };
const NO_SHOP = { ok: false, statusCode: 403, code: 'NOT_AUTHORIZED', error: 'Your account is not active in a shop.' };
const MEMBER = { ok: true, userId: 'u1', shopId: 'A' };

const extractEvent = { httpMethod: 'POST', headers: { authorization: 'Bearer t' },
  body: JSON.stringify({ rawText: 'Pat Lee, Bayliner', schemaFields: ['customerName'], schemaHint: '' }) };
const serialEvent = { httpMethod: 'POST', headers: { authorization: 'Bearer t' },
  body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,AAAA' }) };

for (const [name, mod, event] of [['ai-extract', aiExtract, extractEvent], ['extract-serial-number', serial, serialEvent]]) {
  test(`${name}: signed out -> 401 and OpenAI is never called`, async () => {
    mod._test.deps.verify = async () => SIGNED_OUT;
    openAiCalls = 0;
    const res = await mod.handler(event);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).code, 'UNAUTHENTICATED');
    assert.equal(openAiCalls, 0);
  });

  test(`${name}: signed in but not active in a shop -> 403 and no OpenAI call`, async () => {
    mod._test.deps.verify = async () => NO_SHOP;
    openAiCalls = 0;
    const res = await mod.handler(event);
    assert.equal(res.statusCode, 403);
    assert.equal(openAiCalls, 0);
  });

  test(`${name}: the check runs before the request body is even read`, async () => {
    mod._test.deps.verify = async () => SIGNED_OUT;
    const res = await mod.handler({ ...event, body: '{not json' });
    assert.equal(res.statusCode, 401);
  });

  test(`${name}: active shop member -> works as before`, async () => {
    mod._test.deps.verify = async () => MEMBER;
    openAiCalls = 0;
    const res = await mod.handler(event);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.ok(openAiCalls >= 1);
  });
}

// ---- verifyShopMember with a fake Supabase client -----------------------------

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's' };

function fakeClient({ users = {}, tables = {} }) {
  return () => ({
    auth: { getUser: async (token) => (users[token] ? { data: { user: { id: users[token] } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from(name) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(c, v) { filters[c] = v; return q; },
        async maybeSingle() { return { data: (tables[name] || []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) || null }; },
        then(res) { return Promise.resolve({ data: (tables[name] || []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) }).then(res); },
      };
      return q;
    },
  });
}

const TABLES = {
  profiles: [
    { id: 'u1', active: true, active_shop_id: 'B' },
    { id: 'u2', active: true, active_shop_id: null },
    { id: 'gone', active: false, active_shop_id: 'A' },
    { id: 'u3', active: true, active_shop_id: 'Z' },
  ],
  shop_memberships: [
    { profile_id: 'u1', shop_id: 'A', is_active: true, default_location_id: null, created_at: '2026-01-01' },
    { profile_id: 'u1', shop_id: 'B', is_active: true, default_location_id: null, created_at: '2026-02-01' },
    { profile_id: 'u2', shop_id: 'C', is_active: true, default_location_id: null, created_at: '2026-01-01' },
    { profile_id: 'u2', shop_id: 'D', is_active: true, default_location_id: 'loc', created_at: '2026-03-01' },
    { profile_id: 'gone', shop_id: 'A', is_active: true, default_location_id: null, created_at: '2026-01-01' },
    { profile_id: 'u3', shop_id: 'Z', is_active: false, default_location_id: null, created_at: '2026-01-01' },
  ],
};
const USERS = { t1: 'u1', t2: 'u2', tgone: 'gone', t3: 'u3', tnobody: 'nobody' };
const ev = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const verify = (token) => verifyShopMember(ev(token), { env: ENV, createClient: fakeClient({ users: USERS, tables: TABLES }) });

test('verify: no token / bad token -> signed out', async () => {
  assert.equal((await verify(null)).statusCode, 401);
  assert.equal((await verify('forged')).statusCode, 401);
});

test('verify: uses the chosen active shop when still a member of it', async () => {
  assert.deepEqual(await verify('t1'), { ok: true, userId: 'u1', shopId: 'B' });
});

test('verify: no chosen shop -> membership with a default location, else oldest', async () => {
  assert.deepEqual(await verify('t2'), { ok: true, userId: 'u2', shopId: 'D' });
});

test('verify: deactivated profile, removed membership, or no profile -> refused', async () => {
  assert.equal((await verify('tgone')).statusCode, 403);
  assert.equal((await verify('t3')).statusCode, 403);
  assert.equal((await verify('tnobody')).statusCode, 403);
});

test('verify: missing server settings fail closed', async () => {
  const r = await verifyShopMember(ev('t1'), { env: {}, createClient: fakeClient({ users: USERS, tables: TABLES }) });
  assert.equal(r.statusCode, 500);
});

test('bearerToken reads either header spelling', () => {
  assert.equal(bearerToken({ headers: { Authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerToken({ headers: { authorization: 'bearer  xyz ' } }), 'xyz');
  assert.equal(bearerToken({}), '');
});
