// Role & mechanic-capability predicates — the SINGLE source of truth shared by
// the browser client (supabase-client.js) and the automated tests. Pure
// functions only: no DOM, no network, no Supabase. Mirror of the SQL rules in
// section-26-owner-as-mechanic.sql (get_assignable_mechanics / RLS), so the
// frontend and the database agree on who is a mechanic.
//
// Two-role model:  role in ('shop_owner','mechanic').
// A shop owner may ALSO act as a mechanic via the acts_as_mechanic flag on
// their shop_memberships row — this NEVER changes their role.

export const ROLE_OWNER = 'shop_owner';
export const ROLE_MECHANIC = 'mechanic';

export function isOwner(role) {
  return role === ROLE_OWNER;
}

// Is this identity able to do mechanic work? A plain mechanic always is; an
// owner is only when they've opted in (acts_as_mechanic).
export function isMechanicCapable(role, actsAsMechanic) {
  return role === ROLE_MECHANIC || (role === ROLE_OWNER && actsAsMechanic === true);
}

// Can this membership be assigned to a work order / appear in a mechanic
// picker or filter? Inactive members are never assignable. Accepts an app-shape
// membership/mechanic object ({ role, actsAsMechanic, isActive }); isActive
// defaults to true when absent (assignable lists are pre-filtered to active).
export function isAssignableMechanic(m) {
  if (!m) return false;
  if (m.isActive === false || m.active === false) return false;
  return isMechanicCapable(m.role, m.actsAsMechanic);
}

// Owners keep ALL owner/admin access regardless of the flag; a mechanic-capable
// identity additionally reaches the mechanic-specific screens/actions.
export function canAccessMechanicScreens(role, actsAsMechanic) {
  return isOwner(role) || isMechanicCapable(role, actsAsMechanic);
}

// Only a shop owner may toggle another OWNER membership's mechanic capability.
// (A mechanic membership is already assignable; there is nothing to toggle.)
export function canToggleOwnerMechanic(viewerRole, targetRole) {
  return viewerRole === ROLE_OWNER && targetRole === ROLE_OWNER;
}

// Display label reflecting the combined capability without implying a role change.
export function roleDisplayLabel(role, actsAsMechanic) {
  if (role === ROLE_OWNER) return actsAsMechanic === true ? 'Owner \u00b7 Mechanic' : 'Shop Owner';
  if (role === ROLE_MECHANIC) return 'Mechanic';
  return role || '';
}
