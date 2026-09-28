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

// ---- Creating an entry: "Back to my notes" must not lose fixes made by hand ----

const keepTouchedLogFields = method('keepTouchedLogFields', ['freshFields', 'currentFields', 'touchedKeys']);
const setLogField = method('setLogField', ['key', 'value']);

test('the review button that goes back is called "Back to my notes", not "Edit"', () => {
  assert.match(html, /onClick="\{\{ backToDictate \}\}">BACK TO MY NOTES<\/div>/);
  assert.doesNotMatch(html, /onClick="\{\{ backToDictate \}\}">EDIT<\/div>/);
});

test('typing in a review box remembers that box as changed by hand', () => {
  let state = { logFields: { customerUpdate: 'AI text', findings: '' }, logTouchedFields: [] };
  const fakeApp = { setState: (update) => { state = { ...state, ...update(state) }; } };
  setLogField.call(fakeApp, 'customerUpdate', 'My own words');
  setLogField.call(fakeApp, 'customerUpdate', 'My own words.');
  assert.deepEqual(state.logFields, { customerUpdate: 'My own words.', findings: '' });
  assert.deepEqual(state.logTouchedFields, ['customerUpdate']);
});

test('generating again keeps boxes changed by hand and refreshes the rest', () => {
  const fresh = { customerUpdate: 'New AI text', privateNotes: 'new dictation', findings: 'New finding', partsUsed: '', laborTime: '1 hr', recommendations: '', estimatedCost: '' };
  const current = { customerUpdate: 'My own words', privateNotes: 'old dictation', findings: 'Old finding', partsUsed: 'Impeller', laborTime: '', recommendations: '', estimatedCost: '' };
  assert.deepEqual(keepTouchedLogFields(fresh, current, ['customerUpdate', 'partsUsed']), {
    ...fresh, customerUpdate: 'My own words', partsUsed: 'Impeller',
  });
  assert.deepEqual(keepTouchedLogFields(fresh, current, []), fresh);
});

test('the AI result goes through keepTouchedLogFields', () => {
  assert.match(html, /logFields: this\.keepTouchedLogFields\(\{[\s\S]*?\}, s\.logFields, s\.logTouchedFields\)/);
});

