// Netlify server function: AI extraction using OpenAI Responses API
// Expects POST JSON: { rawText: string, schemaFields: string[], schemaHint?: string }
// Returns: { ok: true, fields: { ...structured fields, meta? }, raw: <model output> } or { ok: false, error: <message> }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
// Optional price-per-1k-tokens override (USD). If unset, estimatedCost will be 0.0.
const OPENAI_PRICE_PER_1K = process.env.OPENAI_PRICE_PER_1K ? Number(process.env.OPENAI_PRICE_PER_1K) : null;

// Required keys — server will guarantee these are present in the returned fields
const REQUIRED_KEYS = [
  'customerConcern','customerSummary','privateShopNotes','workPerformed','priority','jobSize','estimatedLaborHours','suggestedParts','followUpQuestions','confidenceScore','originalTranscript'
];

function emptyStructured() {
  return {
    customerConcern: null,
    customerSummary: null,
    privateShopNotes: null,
    workPerformed: null,
    priority: null,
    jobSize: null,
    estimatedLaborHours: null,
    suggestedParts: [],
    followUpQuestions: [],
    confidenceScore: 0,
    originalTranscript: null,
  };
}

async function callOpenAI(model, inputPayload) {
  const url = 'https://api.openai.com/v1/responses';
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(inputPayload),
  });
  const processingTimeMs = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* leave json null */ }
  return { ok: res.ok, status: res.status, text, json, processingTimeMs };
}

function extractTextFromResponseJson(json) {
  if (!json) return null;
  // Responses API: output is array; each output item has 'content' array with objects like { type: 'output_text', text: '...' }
  try {
    if (Array.isArray(json.output) && json.output.length) {
      const parts = [];
      for (const out of json.output) {
        if (!out || !Array.isArray(out.content)) continue;
        for (const c of out.content) {
          if (!c) continue;
          if (typeof c.text === 'string') parts.push(c.text);
          else if (c.type === 'output_text' && typeof c.content === 'string') parts.push(c.content);
          else if (typeof c === 'string') parts.push(c);
        }
      }
      if (parts.length) return parts.join('\n\n');
    }
    // Fallback: some Responses API versions may include 'generation' or 'output_text'
    if (Array.isArray(json.output_text)) return json.output_text.join('\n');
    if (typeof json.output === 'string') return json.output;
    return null;
  } catch (e) {
    return null;
  }
}

