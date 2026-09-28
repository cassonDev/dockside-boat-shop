// Editing a timeline entry (index.html): the edit form's starting values, what
// gets saved, and the "What changed" list.
// Run:  node --test tests/timeline-edit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Pull the real field lists and methods out of index.html and run them.
const staticList = (name) => {
  const src = html.match(new RegExp(`static ${name} = (\\[[\\s\\S]*?\\n  \\]);`));
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src[1]};`)();
};
const method = (name, params) => {
  const src = html.match(new RegExp(`\\n  ${name}\\(${params.join(', ')}\\) \\{\\n([\\s\\S]*?)\\n  \\}\\n`));
  // eslint-disable-next-line no-new-func
  return new Function(...params, src[1]);
};

const app = { constructor: { WORK_LOG_EDIT_FIELDS: staticList('WORK_LOG_EDIT_FIELDS'), NOTE_EDIT_FIELDS: staticList('NOTE_EDIT_FIELDS') } };
app.editFieldsFor = method('editFieldsFor', ['activity']).bind(app);
app.editDraftFor = method('editDraftFor', ['activity']).bind(app);
app.editPatchFor = method('editPatchFor', ['activity', 'draft']).bind(app);
app.activityChanges = method('activityChanges', ['activity', 'before', 'after']).bind(app);

const workLog = () => ({
  activityType: 'work_log',
  body: 'The shift cable was adjusted, but it went too far.',
  meta: {
    findings: 'Shift is hard to engage.',
    partsUsed: '',
    laborTime: '1.0 hr',
    recommendations: 'Further inspection of the throttle cable.',
    rawNotes: 'Shift cable not throttle cable.',
    estimatedCost: '',
    somethingElse: 'kept as is',
  },
});

test('a work log opens with every box filled from the entry', () => {
  assert.deepEqual(app.editDraftFor(workLog()), {
    body: 'The shift cable was adjusted, but it went too far.',
    rawNotes: 'Shift cable not throttle cable.',
    findings: 'Shift is hard to engage.',
    partsUsed: '',
    laborTime: '1.0 hr',
    recommendations: 'Further inspection of the throttle cable.',
    estimatedCost: '',
  });
});

test('the form shows the two chosen tags only, on the right boxes', () => {
  const tags = app.editFieldsFor(workLog()).filter(f => f.tag).map(f => [f.key, f.tag]);
  assert.deepEqual(tags, [['body', 'CUSTOMER SEES THIS'], ['rawNotes', 'STAFF ONLY']]);
});

test('saving without changes saves nothing (spaces at the ends do not count)', () => {
  const entry = workLog();
  const draft = app.editDraftFor(entry);
  assert.equal(app.editPatchFor(entry, draft), null);
  assert.equal(app.editPatchFor(entry, { ...draft, laborTime: ' 1.0 hr  ' }), null);
});

test('fixing one detail saves it and keeps everything else in the entry', () => {
  const entry = workLog();
  const draft = { ...app.editDraftFor(entry), recommendations: '  Further inspection of the shift cable. ' };
  const patch = app.editPatchFor(entry, draft);
  assert.equal(patch.body, entry.body);
  assert.deepEqual(patch.meta, { ...entry.meta, recommendations: 'Further inspection of the shift cable.' });
  assert.equal(patch.meta.somethingElse, 'kept as is');
  assert.equal(entry.meta.recommendations, 'Further inspection of the throttle cable.', 'the entry itself is not changed');
});

test('a work log can have its customer update cleared', () => {
  const entry = workLog();
  const patch = app.editPatchFor(entry, { ...app.editDraftFor(entry), body: '   ' });
  assert.equal(patch.body, '');
});

test('a work log with no meta yet still edits cleanly', () => {
  const entry = { activityType: 'work_log', body: 'Hello', meta: null };
  assert.deepEqual(app.editPatchFor(entry, { ...app.editDraftFor(entry), laborTime: '2 hrs' }), { body: 'Hello', meta: { laborTime: '2 hrs' } });
});

test('a customer note edits only its text', () => {
  const note = { activityType: 'customer_note', body: 'Boat is ready.', meta: {} };
  assert.deepEqual(app.editDraftFor(note), { body: 'Boat is ready.' });
  assert.deepEqual(app.editPatchFor(note, { body: 'Boat is ready for pickup.' }), { body: 'Boat is ready for pickup.' });
});

test('"What changed" lists only the boxes that changed, with was and now', () => {
  const entry = workLog();
  const before = { body: entry.body, meta: entry.meta };
  const after = { body: entry.body, meta: { ...entry.meta, recommendations: 'Further inspection of the shift cable.', estimatedCost: '$40' } };
  assert.deepEqual(app.activityChanges(entry, before, after), [
    { label: 'RECOMMENDATIONS', was: 'Further inspection of the throttle cable.', now: 'Further inspection of the shift cable.' },
    { label: 'ESTIMATED COST', was: '(empty)', now: '$40' },
  ]);
});

test('the edit form has no reason box and never shows the raw database error', () => {
  assert.doesNotMatch(html, /Reason for edit/);
  assert.doesNotMatch(html, /editError: \(e && e\.message\)/);
  assert.match(html, /Couldn’t save your changes\. Your text is still here/);
});

test('an edited entry shows EDITED instead of the AI badge', () => {
  assert.match(html, /showAiBadge: a\.aiGenerated && !isEdited/);
  assert.match(html, /<sc-if value="\{\{ act\.showAiBadge \}\}"[^>]*>\s*<div[^>]*>&#10024; AI-GENERATED<\/div>/);
  assert.match(html, /&#9998; EDITED/);
});