test('starting a new entry or opening a job forgets earlier hand changes', () => {
  const clears = (name) => new RegExp(`${name} = [^\\n]*logTouchedFields: \\[\\]`);
  assert.match(html, clears('openLogWork'));
  assert.match(html, /const freshLogWork = isDifferentJob \? \{\n\s*logStep: 'dictate', logTouchedFields: \[\]/, 'opening a different job');
  assert.match(html, /discardLogReview = \(\) => \{\n[^\n]*logTouchedFields: \[\]/);
  assert.match(html, /estimatedCost: '' \},\n\s*logTouchedFields: \[\],\n\s*logAskingToDiscard: false,\n\s*logSaveBusy: false/, 'cleared after a successful save');
});

// ---- Notes typed for one job must never follow the mechanic to another job ----

const openJobSrc = html.match(/\n  openJob = \(id, opts\) => \{\n([\s\S]*?)\n  \};\n/);
// eslint-disable-next-line no-new-func
const openJob = new Function('id', 'opts', openJobSrc[1]);
const discardLogDictation = method('discardLogDictation', []);

const fakeAppOnJob = (jobId) => {
  const calls = { discarded: 0, setState: null };
  const fake = {
    state: { selectedJobId: jobId },
    setState: (update) => { calls.setState = update; },
    discardLogDictation: () => { calls.discarded += 1; },
    loadActivities: () => {}, loadJobPhotos: () => {}, loadSerialNumbers: () => {}, subscribeActivities: () => {},
  };
  return { fake, calls };
};

test('opening a different job empties the Log your work box and stops dictation', () => {
  const { fake, calls } = fakeAppOnJob('JOB-A');
  openJob.call(fake, 'JOB-B', { skipHistory: true });
  assert.equal(calls.discarded, 1);
  assert.equal(calls.setState.selectedJobId, 'JOB-B');
  assert.equal(calls.setState.logTyped, '');
  assert.equal(calls.setState.logTranscript, '');
  assert.equal(calls.setState.logRawNotesFinal, '');
  assert.equal(calls.setState.logFields.customerUpdate, '');
});

test('reopening the same job keeps everything as it was left', () => {
  const { fake, calls } = fakeAppOnJob('JOB-A');
  openJob.call(fake, 'JOB-A', { skipHistory: true });
  assert.equal(calls.discarded, 0);
  for (const key of ['logTyped', 'logTranscript', 'logStep', 'logFields', 'logTouchedFields', 'logFromAi', 'logSelectedPhotoIds', 'editingActivityId', 'editDraft']) {
    assert.equal(key in calls.setState, false, `${key} is kept`);
  }
});

test('opening a different job also drops a half-finished edit and the check screen', () => {
  const { fake, calls } = fakeAppOnJob('JOB-A');
  openJob.call(fake, 'JOB-B', { skipHistory: true });
  assert.equal(calls.setState.logStep, 'dictate');
  assert.deepEqual(calls.setState.logTouchedFields, []);
  assert.equal(calls.setState.editingActivityId, null);
  assert.equal(calls.setState.logFromAi, false);
});

test('stopping dictation ignores words that arrive afterwards', () => {
  let stopped = false;
  const rec = { onresult: () => {}, stop: () => { stopped = true; } };
  discardLogDictation.call({ _logRec: rec });
  assert.equal(stopped, true);
  assert.equal(rec.onresult, null);
  assert.doesNotThrow(() => discardLogDictation.call({ _logRec: null }));
});

// ---- Peer-review fixes to creating an entry ----

// An arrow-function property of the component, e.g. `  name = async () => {…};`
const arrowBody = (name, params = '') => html.match(new RegExp(`\\n  ${name} = (?:async )?\\(${params}\\) => \\{\\n([\\s\\S]*?)\\n  \\};\\n`))[1];
// A one-line arrow property, e.g. `  name = () => this.setState({ … });`
const oneLiner = (name) => new Function(html.match(new RegExp(`\\n  ${name} = \\(\\) => (this\\.setState\\([^\\n]*\\));\\n`))[1]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const emptyLogFields = { customerUpdate: '', privateNotes: '', findings: '', partsUsed: '', laborTime: '', recommendations: '', estimatedCost: '' };

// A fake component holding state; setState accepts objects or functions like React.
const fakeLogApp = (state, extra = {}) => {
  const app = {
    state: { logRecording: false, logTranscript: '', logTyped: '', logFields: { ...emptyLogFields }, logTouchedFields: [], ...state },
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) }; },
    keepTouchedLogFields,
    ...extra,
  };
  return app;
};

test('when the AI cannot be reached, the screen says so and the notes are kept', async () => {
  const run = new AsyncFunction(arrowBody('runLogExtraction'));
  const app = fakeLogApp({ logTyped: 'Changed the impeller.' }, { requestExtraction: async () => null });
  await run.call(app);
  assert.equal(app.state.logStep, undefined, 'stays on the talk/type screen');
  assert.match(app.state.logExtractError, /couldn’t read your notes/);
  assert.equal(app.state.logTyped, 'Changed the impeller.', 'notes are kept');

  const fill = new AsyncFunction(arrowBody('fillLogBoxesMyself'));
  await fill.call(app);
  assert.equal(app.state.logStep, 'review');
  assert.equal(app.state.logFromAi, false, 'saved as not AI-generated');
  assert.equal(app.state.logFields.privateNotes, 'Changed the impeller.');
  assert.equal(app.state.logFields.customerUpdate, '');
});

test('"Fill in the boxes myself" is always on the screen, not only when the AI fails', () => {
  const panel = html.slice(html.indexOf('>Log your work</div>'), html.indexOf('<sc-if value="{{ isLogReviewStep }}"'));
  assert.match(panel, /<div style="[^"]*" onClick="\{\{ fillLogBoxesMyself \}\}">FILL IN THE BOXES MYSELF<\/div>\n\s*<\/div>\n\s*<\/sc-if>/, 'last button in the box, not inside a condition');
  assert.match(panel, />AI sorts what you say into the boxes for you\.<\/div>/);
  assert.doesNotMatch(html, /logAiFailed/);
});

