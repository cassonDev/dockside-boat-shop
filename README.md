# Dockside Boat Shop — AI extraction and Netlify setup

This project includes a Netlify Function that performs AI-based extraction of structured intake and work-log data using the OpenAI Responses API. The repository stores AI results and lightweight usage metrics with each job/entry so you can monitor cost and performance over time.

## Required environment variables
- OPENAI_API_KEY (required) — OpenAI API key (keep secret; set in Netlify site settings or use a local .env for `netlify dev`).
- OPENAI_MODEL (optional) — OpenAI model to use (default: `gpt-5.5`).
- OPENAI_PRICE_PER_1K (optional) — USD price per 1,000 tokens to compute estimated cost. If omitted, estimatedCost will be 0.

## Local setup
1. Install dependencies (if any) and the Netlify CLI:
   ```bash
   npm install
   npm install -g netlify-cli
   ```
2. Create a `.env` file for local development (Netlify CLI will load it):
   ```env
   OPENAI_API_KEY=sk_...
   OPENAI_MODEL=gpt-5.5
   OPENAI_PRICE_PER_1K=0.0047
   ```
3. Start local dev server and functions emulator:
   ```bash
   netlify dev
   ```
4. The AI function will be available at `http://localhost:8888/.netlify/functions/ai-extract`.

## Netlify deployment
- Set the environment variables in Netlify site settings (Site → Site settings → Build & deploy → Environment). Do NOT commit secrets to the repository.
- The repo contains `netlify.toml` which pins functions runtime preferences (Node 20). Netlify will build and deploy the function automatically on push to `main`.

## AI architecture & function flow
- Single Netlify server function: `/.netlify/functions/ai-extract`.
- Both client flows (New Job Intake and Log Work) call the same function — no duplicated AI logic.
- Function behavior:
  - Accepts POST JSON: `{ rawText, schemaFields, schemaHint }`.
  - Calls OpenAI Responses API (model from `OPENAI_MODEL`, default `gpt-5.5`).
  - Enforces structured JSON output with these exact properties:
    - `customerConcern`, `customerSummary`, `privateShopNotes`, `workPerformed`, `priority`, `jobSize`, `estimatedLaborHours`, `suggestedParts`, `followUpQuestions`, `confidenceScore`, `originalTranscript`.
  - Retries once automatically if the model output is invalid/malformed.
  - On success returns `{ ok: true, fields: { ... }, raw: "<model text>" }`.
  - On repeated parse failure returns `{ ok: false, error: "AI could not extract structured data." }`.

## Data flow
- Client POSTs transcript to Netlify function.
- Netlify function calls OpenAI Responses API and attempts to parse a JSON object from the model output.
- Parsed structured fields are normalized server-side (nulls/empty arrays where appropriate) and returned to the client.
- Client populates UI fields and saves the AI payload with the job (`job.ai`) or the log entry (`entry.ai`).
- Each saved `ai.meta` contains:
  ```json
  {
    "timestamp": "...",
    "model": "...",
    "processingTimeMs": 823,
    "promptTokens": 412,
    "completionTokens": 181,
    "totalTokens": 593,
    "estimatedCost": 0.0028
  }
  ```

## How to change models
- Set `OPENAI_MODEL` in your Netlify environment to change models without editing code. Default is `gpt-5.5`.

## How to rotate API keys
1. Create/obtain the new OpenAI key.
2. Update the `OPENAI_API_KEY` value in Netlify environment variables (Site → Site settings → Build & deploy → Environment).
3. Trigger a redeploy or wait for Netlify to pick up environment changes.

## Common deployment errors
- "fetch is not defined": Ensure functions run on Node 18+ / Node 20. This repo's `netlify.toml` sets `node_version = "20"` to prefer Node 20.
- 500 from the function: check Netlify function logs (Deploys → Functions) — missing/invalid OPENAI_API_KEY or API errors will appear in logs.
- Malformed AI output: the server retries once; if the function returns `{ ok: false }` check function logs for parsing diagnostics.

## Notes & recommendations
- Keep `OPENAI_API_KEY` secret; do not leak it to the browser.
- Consider setting `OPENAI_PRICE_PER_1K` to compute estimated costs per call. Prices change over time; store the price you used to compute historical reports.
- Add monitoring and alerting for function error rates and token usage to catch outsized bills early.