function ensureStructured(parsed) {
  const out = emptyStructured();
  if (!parsed || typeof parsed !== 'object') return out;
  // Copy allowed fields with validation
  out.customerConcern = parsed.customerConcern ?? null;
  out.customerSummary = parsed.customerSummary ?? null;
  out.privateShopNotes = parsed.privateShopNotes ?? null;
  out.workPerformed = parsed.workPerformed ?? null;
  out.priority = parsed.priority ?? null;
  out.jobSize = parsed.jobSize ?? null;
  out.estimatedLaborHours = (parsed.estimatedLaborHours == null) ? null : Number(parsed.estimatedLaborHours);
  out.suggestedParts = Array.isArray(parsed.suggestedParts) ? parsed.suggestedParts : (parsed.suggestedParts == null ? [] : []);
  out.followUpQuestions = Array.isArray(parsed.followUpQuestions) ? parsed.followUpQuestions : (parsed.followUpQuestions == null ? [] : []);
  out.confidenceScore = Number.isFinite(Number(parsed.confidenceScore)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.confidenceScore)))) : 0;
  out.originalTranscript = parsed.originalTranscript ?? null;
  return out;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  if (!OPENAI_API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server is missing OPENAI_API_KEY environment variable.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { rawText, schemaFields, schemaHint } = body;
  if (!rawText || !Array.isArray(schemaFields)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rawText (string) and schemaFields (string[]) are required.' }) };
  }

  // Build a strict system prompt that forces JSON output with the required keys
  const systemPrompt = `You are a JSON extraction tool. Given a transcript, return ONLY a JSON object with these exact keys: ${REQUIRED_KEYS.join(', ')}. Use null for unknown scalar fields and empty arrays for unknown list fields. Do NOT invent values. The field 'originalTranscript' must contain the original transcript unchanged. The field 'confidenceScore' must be an integer 0-100 representing confidence. Always produce valid JSON and nothing else.`;
  const userPrompt = `${schemaHint || ''}\n\nTranscript:\n${rawText}`;

  const model = OPENAI_MODEL || 'gpt-5.5';

  const payload = {
    model,
    // Responses API accepts 'input' which can be a list of messages or a single string; we'll send messages-like array
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    // request structure that prefers compact text output
    max_output_tokens: 800,
    temperature: 0.0,
  };

  // Attempt call up to 2 times when parsing fails
  let attempt = 0;
  let lastRaw = null;
  let lastRespJson = null;
  let requestId = null;
  let processingTimeMs = 0;
  let usageMeta = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 };

  while (attempt < 2) {
    attempt++;
    try {
      const { ok, status, text, json, processingTimeMs: tms } = await callOpenAI(model, payload);
      processingTimeMs = tms;
      lastRaw = text;
      lastRespJson = json;
      if (json && json.id) requestId = json.id;

      if (!ok) {
        // log and return a generic error to client
        console.error('AI call failed', { model, status, requestId, textSnippet: (text||'').slice(0,300) });
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'OpenAI API error' }) };
      }

      // extract textual content
      const extractedText = extractTextFromResponseJson(json) || (typeof text === 'string' ? text : null);
      if (!extractedText) {
        // nothing to parse — retry once
        console.error('AI returned empty textual output', { model, requestId });
        continue;
      }

      // Attempt to parse JSON object from the textual output
      const match = extractedText.match(/\{[\s\S]*\}/);
      if (!match) {
        // no JSON found, retry once
        console.error('AI output contained no JSON object', { model, requestId, sample: extractedText.slice(0,300) });
        continue;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(match[0]);
      } catch (parseErr) {
        // parsing failed; retry once
        console.error('JSON parse error (attempt ' + attempt + ')', { model, requestId, parseError: (parseErr && parseErr.message), sample: match[0].slice(0,300) });
        continue;
      }

      // Collect usage metrics if present (Responses API may return usage info)
      try {
        if (json && json.usage) {
          usageMeta.promptTokens = Number(json.usage.prompt_tokens || 0);
          usageMeta.completionTokens = Number(json.usage.completion_tokens || 0);
          usageMeta.totalTokens = Number(json.usage.total_tokens || (usageMeta.promptTokens + usageMeta.completionTokens));
        }
        // estimated cost calculation: use OPENAI_PRICE_PER_1K if provided, otherwise 0
        const pricePer1k = (typeof OPENAI_PRICE_PER_1K === 'number' && !isNaN(OPENAI_PRICE_PER_1K)) ? OPENAI_PRICE_PER_1K : 0;
        usageMeta.estimatedCost = pricePer1k > 0 ? (usageMeta.totalTokens / 1000) * pricePer1k : 0;
      } catch (e) {
        // ignore
      }

      // Ensure structured object contains required keys
      const structured = ensureStructured(parsed);
      // Attach meta (match requested shape)
      structured.meta = {
        timestamp: new Date().toISOString(),
        model,
        processingTimeMs: processingTimeMs || 0,
        promptTokens: usageMeta.promptTokens || 0,
        completionTokens: usageMeta.completionTokens || 0,
        totalTokens: usageMeta.totalTokens || 0,
        estimatedCost: usageMeta.estimatedCost || 0,
        requestId: requestId || null,
      };

      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, fields: structured, raw: extractedText }) };

    } catch (e) {
      // network/other error — log server-side and retry once
      console.error('AI extraction error', { model, attempt, err: e && e.message });
      lastRaw = (e && e.stack) ? e.stack : String(e);
      continue;
    }
  }

  // If we reach here, both attempts failed to produce valid JSON.
  // Log diagnostics server-side (model, requestId, parsing error, raw AI response), but do NOT send these to the client.
  console.error('AI extraction failed after retries', { model: OPENAI_MODEL || OPENAI_MODEL, requestId, lastRespJson, lastRaw });

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'AI could not extract structured data.' }) };
};
