// Automated tests for the owner-as-mechanic capability model.
// Runner: node --test  (Node's built-in test runner — no dependencies).
//   npm test        (see package.json)
//
// Covers every case the enhancement requires:
//   * owner only
//   * mechanic only
//   * owner AND mechanic
//   * enabling and disabling mechanic status
//   * assigning the owner to mechanic work (assignable-list inclusion)
//   * permissions for combined roles
// plus backward-compatibility guarantees for pre-existing rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOwner,
  isMechanicCapable,
  isAssignableMechanic,
  canAccessMechanicScreens,
  canToggleOwnerMechanic,
  roleDisplayLabel,
  ROLE_OWNER,
  ROLE_MECHANIC,
} from '../roles.js';

// ---- owner only (has NOT opted into mechanic work) ------------------------
test('owner only: is owner, not mechanic-capable, not assignable', () => {
  const m = { role: ROLE_OWNER, actsAsMechanic: false, isActive: true };
  assert.equal(isOwner(m.role), true);
  assert.equal(isMechanicCapable(m.role, m.actsAsMechanic), false);
  assert.equal(isAssignableMechanic(m), false);
  // Owner keeps full access regardless.
  assert.equal(canAccessMechanicScreens(m.role, m.actsAsMechanic), true);
  assert.equal(roleDisplayLabel(m.role, m.actsAsMechanic), 'Shop Owner');
});

// ---- mechanic only --------------------------------------------------------
test('mechanic only: mechanic-capable and assignable; not owner', () => {
  const m = { role: ROLE_MECHANIC, actsAsMechanic: false, isActive: true };
  assert.equal(isOwner(m.role), false);
  assert.equal(isMechanicCapable(m.role, m.actsAsMechanic), true);
  assert.equal(isAssignableMechanic(m), true);
  assert.equal(canAccessMechanicScreens(m.role, m.actsAsMechanic), true);
  assert.equal(roleDisplayLabel(m.role, m.actsAsMechanic), 'Mechanic');
});

test('mechanic flag is irrelevant to a mechanic (already assignable either way)', () => {
  assert.equal(isAssignableMechanic({ role: ROLE_MECHANIC, actsAsMechanic: true, isActive: true }), true);
  assert.equal(isAssignableMechanic({ role: ROLE_MECHANIC, actsAsMechanic: false, isActive: true }), true);
});

// ---- owner AND mechanic ---------------------------------------------------
test('owner + mechanic: still owner, now mechanic-capable and assignable', () => {
  const m = { role: ROLE_OWNER, actsAsMechanic: true, isActive: true };
  assert.equal(isOwner(m.role), true, 'role is NOT downgraded');
  assert.equal(isMechanicCapable(m.role, m.actsAsMechanic), true);
  assert.equal(isAssignableMechanic(m), true);
  assert.equal(canAccessMechanicScreens(m.role, m.actsAsMechanic), true);
  assert.equal(roleDisplayLabel(m.role, m.actsAsMechanic), 'Owner \u00b7 Mechanic');
});

// ---- enabling and disabling mechanic status -------------------------------
test('enable then disable: assignability flips, role stays shop_owner', () => {
  let m = { role: ROLE_OWNER, actsAsMechanic: false, isActive: true };
  assert.equal(isAssignableMechanic(m), false);

  m = { ...m, actsAsMechanic: true };            // enable
  assert.equal(isAssignableMechanic(m), true);
  assert.equal(m.role, ROLE_OWNER);

  m = { ...m, actsAsMechanic: false };           // disable
  assert.equal(isAssignableMechanic(m), false);
  assert.equal(m.role, ROLE_OWNER, 'disabling mechanic status must not touch the role');
});

// ---- assigning the owner to mechanic work (list inclusion) ----------------
test('assignable list: opted-in owner appears beside mechanics; opted-out does not', () => {
  const members = [
    { profileId: 'o1', role: ROLE_OWNER, actsAsMechanic: true, isActive: true },   // owner-mechanic
    { profileId: 'o2', role: ROLE_OWNER, actsAsMechanic: false, isActive: true },  // owner only
    { profileId: 'm1', role: ROLE_MECHANIC, actsAsMechanic: false, isActive: true },
    { profileId: 'm2', role: ROLE_MECHANIC, actsAsMechanic: false, isActive: false }, // inactive mechanic
  ];
  const assignable = members.filter(isAssignableMechanic).map(x => x.profileId);
  assert.deepEqual(assignable.sort(), ['m1', 'o1']);
});

test('inactive owner-mechanic is not assignable', () => {
  assert.equal(isAssignableMechanic({ role: ROLE_OWNER, actsAsMechanic: true, isActive: false }), false);
});

// ---- permissions for combined roles ---------------------------------------
test('permissions: only an owner may toggle another owner’s mechanic capability', () => {
  assert.equal(canToggleOwnerMechanic(ROLE_OWNER, ROLE_OWNER), true);
  assert.equal(canToggleOwnerMechanic(ROLE_OWNER, ROLE_MECHANIC), false, 'a mechanic membership has nothing to toggle');
  assert.equal(canToggleOwnerMechanic(ROLE_MECHANIC, ROLE_OWNER), false, 'a mechanic may not toggle anyone');
  assert.equal(canToggleOwnerMechanic(ROLE_MECHANIC, ROLE_MECHANIC), false);
});

test('permissions: an owner-mechanic keeps owner/admin access AND mechanic access', () => {
  // Owner-only screens are gated on isOwner; mechanic screens on capability.
  const ownerMech = { role: ROLE_OWNER, actsAsMechanic: true };
  assert.equal(isOwner(ownerMech.role), true);                                   // still reaches owner/admin screens
  assert.equal(canAccessMechanicScreens(ownerMech.role, ownerMech.actsAsMechanic), true); // AND mechanic screens
});

// ---- backward compatibility ----------------------------------------------
test('backward compat: missing/undefined flag behaves exactly like false', () => {
  assert.equal(isMechanicCapable(ROLE_OWNER, undefined), false);
  assert.equal(isAssignableMechanic({ role: ROLE_OWNER }), false);              // no flag => owner only
  assert.equal(isAssignableMechanic({ role: ROLE_MECHANIC }), true);            // pre-existing mechanic unaffected
  assert.equal(roleDisplayLabel(ROLE_OWNER, undefined), 'Shop Owner');
});
