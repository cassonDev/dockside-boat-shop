// Shared sign-in check for the AI Netlify Functions.
//
// Not a Function itself: Netlify only deploys top-level files (and folders with
// an index.js or a same-named file), so this folder is bundled into the
// Functions that require it.
//
// verifyShopMember(event) answers one question: is the caller a signed-in,
// ACTIVE user with an ACTIVE membership in a shop? It returns that user and the
// shop they are working in, so the caller can also be charged to the right shop.
//
//   -> { ok: true, userId, shopId }
//   -> { ok: false, statusCode, code, error }
//
// The shop is the user's chosen active shop when they are still an active
// member of it, otherwise their oldest active membership — the same rule the
// database uses (current_user_shop_id).
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SIGNED_OUT = { ok: false, statusCode: 401, code: 'UNAUTHENTICATED', error: 'You are signed out. Sign in again.' };
const NO_SHOP = { ok: false, statusCode: 403, code: 'NOT_AUTHORIZED', error: 'Your account is not active in a shop.' };

function bearerToken(event) {
  const headers = (event && event.headers) || {};
  const raw = headers.authorization || headers.Authorization || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function defaultCreateClient(url, key) {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function verifyShopMember(event, { env = process.env, createClient = defaultCreateClient } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[verify-shop-member] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return { ok: false, statusCode: 500, code: 'SERVER_CONFIG', error: 'AI is temporarily unavailable.' };
  }

  const token = bearerToken(event);
  if (!token) return SIGNED_OUT;

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  let userId = null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    userId = !error && data && data.user ? data.user.id : null;
  } catch (e) {
    userId = null;
  }
  if (!userId) return SIGNED_OUT;

  const { data: profile } = await admin.from('profiles')
    .select('id, active_shop_id').eq('id', userId).eq('active', true).maybeSingle();
  if (!profile) return NO_SHOP;

  if (profile.active_shop_id) {
    const { data: chosen } = await admin.from('shop_memberships')
      .select('shop_id').eq('profile_id', userId).eq('shop_id', profile.active_shop_id).eq('is_active', true).maybeSingle();
    if (chosen) return { ok: true, userId, shopId: chosen.shop_id };
  }

  const { data: memberships } = await admin.from('shop_memberships')
    .select('shop_id, default_location_id, created_at').eq('profile_id', userId).eq('is_active', true);
  const list = (memberships || []).slice().sort((a, b) => {
    const aLoc = a.default_location_id ? 0 : 1;
    const bLoc = b.default_location_id ? 0 : 1;
    if (aLoc !== bLoc) return aLoc - bLoc;
    return String(a.created_at).localeCompare(String(b.created_at));
  });
  if (!list.length) return NO_SHOP;
  return { ok: true, userId, shopId: list[0].shop_id };
}

module.exports = { verifyShopMember, bearerToken };
