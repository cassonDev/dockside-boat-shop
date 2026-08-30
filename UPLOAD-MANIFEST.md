# Staging upload — Section 27 (revision 130)

Repo: cassonDev/dockside-boat-shop, branch main. Paths below are repo-root relative and mirror this
folder exactly.

## Modified — merge, do not blind-overwrite
index.html            19 hunks, +1002 / -3   (3 existing lines deleted)
supabase-client.js     5 hunks, +46 / -2     (2 existing lines deleted)
package.json           1 hunk,  +1 / -1      (test command only)

If staging has moved ahead of the integration baseline, apply
deliverables/step8-integration/section-27-integration.patch instead and reconcile any rejected hunk.
The pre-integration baselines of the two large files are in that same folder.

## New
document-capture.js
document-page-pipeline.js
document-transcription-scheduler.js
document-review-draft.js
document-display.js
netlify/functions/transcribe-document.js
tests/transcribe-document.test.mjs
tests/document-capture.test.mjs
tests/document-page-pipeline.test.mjs
tests/document-transcription-scheduler.test.mjs
tests/document-review-draft.test.mjs
tests/document-display.test.mjs

## Not in this zip, on purpose
deliverables/**            authored source of record, not application code
deliverables/step7-a2/**   A2 SQL — already installed in staging, not to be re-run
*.baseline, *.patch        review artefacts

## Before deploy
Set in the staging Netlify environment (names only, no values here):
  OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Optional: OPENAI_DOCUMENT_MODEL, OPENAI_DOCUMENT_STRONG_MODEL,
  DOCUMENT_TRANSCRIPTION_FUNCTION_TIMEOUT_SECONDS,
  DOCUMENT_TRANSCRIPTION_MAX_IMAGE_BASE64_BYTES,
  DOCUMENT_TRANSCRIPTION_STALE_SECONDS

The feature ships OFF. Nothing here enables it for any shop.
