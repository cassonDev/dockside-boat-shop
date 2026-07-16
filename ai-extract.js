// Netlify Function: generic AI text-extraction used by both the New Job Intake
// and Log Work flows in Dockside. Mirrors the app's existing client-side
// contract exactly (POST { rawText, schemaFields, schemaHint }) so it's a
// drop-in replacement for the in-editor `window.claude.complete` prototype
// call — this is what makes AI extraction actually work once the app is
// deployed for real users (window.claude.complete only exists inside the
// design tool's preview, never in a deployed site).
//
// Returns: { ok: true, fields: { <schemaFields[0]>: string, ... } }
//       or { ok: false, error: string }
//
// Required Netlify environment variable:
//   OPENAI_API_KEY        your OpenAI API key (never exposed to the browser)
// Optional:
//   OPENAI_MODEL           defaults to 'gpt-4o-mini'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  if (!OPENAI_API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: 'Server is missing OPENAI_API_KEY environment variable.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'Invalid JSON body.' }) };
  }

  const { rawText, schemaFields, schemaHint } = body;
  if (!rawText || !Array.isArray(schemaFields) || schemaFields.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'rawText (string) and schemaFields (non-empty string[]) are required.' }) };
  }

  const system = `You extract structured shop-intake data from a mechanic's spoken or typed notes. Return ONLY a single JSON object with exactly these keys: ${schemaFields.join(', ')}. ${schemaHint || ''} If a field isn't mentioned, use an empty string. No commentary, no markdown fences, just the JSON object.`;

  async function callOnce() {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        max_tokens: 600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: rawText },
        ],
      }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* fall through */ }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || `OpenAI API error (${res.status})`;
      throw new Error(msg);
    }
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error('OpenAI returned no content.');
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenAI response contained no JSON object.');
    return JSON.parse(match[0]);
  }

  // Retry once on transient/parse failure, per the app's existing contract.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = await callOnce();
      const fields = {};
      for (const key of schemaFields) fields[key] = parsed[key] != null ? String(parsed[key]) : '';
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, fields }) };
    } catch (e) {
      lastErr = e;
    }
  }

  console.error('ai-extract failed after retries', lastErr && lastErr.message);
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'AI could not extract structured data.' }) };
};
