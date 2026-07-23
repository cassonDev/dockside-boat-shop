// Netlify Function: structured AI text-extraction for the New Job Intake and
// Log Work flows in Dockside. Client contract (unchanged, drop-in):
//   POST { rawText, schemaFields, schemaHint }
//   -> { ok: true, fields: { <schemaFields[i]>: string, ... } }
//   -> { ok: false, error: string }
//
// What makes extraction reliable here (vs. the old free-text prompt):
//   1. OpenAI Structured Outputs (response_format: json_schema, strict) so the
//      model returns exactly the requested keys, all strings, nothing extra.
//   2. temperature 0 + a fixed seed -> deterministic for a given input.
//   3. Deterministic server-side post-processing that does NOT trust the model
//      for the two things models get wrong most often:
//        - phone: normalized to (NNN) NNN-NNNN, incl. spoken digits ("six oh
//          four ..."); blank if a full 10-digit number was not spoken.
//        - priority: derived from explicit spoken cues, mapped to the app's
//          valid values ('high' | 'normal'); blank when no priority was said.
//   4. Layered fallbacks (json_schema -> json_object -> regex) + one retry, so
//      malformed output, missing fields, or a transient API error degrade to a
//      clean { ok:false } instead of throwing.
//
// The model NEVER invents data: unmentioned fields come back "".
//
// Required env: OPENAI_API_KEY. Optional: OPENAI_MODEL (default gpt-4o-mini).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EXTRACT_SEED = 7; // fixed seed -> repeatable output for identical input

// ---------------------------------------------------------------------------
// Deterministic helpers (pure, unit-tested — see ai-extract.test.js)
// ---------------------------------------------------------------------------

const WORD_DIGITS = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
};

// Converts a spoken/typed phone string into (NNN) NNN-NNNN. Handles digit runs
// ("604 555 1234", "604-555-1234"), spoken digits ("six oh four, five five
// five, one two three four"), and a leading US/Canada country code (1). Returns
// '' when a complete 10-digit number is not present — never pads or invents.
function normalizePhone(raw) {
  if (raw == null) return '';
  let t = String(raw).toLowerCase();
  // Replace spoken number-words with their digit; other letters -> separators.
  t = t.replace(/[a-z]+/g, (w) => (WORD_DIGITS[w] != null ? WORD_DIGITS[w] : ' '));
  let digits = (t.match(/\d/g) || []).join('');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length !== 10) return '';
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Maps explicit spoken priority cues to a canonical tier: 'high' | 'normal' |
// 'low'. Returns '' when no priority was expressed (caller keeps its default).
// Derived from the transcript (not the model) so the same words always yield
// the same tier.
//
// ORDER MATTERS. De-prioritizing / non-urgent phrases are matched FIRST,
// because phrases like "not urgent" and "no rush" literally contain the
// urgency words "urgent"/"rush" and would otherwise be misread as High.
// Documented deterministic rule: when a de-prioritizing phrase AND an urgency
// word both appear (e.g. "not urgent, but please rush it"), the de-prioritizing
// phrase WINS -> Normal. This is intentional and stable.
function detectPriority(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // 1) Explicit low tier.
  if (/\b(low priority|lowest priority|low pri|back burner)\b/.test(t)) return 'low';
  // 2) Non-urgent / de-prioritizing language (kept as Normal, not Low).
  if (/\b(not urgent|no rush|no rush needed|no hurry|not a rush|when you get a chance|whenever)\b/.test(t)) return 'normal';
  // 3) Urgency.
  if (/\b(high priority|highest priority|top priority|urgent|urgently|emergency|asap|rush|rush job|expedite|expedited|critical|right away)\b/.test(t)) return 'high';
  // 4) Explicit normal/standard.
  if (/\b(normal priority|standard priority|regular priority|routine)\b/.test(t)) return 'normal';
  return '';
}

// Reduces text to a pure digit stream, converting spoken number-words to digits
// ("six oh four" -> "604"). Used to prove a model-supplied phone number was
// actually present in the transcript before we trust it.
function toDigitStream(text) {
  const t = String(text || '').toLowerCase().replace(/[a-z]+/g, (w) => (WORD_DIGITS[w] != null ? WORD_DIGITS[w] : ' '));
  return (t.match(/\d/g) || []).join('');
}

// Words that label a following number as a phone number.
const PHONE_LABELS = new Set(['phone', 'number', 'cell', 'mobile', 'tel', 'telephone', 'call', 'contact']);

// Extracts a phone number from free-form transcript text WITHOUT concatenating
// digits across the whole string (the staging bug). It tokenizes on whitespace/
// commas, classifies each token as a digit token (a spoken number-word, or a
// token made only of digits + phone punctuation), a label, or a boundary, then:
//   - groups CONSECUTIVE digit tokens into runs (a boundary like a word, or a
//     mixed alnum token such as "VR5", ends a run so year/model digits are never
//     borrowed);
//   - within each run finds every contiguous window whose joined digits form a
//     valid number (10 digits, or 11 with a leading country-code 1);
//   - prefers candidates immediately labelled by "phone"/"phone number", and
//     among the chosen pool returns the LAST one (so a corrected number spoken
//     after malformed attempts wins).
// Returns '' when no unambiguous valid 10-digit candidate exists.
function extractPhone(text) {
  if (text == null) return '';
  const tokens = String(text).toLowerCase().split(/[\s,]+/).filter(Boolean);
  const klass = tokens.map((tok) => {
    if (WORD_DIGITS[tok] != null) return { type: 'digit', digits: WORD_DIGITS[tok] };
    if (/^[\d().+\-]+$/.test(tok) && /\d/.test(tok)) return { type: 'digit', digits: tok.replace(/\D/g, '') };
    if (PHONE_LABELS.has(tok.replace(/[^a-z]/g, ''))) return { type: 'label' };
    return { type: 'boundary' };
  });
  const candidates = [];
  let i = 0;
  while (i < tokens.length) {
    if (klass[i].type !== 'digit') { i++; continue; }
    let j = i;
    const seg = [];
    while (j < tokens.length && klass[j].type === 'digit') { seg.push(klass[j].digits); j++; }
    const labeled = (i >= 1 && klass[i - 1].type === 'label') || (i >= 2 && klass[i - 2].type === 'label');
    for (let a = 0; a < seg.length; a++) {
      let acc = '';
      for (let b = a; b < seg.length; b++) {
        acc += seg[b];
        if (acc.length > 11) break;
        let d = acc;
        if (d.length === 11 && d[0] === '1') d = d.slice(1);
        if (d.length === 10) candidates.push({ value: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, labeled, pos: i + a });
      }
    }
    i = j;
  }
  if (!candidates.length) return '';
  const labeledC = candidates.filter((c) => c.labeled);
  const pool = labeledC.length ? labeledC : candidates;
  pool.sort((x, y) => x.pos - y.pos);
  return pool[pool.length - 1].value;
}

