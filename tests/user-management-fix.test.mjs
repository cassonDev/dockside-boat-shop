// Part A user-management fixes (manage-users + review-role-change).
// Run:  node --test tests/user-management-fix.test.mjs
// No network: the Supabase client is a small in-memory fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
const manageUsers = require('../netlify/functions/manage-users.js');
const reviewRoleChange = require('../netlify/functions/review-role-change.js');
const { isValidEmail, findUserIdByEmail } = manageUsers._test;

// ---- a tiny fake of the Supabase admin client --------------------------------

// Postgres ILIKE semantics: % = any run, _ = any one char, backslash escapes.
function ilikeMatches(value, pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(String(value || ''));
}

function fakeAdmin({ tables = {}, tokens = {}, authUsers = [] } = {}) {
  const calls = { updates: [], inserts: [], invites: [], ilikePatterns: [], deletedUsers: [], bans: [] };
  function from(table) {
    const filters = [];
    let like = null;
    let updateRow = null;
    const rows = () => (tables[table] || []).filter((r) =>
      filters.every(([c, v]) => r[c] === v) && (!like || ilikeMatches(r[like[0]], like[1])));
    const q = {
      select() { return q; },
      eq(c, v) { filters.push([c, v]); return q; },
      ilike(c, p) { like = [c, p]; calls.ilikePatterns.push(p); return q; },
      limit(n) { return Promise.resolve({ data: rows().slice(0, n), error: null }); },
      single() {
        const r = rows();
        return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'expected one row' } });
      },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      insert(row) { calls.inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      upsert(row) { calls.inserts.push({ table, row, upsert: true }); return Promise.resolve({ error: null }); },
      update(row) { updateRow = row; return q; },
      then(resolve, reject) {
        if (updateRow) {
          calls.updates.push({ table, row: updateRow, filters: [...filters] });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  const client = {
    from,
    auth: {
      getUser: async (token) => (tokens[token]
        ? { data: { user: { id: tokens[token] } }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } }),
      admin: {
        listUsers: async () => ({ data: { users: authUsers }, error: null }),
        inviteUserByEmail: async (email) => { calls.invites.push(email); return { data: { user: { id: `new-${email}` } }, error: null }; },
        updateUserById: async (id, attrs) => { calls.bans.push({ id, attrs }); return { error: null }; },
        deleteUser: async (id) => { calls.deletedUsers.push(id); return { error: null }; },
      },
    },
  };
  return { client, calls };
}

// Shop A (owner "owner-a") and shop B (mechanic "mech-b"); "admin" is a platform admin.
function baseTables() {
  return {
    profiles: [
      { id: 'owner-a', email: 'owner@shopa.com', active: true, active_shop_id: 'A', full_name: 'Owner A' },
      { id: 'mech-b', email: 'axb@shopb.com', active: true, active_shop_id: 'B', full_name: 'Mech B' },
      { id: 'mixed', email: 'Pat.Lee@Example.com', active: true, active_shop_id: 'B', full_name: 'Pat' },
      { id: 'admin', email: 'admin@platform.com', active: true, active_shop_id: null, full_name: 'Admin' },
    ],
    shop_memberships: [
      { profile_id: 'owner-a', shop_id: 'A', role: 'shop_owner', is_active: true },
      { profile_id: 'mech-b', shop_id: 'B', role: 'mechanic', is_active: true },
      { profile_id: 'mixed', shop_id: 'B', role: 'mechanic', is_active: true },
    ],
    shop_locations: [{ id: 'loc-a', shop_id: 'A', is_active: true }],
    platform_admins: [{ profile_id: 'admin', is_active: true }],
  };
}

function useFake(mod, opts) {
  const fake = fakeAdmin(opts);
  let created = 0;
  mod._test.deps.createClient = () => { created += 1; return fake.client; };
  return { ...fake, createdCount: () => created };
}

const asOwnerA = (body) => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer tok-owner-a' },
  body: JSON.stringify(body),
});
const TOKENS = { 'tok-owner-a': 'owner-a' };
const parse = (res) => JSON.parse(res.body);

// ---- email checks ---------------------------------------------------------------

test('isValidEmail accepts normal addresses, including underscores and plus', () => {
  for (const ok of ['a@b.co', 'first.last@shop.com', 'a_b@x.com', 'me+casson@gmail.com']) {
    assert.equal(isValidEmail(ok), true, ok);
  }
});

test('isValidEmail rejects wildcards, spaces and non-addresses', () => {
  for (const bad of ['%', '%@%.%', '*@x.com', 'a\\b@x.com', 'a b@x.com', 'nobody', 'a@b', '', null]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
});

test('findUserIdByEmail: "_" is not a wildcard and only an exact match counts', async () => {
  const { client, calls } = fakeAdmin({ tables: baseTables() });
  // "a_b@shopb.com" would match "axb@shopb.com" with a raw ILIKE.
  assert.equal(await findUserIdByEmail(client, 'a_b@shopb.com'), null);
  assert.deepEqual(calls.ilikePatterns, ['a\\_b@shopb.com']);
});

test('findUserIdByEmail: exact match ignores letter case', async () => {
  const { client } = fakeAdmin({ tables: baseTables() });
  assert.equal(await findUserIdByEmail(client, 'pat.lee@example.com'), 'mixed');
});

test('findUserIdByEmail: falls back to an exact auth scan', async () => {
  const { client } = fakeAdmin({ tables: baseTables(), authUsers: [{ id: 'auth-only', email: 'Solo@x.com' }] });
  assert.equal(await findUserIdByEmail(client, 'solo@x.com'), 'auth-only');
});

// ---- invite_staff ----------------------------------------------------------------

test('invite_staff: a wildcard "email" is refused before any lookup', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: '%', role: 'mechanic', addExistingUser: true }));
  assert.equal(res.statusCode, 400);
  assert.equal(fake.calls.ilikePatterns.length, 0);
  assert.equal(fake.calls.inserts.filter((c) => c.table === 'shop_memberships').length, 0);
});

