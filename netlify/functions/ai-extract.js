// Secure Netlify function: AI extraction using OpenAI Chat Completions
// Expects POST JSON: { rawText: string, schemaFields: string[], schemaHint?: string }
// Returns: { ok: true, fields: { ...extractedFields }, raw: <model output> }

const OPENAI_KEY = process.env.OPENAI_API_KEY;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  if (!OPENAI_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing OPENAI_API_KEY environment variable.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { rawText, schemaFields, schemaHint } = body;
  if (!rawText || !Array.isArray(schemaFields)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rawText (string) and schemaFields (string[]) are required.' }) };
  }

  const system = `You extract structured shop-intake data from a mechanic's spoken or typed notes. Return ONLY a single JSON object with exactly these keys: ${schemaFields.join(', ')}. ${schemaHint || ''} Respond with no surrounding explanation or text, only the JSON object.`;

  try {
    const payload = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: rawText },
      ],
      max_tokens: 800,
      temperature: 0.0,
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errText = await r.text();
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'OpenAI API error', detail: errText }) };
    }

    const json = await r.json();
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'No content returned from OpenAI.' }) };

    // Try to extract a JSON object from the model output.
    const match = content.match(/\{[\s\S]*\}/);
    const jsonText = match ? match[0] : content;
    let fields = {};
    try {
      fields = JSON.parse(jsonText);
    } catch (e) {
      // If parsing fails, return the raw output for debugging.
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Failed to parse JSON from model output.', raw: content }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, fields, raw: content }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e && e.message ? e.message : String(e) }) };
  }
};
