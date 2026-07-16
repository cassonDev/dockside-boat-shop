// Netlify Function: server-side AI/OCR extraction of a serial number from a
// photo of an equipment/serial plate. Separate from ai-extract.js because
// this one sends image bytes to a vision-capable model instead of plain
// text — same "never expose the AI key to the browser" contract.
//
// Request:  POST { imageDataUrl: "data:image/jpeg;base64,..." }
// Response: { ok: true, serialNumber, confidenceScore, alternateCandidates, needsReview }
//        or { ok: false, error }
//
// Required Netlify environment variable:
//   OPENAI_API_KEY        your OpenAI API key (never exposed to the browser)
// Optional:
//   OPENAI_VISION_MODEL   defaults to 'gpt-4o-mini' (must support image input)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `You read equipment serial-number plates from photos for a boat repair shop.
Read ONLY the serial number visible in the image. Preserve letters, numbers, dashes, slashes, spaces, and capitalization exactly as printed where meaningful.
Distinguish the serial number from: model number, part number, horsepower rating, manufacturing date, and certification/compliance numbers — those are NOT the serial number.
If the plate has a field explicitly labeled "SERIAL NO", "S/N", "SERIAL", or similar, prefer that value.
Never invent or guess missing or obscured characters. If no serial number can be read reliably, return an empty string for serialNumber.
Return ONLY a single JSON object with exactly these keys:
{"serialNumber": string, "confidenceScore": number (0 to 1), "alternateCandidates": string[], "needsReview": boolean}
needsReview should be true whenever confidenceScore is below 0.75 or any character was hard to distinguish (e.g. O/0, I/1/l, S/5, B/8).
No commentary, no markdown fences — just the JSON object.`;

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

  const { imageDataUrl } = body;
  if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'imageDataUrl (a data: URL) is required.' }) };
  }

  async function callOnce() {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read the serial number from this equipment plate photo.' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
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

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = await callOnce();
      const serialNumber = parsed.serialNumber != null ? String(parsed.serialNumber).trim() : '';
      const confidenceScore = typeof parsed.confidenceScore === 'number' ? Math.max(0, Math.min(1, parsed.confidenceScore)) : (serialNumber ? 0.5 : 0);
      const alternateCandidates = Array.isArray(parsed.alternateCandidates) ? parsed.alternateCandidates.map(String).filter(Boolean) : [];
      const needsReview = parsed.needsReview === true || confidenceScore < 0.75 || !serialNumber;
      return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({ ok: true, serialNumber, confidenceScore, alternateCandidates, needsReview }),
      };
    } catch (e) {
      lastErr = e;
    }
  }

  console.error('extract-serial-number failed after retries', lastErr && lastErr.message);
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'AI could not read the serial number. Please try again or enter it manually.' }) };
};