test('invite_staff: a look-alike email never adds the other shop’s mechanic', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: 'a_b@shopb.com', role: 'mechanic', addExistingUser: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).status, 'invited'); // treated as a brand-new person
  assert.deepEqual(fake.calls.invites, ['a_b@shopb.com']);
  const added = fake.calls.inserts.filter((c) => c.table === 'shop_memberships').map((c) => c.row.profile_id);
  assert.ok(!added.includes('mech-b'));
});

test('invite_staff: a platform admin login can never be added to a shop', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: 'admin@platform.com', role: 'shop_owner', addExistingUser: true }));
  assert.equal(res.statusCode, 403);
  assert.equal(fake.calls.inserts.filter((c) => c.table === 'shop_memberships').length, 0);
});

test('invite_staff: existing login still needs confirmation, then joins the OWNER’s shop', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const first = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: 'Pat.Lee@example.com', role: 'mechanic' }));
  assert.equal(first.statusCode, 409);
  assert.equal(parse(first).status, 'requires_confirmation');
  const second = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: 'pat.lee@example.com', role: 'mechanic', addExistingUser: true }));
  assert.equal(second.statusCode, 200);
  assert.equal(parse(second).status, 'added_existing_user');
  const mem = fake.calls.inserts.find((c) => c.table === 'shop_memberships');
  assert.deepEqual([mem.row.profile_id, mem.row.shop_id, mem.row.role], ['mixed', 'A', 'mechanic']);
});

test('invite_staff: a brand-new email is invited into the owner’s shop (unchanged)', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler(asOwnerA({ action: 'invite_staff', email: 'new.hire@shopa.com', role: 'mechanic' }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).status, 'invited');
  const mem = fake.calls.inserts.find((c) => c.table === 'shop_memberships');
  assert.equal(mem.row.shop_id, 'A');
  assert.equal(mem.row.default_location_id, 'loc-a');
});

// ---- retired actions -----------------------------------------------------------

for (const action of ['set_active', 'set_role', 'delete_user']) {
  test(`${action} is retired: refused, and nothing is changed`, async () => {
    const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
    const res = await manageUsers.handler(asOwnerA({ action, userId: 'mech-b', active: false, role: 'shop_owner' }));
    assert.equal(res.statusCode, 400);
    assert.match(parse(res).error, /Unknown action/);
    assert.equal(fake.calls.updates.length, 0);
    assert.equal(fake.calls.deletedUsers.length, 0);
    assert.equal(fake.calls.bans.length, 0);
  });
}

test('bootstrap_status always says "not needed" without touching the database', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'bootstrap_status' }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res), { needsBootstrap: false });
  assert.equal(fake.createdCount(), 0);
});

test('bootstrap_shop_owner is retired', async () => {
  const fake = useFake(manageUsers, { tables: baseTables(), tokens: TOKENS });
  const res = await manageUsers.handler({ httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'bootstrap_shop_owner', email: 'x@y.com', password: 'p', bootstrapCode: 'c' }) });
  assert.equal(res.statusCode, 410);
  assert.equal(fake.createdCount(), 0);
});

test('owner check still applies: a mechanic cannot invite', async () => {
  const tables = baseTables();
  tables.profiles.push({ id: 'mech-a', email: 'm@shopa.com', active: true, active_shop_id: 'A', full_name: 'Mech A' });
  tables.shop_memberships.push({ profile_id: 'mech-a', shop_id: 'A', role: 'mechanic', is_active: true });
  useFake(manageUsers, { tables, tokens: { 'tok-mech-a': 'mech-a' } });
  const res = await manageUsers.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok-mech-a' },
    body: JSON.stringify({ action: 'invite_staff', email: 'x@y.com', role: 'mechanic' }) });
  assert.equal(res.statusCode, 403);
});

// ---- review-role-change --------------------------------------------------------

function roleTables(targetProfileId) {
  const t = baseTables();
  t.role_change_requests = [{ id: 'req-1', shop_id: 'A', profile_id: targetProfileId, requested_role: 'shop_owner', role_before: 'mechanic', status: 'pending' }];
  return t;
}
const review = (decision) => ({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer tok-owner-a' },
  body: JSON.stringify({ requestId: 'req-1', decision }),
});

test('role change: approving a request that names someone from ANOTHER shop is refused', async () => {
  const fake = useFake(reviewRoleChange, { tables: roleTables('mech-b'), tokens: TOKENS });
  const res = await reviewRoleChange.handler(review('approve'));
  assert.equal(res.statusCode, 409);
  assert.equal(fake.calls.updates.length, 0);
});

test('role change: approving for a member of the request’s shop proceeds', async () => {
  const tables = roleTables('mech-a');
  tables.profiles.push({ id: 'mech-a', email: 'm@shopa.com', active: true, active_shop_id: 'A', full_name: 'Mech A' });
  tables.shop_memberships.push({ profile_id: 'mech-a', shop_id: 'A', role: 'mechanic', is_active: true });
  const fake = useFake(reviewRoleChange, { tables, tokens: TOKENS });
  const res = await reviewRoleChange.handler(review('approve'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fake.calls.updates.map((u) => u.table), ['shop_memberships', 'profiles', 'role_change_requests']);
});

test('role change: deny is unchanged', async () => {
  const fake = useFake(reviewRoleChange, { tables: roleTables('mech-b'), tokens: TOKENS });
  const res = await reviewRoleChange.handler(review('deny'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fake.calls.updates.map((u) => u.table), ['role_change_requests']);
});
