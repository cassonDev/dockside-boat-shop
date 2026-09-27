// Which shop the app opens on sign-in (index.html, loadForSession).
// Run:  node --test tests/active-shop-pick.test.mjs
//
// Runs the two real lines from index.html, so the test follows the code.
// Case that matters: a mechanic turned off at shop A who now works at shop B
// still has "A" remembered on their profile — the app must open B.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const activeMemLine = html.match(/^\s*const activeMem = .*$/m);
const effectiveLine = html.match(/^\s*const effectiveShopId = .*$/m);

test('index.html still has exactly one of each line under test', () => {
  assert.ok(activeMemLine && effectiveLine);
  assert.equal(html.split('const activeMem = ').length, 2);
  assert.equal(html.split('const effectiveShopId = ').length, 2);
});

// eslint-disable-next-line no-new-func
const pickShop = new Function('profile', 'memberships',
  `${activeMemLine[0]}\n${effectiveLine[0]}\nreturn { activeMem, effectiveShopId };`);

const memberOf = (shopId, role = 'mechanic') => ({ shopId, role, isActive: true });

test('remembered shop is still active -> opens it', () => {
  const { effectiveShopId, activeMem } = pickShop({ activeShopId: 'A' }, [memberOf('A')]);
  assert.equal(effectiveShopId, 'A');
  assert.equal(activeMem.shopId, 'A');
});

test('moved from A to B (A still remembered) -> opens B, with B’s role', () => {
  const { effectiveShopId, activeMem } = pickShop({ activeShopId: 'A' }, [memberOf('B', 'mechanic')]);
  assert.equal(effectiveShopId, 'B');
  assert.equal(activeMem.shopId, 'B');
  assert.equal(activeMem.role, 'mechanic');
});

test('nothing remembered (new invite) -> opens the shop they are in', () => {
  assert.equal(pickShop({ activeShopId: null }, [memberOf('B')]).effectiveShopId, 'B');
});

test('no active shop at all -> no shop', () => {
  assert.equal(pickShop({ activeShopId: 'A' }, []).effectiveShopId, null);
});
