// Generates config.js at Netlify BUILD TIME from environment variables, so no
// Supabase URL/key is ever committed to the repo or visible to secret
// scanners. Runs automatically via the [build] command in netlify.toml.
//
// Required Netlify environment variables (Site settings → Environment):
//   SUPABASE_URL         e.g. https://xxxxxxxx.supabase.co
//   SUPABASE_ANON_KEY    the "anon" / "publishable" key (Project Settings → API)
//     (this key is meant to be public/client-side — Row Level Security is
//      what actually protects your data — but Netlify's scanner still wants
//      it out of source, so it's injected at build time like everything else)

const fs = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn('[generate-config] WARNING: SUPABASE_URL / SUPABASE_ANON_KEY are not set. The deployed app will show a "not configured" message until you set them in Netlify environment variables and redeploy.');
}

const contents = `// AUTO-GENERATED at build time by scripts/generate-config.js — do not edit or commit.\nwindow.__SUPABASE_CONFIG__ = ${JSON.stringify({ url, anonKey })};\n`;

fs.writeFileSync(path.join(__dirname, '..', 'config.js'), contents);
console.log('[generate-config] Wrote config.js', { hasUrl: !!url, hasAnonKey: !!anonKey });