// Clamps a canonical priority tier to a value the app can actually store. The
// app has only 'normal' and 'high', so 'low' collapses to 'normal'. '' stays ''
// so the caller can preserve its existing default.
function toAppPriority(tier) {
  if (tier === 'high') return 'high';
  if (tier === 'normal' || tier === 'low') return 'normal';
  return '';
}

// Builds a strict JSON Schema from the requested field list. Every field is a
// string; 'priority' additionally constrains to the canonical enum. strict mode
// requires every property to be listed in `required`, so unmentioned fields
// come back as "" rather than being omitted.
function buildJsonSchema(schemaFields) {
  const properties = {};
  for (const key of schemaFields) {
    if (key === 'priority') {
      properties[key] = { type: 'string', enum: ['high', 'normal', 'low', ''] };
    } else {
      properties[key] = { type: 'string' };
    }
  }
  return {
    name: 'shop_intake',
    strict: true,
    schema: {
      type: 'object',
      properties,
      required: schemaFields.slice(),
      additionalProperties: false,
    },
  };
}

// Defensively turns raw model content into an object. Tries strict JSON first,
// then the first {...} block. Returns null when nothing parses.
function parseContent(content) {
  if (!content) return null;
  try { return JSON.parse(content); } catch (e) { /* not clean JSON */ }
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

// Coerces the parsed object to exactly schemaFields (strings only), then applies
// deterministic post-processing for phone/priority when those fields are present.
function sanitizeFields(parsed, schemaFields, rawText) {
  const fields = {};
  for (const key of schemaFields) {
    const v = parsed && parsed[key];
    fields[key] = v == null ? '' : String(v).trim();
  }
  if (schemaFields.includes('phone')) {
    // Extract the phone directly from the transcript using candidate scanning
    // (see extractPhone). This is inherently hallucination-proof — the model's
    // own phone value is never used — and never concatenates digits across the
    // whole transcript or borrows adjacent year/model digits.
    fields.phone = extractPhone(rawText);
  }
  if (schemaFields.includes('priority')) {
    // Priority comes EXCLUSIVELY from the transcript cue — the model's own
    // priority value is never trusted (it hallucinates urgency). No explicit
    // cue -> '' so the UI keeps its existing/default Normal selection.
    fields.priority = toAppPriority(detectPriority(rawText));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// OpenAI call
// ---------------------------------------------------------------------------

async function callModel({ rawText, schemaFields, schemaHint, useSchema }) {
  const system =
    `You extract structured shop-intake data from a mechanic's spoken or typed notes. ` +
    `Return ONLY a JSON object with exactly these keys: ${schemaFields.join(', ')}. ` +
    `${schemaHint || ''} ` +
    `Extract only what is explicitly stated. If a field was not mentioned, use an empty string "". ` +
    `Never guess, infer, or invent a value.`;

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    seed: EXTRACT_SEED,
    max_tokens: 700,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: rawText },
    ],
    response_format: useSchema
      ? { type: 'json_schema', json_schema: buildJsonSchema(schemaFields) }
      : { type: 'json_object' },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* fall through */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || `OpenAI API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const parsed = parseContent(content);
  if (!parsed) throw new Error('OpenAI response contained no parseable JSON object.');
  return parsed;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

  // Attempt order: strict json_schema, then json_object (covers models/configs
  // that reject json_schema), each tried once. Deterministic post-processing
  // runs on whichever attempt first yields a parseable object.
  const attempts = [{ useSchema: true }, { useSchema: false }];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const parsed = await callModel({ rawText, schemaFields, schemaHint, ...opts });
      const fields = sanitizeFields(parsed, schemaFields, rawText);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, fields }) };
    } catch (e) {
      lastErr = e;
      // Authentication/authorization failures are NOT retryable and NOT a
      // "schema unsupported" signal — retrying just burns another failed call.
      // Stop immediately with a clear, actionable message.
      if (e.status === 401 || e.status === 403) {
        console.error('ai-extract auth error:', e.message);
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'AI service authentication failed — check the OPENAI_API_KEY configuration.' }) };
      }
      // Otherwise fall through: a 400 usually means json_schema is unsupported
      // (retry as json_object); 429/5xx/network/parse errors get a second shot.
    }
  }

  console.error('ai-extract failed after retries:', lastErr && lastErr.message);
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'AI could not extract structured data. Please review and fill the form manually.' }) };
};

// Exposed for automated tests (no network). Not part of the HTTP contract.
exports._test = { normalizePhone, extractPhone, detectPriority, toAppPriority, toDigitStream, buildJsonSchema, parseContent, sanitizeFields };
