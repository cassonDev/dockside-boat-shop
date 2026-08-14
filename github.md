# GitHub source

repo: cassonDev/dockside-boat-shop
branch: main

## Last sync
date: 2026-08-08T23:07:27Z

### Updated in this project
- Added owner-as-mechanic: a shop owner can also be assignable as a mechanic without losing the owner role.
- New DB migration `section-26-owner-as-mechanic.sql` (+ `section-26-rollback.sql`): `shop_memberships.acts_as_mechanic` flag, `get_assignable_mechanics()` and `set_owner_mechanic_status()` RPCs, roster RPCs re-created to surface the flag.
- Shared predicate module `roles.js` + `tests/roles.test.mjs` (node --test).
- Frontend + data layer wired to the new RPCs (assignment pickers, filters, roster labels, owner profile toggle).

## Screen map
| Area | Repo files |
| --- | --- |
| Role/mechanic predicates (source of truth) | roles.js, tests/roles.test.mjs |
| DB schema + RPCs | section-26-owner-as-mechanic.sql, section-26-rollback.sql, section-20-tenant-foundation.sql, section-22-team-roster.sql, section-24-get-shop-roster-admin.sql |
| Data access layer | supabase-client.js |
| App UI (assignment, filters, roster, mechanic profile toggle) | index.html |
| Privileged server functions (unchanged; reviewed) | manage-users.js, update-staff-role.js, review-role-change.js |