test('filling the boxes by hand stops the mic first so no words are lost', async () => {
  const fill = new AsyncFunction(arrowBody('fillLogBoxesMyself'));
  let stopped = false;
  const app = fakeLogApp({ logRecording: true, logTyped: 'Started talking' }, {
    stopLogRecordingAndWait: async function () { stopped = true; this.state.logTyped += ' and finished.'; },
  });
  await fill.call(app);
  assert.equal(stopped, true);
  assert.equal(app.state.logFields.privateNotes, 'Started talking and finished.');
});

test('when the AI answers, its boxes open for checking and are marked as AI', async () => {
  const run = new AsyncFunction(arrowBody('runLogExtraction'));
  const app = fakeLogApp({ logTyped: 'Changed the impeller.' }, { requestExtraction: async () => ({ customerUpdate: 'We replaced the impeller.', partsUsed: 'Impeller' }) });
  await run.call(app);
  assert.equal(app.state.logStep, 'review');
  assert.equal(app.state.logFromAi, true);
  assert.equal(app.state.logFields.customerUpdate, 'We replaced the impeller.');
  assert.equal(app.state.logFields.privateNotes, 'Changed the impeller.');
});

test('the AI request returns null on failure; intake still gets empty fields', async () => {
  const request = new AsyncFunction('rawText', 'schemaFields', 'schemaHint',
    html.match(/\n  async requestExtraction\(rawText, schemaFields, schemaHint\) \{\n([\s\S]*?)\n  \}\n/)[1]);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    const fields = await request.call({ aiRequestHeaders: async () => ({}) }, 'notes', ['customerUpdate'], '');
    assert.equal(fields, null);
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.match(html, /async runExtraction\(rawText, schemaFields, schemaHint\) \{\n\s*return \(await this\.requestExtraction\(rawText, schemaFields, schemaHint\)\) \|\| \{\};/);
});

test('dictated words land in the text box, where they can be corrected', () => {
  const start = new Function(arrowBody('startLogRecording'));
  let rec;
  const savedWindow = globalThis.window;
  globalThis.window = { SpeechRecognition: class { start() {} } };
  try {
    const app = fakeLogApp({ logTyped: 'Checked the drive.' });
    start.call(app);
    rec = app._logRec;
    rec.onresult({ resultIndex: 0, results: [
      Object.assign([{ transcript: ' shift cable not throttle cable ' }], { isFinal: true }),
      Object.assign([{ transcript: 'adjusted it' }], { isFinal: false }),
    ] });
    assert.equal(app.state.logTyped, 'Checked the drive. shift cable not throttle cable');
    assert.equal(app.state._logInterim, 'adjusted it', 'words still being heard show separately');
  } finally {
    globalThis.window = savedWindow;
  }
});

test('Cancel asks first; Keep it changes nothing; Discard clears', () => {
  const app = fakeLogApp({ logStep: 'review', logTyped: 'notes', logFields: { ...emptyLogFields, customerUpdate: 'Update' } });
  oneLiner('cancelLogReview').call(app);
  assert.equal(app.state.logAskingToDiscard, true);
  assert.equal(app.state.logFields.customerUpdate, 'Update', 'nothing cleared yet');
  oneLiner('keepLogReview').call(app);
  assert.equal(app.state.logAskingToDiscard, false);
  assert.equal(app.state.logStep, 'review');
  oneLiner('cancelLogReview').call(app);
  new Function(arrowBody('discardLogReview')).call(app);
  assert.equal(app.state.logStep, 'dictate');
  assert.equal(app.state.logTyped, '');
  assert.deepEqual(app.state.logFields, emptyLogFields);
});

test('creating uses the same boxes as editing, with a full-width Save and plain errors', () => {
  assert.match(html, /<sc-for list="\{\{ logReviewFields \}\}" as="field"/);
  assert.match(html, /logReviewFields: s\.logStep === 'review' \? this\.constructor\.WORK_LOG_EDIT_FIELDS\.map/);
  assert.doesNotMatch(html, /CUSTOMER UPDATE &middot; EDITABLE/);
  assert.doesNotMatch(html, /NEVER CUSTOMER VISIBLE/);
  assert.match(html, /logSaveButtonStyle: `min-height:48px;/);
  assert.match(html, /aiGenerated: !!this\.state\.logFromAi/);
  assert.doesNotMatch(html, /logSaveError: \(e && e\.message\)/);
  assert.match(html, /Couldn(’|\\u2019)t save this update\. Everything is still here/);
});

test('the Log your work box asks for parts, time, cost and recommendations', () => {
  assert.doesNotMatch(html, />What happened\?<\/div>/, 'old title is gone');
  const panel = html.slice(html.indexOf('>Log your work</div>'), html.indexOf('{{ runLogExtraction }}'));
  assert.ok(panel.length > 0 && html.indexOf('>Log your work</div>') > 0, 'new title is shown');
  assert.match(panel, /placeholder="Press REC and say what you did\. Include any parts, cost, time and recommendations\. Then press STOP and GENERATE UPDATE\."/);
  // The hint must name the buttons exactly as they appear on screen.
  assert.match(html, /logMicButtonLabel: [^\n]*'\\u25a0 STOP' : '\\u25cf REC'/);
  assert.match(html, /: 'GENERATE UPDATE',/);
});

// ---- Second peer review: the 14 fixes Cassandra chose ----

test('1: boxes use 16px text so iPhones do not zoom in when tapped', () => {
  assert.match(html, /textStyle: `[^`]*font:500 16px 'Public Sans'/);
  assert.match(html, /<textarea rows="\{\{ logTypedRows \}\}" style="[^"]*font:500 16px/);
});

test('2: leaving the job screen stops the mic (called the way the app framework calls it)', () => {
  // The framework calls componentDidUpdate(prevProps) only — never with the
  // previous state — so this test passes no previous state either.
  const body = html.match(/\n  componentDidUpdate\(\) \{\n([\s\S]*?)\n  \}\n/)[1];
  // eslint-disable-next-line no-new-func
  const didUpdate = new Function(body);
  let stopped = 0;
  const rec = { stop() { stopped += 1; } };
  const app = {
    syncHomeScreenIcon() {}, _logRec: rec, state: { screen: 'jobDetail' },
    stopLogDictationNow() { if (this._logRec) this._logRec.stop(); },
  };
  didUpdate.call(app);                       // on the job screen, recording
  assert.equal(stopped, 0);
  didUpdate.call(app);                       // still on the job (e.g. typing)
  assert.equal(stopped, 0);
  app.state = { screen: 'dashboard' };       // back to the job list
  didUpdate.call(app);
  assert.equal(stopped, 1, 'mic stopped on leaving the job');
  didUpdate.call(app);                       // later updates on the list
  assert.equal(stopped, 1, 'only once');
});

test('2b: closing the app screen also turns the mic off', () => {
  assert.match(html, /\n  componentWillUnmount\(\) \{\n    this\.stopLogDictationNow\(\);/);
});

test('3: "Fill in the boxes myself" never empties a box that has something in it', async () => {
  const fill = new AsyncFunction(arrowBody('fillLogBoxesMyself'));
  const app = fakeLogApp({
    logTyped: 'New notes', logFromAi: true,
    logFields: { ...emptyLogFields, customerUpdate: 'AI wrote this', partsUsed: 'Impeller', privateNotes: 'old notes' },
  });
  await fill.call(app);
  assert.equal(app.state.logFields.customerUpdate, 'AI wrote this');
  assert.equal(app.state.logFields.partsUsed, 'Impeller');
  assert.equal(app.state.logFields.privateNotes, 'New notes', 'private notes follow the latest notes unless changed by hand');
  assert.equal(app.state.logFromAi, true, 'still counts as AI-written');
});

test('4: the Log your work box grows with the notes (4 to 14 lines)', () => {
  const rows = new Function('s', `return ${html.match(/logTypedRows: (Math\.min\([^\n]*\)),\n/)[1]};`);
  assert.equal(rows({ logTyped: '' }), 4);
  assert.equal(rows({ logTyped: 'x'.repeat(32 * 8) }), 8);
  assert.equal(rows({ logTyped: 'x'.repeat(32 * 40) }), 14);
});

test('5: the old "+ Check-in note" is gone', () => {
  assert.doesNotMatch(html, /CHECK-IN NOTE|toggleQuickUpdate|quickUpdateOpen|submitActivity/);
});

test('6: a short "saved" message shows after saving, and goes away by itself', () => {
  assert.match(html, /<sc-if value="\{\{ logJustSaved \}\}"[^>]*>\s*<div role="status"[^>]*>&#10003; Update saved\./);
  assert.match(html, /<sc-if value="\{\{ act\.justSaved \}\}"[^>]*>\s*<div role="status"[^>]*>&#10003; Changes saved\./);
  assert.match(html, /logJustSaved: true,\n\s*\}\)\);\n\s*this\.showSavedBriefly\('log'/);
  assert.match(html, /justSavedActivityId: id,\n[\s\S]{0,40}\}\);\n\s*this\.showSavedBriefly\('edit'/);
  assert.match(html, /setLogTyped = \(e\) => this\.setState\(\{ logTyped: e\.target\.value, logJustSaved: false \}\)/, 'typing hides it');
});

test('7: the label beside REC says PRESS TO TALK', () => {
  assert.match(html, /logMicStatusLabel: [^\n]*'PRESS TO TALK'\)/);
});

test('8: edit Cancel asks only when something was changed', () => {
  // eslint-disable-next-line no-new-func
  const cancel = new Function(html.match(/\n  cancelEditActivity = \(\) => \{\n([\s\S]*?)\n  \};\n/)[1]);
  const entry = workLog();
  const make = (draft) => ({
    state: { editingActivityId: 'E1', jobActivities: [{ ...entry, id: 'E1' }], editDraft: draft },
    editPatchFor: app.editPatchFor, editDraftFor: app.editDraftFor, editFieldsFor: app.editFieldsFor,
    setState(u) { this.state = { ...this.state, ...u }; },
    discardEdit() { this.state.editingActivityId = null; },
  });
  const unchanged = make(app.editDraftFor(entry));
  cancel.call(unchanged);
  assert.equal(unchanged.state.editingActivityId, null, 'nothing changed → closes');
  const changed = make({ ...app.editDraftFor(entry), laborTime: '2 hrs' });
  cancel.call(changed);
  assert.equal(changed.state.editAskingToDiscard, true, 'changed → asks first');
  assert.equal(changed.state.editingActivityId, 'E1');
});

test('9: filter chips with nothing in them are hidden (ALL and the chosen one stay)', () => {
  assert.match(html, /\.filter\(f => f\.key === 'all' \|\| f\.key === activityFilter \|\| \(activityCategoryCounts\[f\.key\] \|\| 0\) > 0\)/);
});

test('10–14: readable photo labels, plain mic error, clearer card details, Hearing below the box, better contrast', () => {
  assert.match(html, />PHOTOS &mdash; TAP TO ATTACH</);
  assert.match(html, /\n\s*\+ PHOTO\n/);
  assert.match(html, /<div role="alert" style="[^"]*font:600 13px[^"]*">\{\{ logMicErrorLabel \}\}/);
  assert.match(html, /flex-direction:column;gap:4px;font:500 13\.5px[^"]*">\n\s*<sc-if value="\{\{ act\.hasFindings \}\}"[^>]*><div><b>Findings:/);
  const box = html.indexOf('onChange="{{ setLogTyped }}"></textarea>');
  const hearing = html.indexOf('Hearing: {{ logTranscriptDisplay }}');
  assert.ok(box > 0 && hearing > box, 'Hearing line comes after the box');
  assert.match(html, /background:\$\{disabled \? '#DDE1E4' : '#B45309'\};color:\$\{disabled \? '#4E5B68' : '#fff'\}/);
});
