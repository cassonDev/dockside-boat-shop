// Automated tests for the deterministic layer of ai-extract.js.
//
// These cover exactly the units that must behave predictably regardless of the
// AI model: phone normalization (typed + spoken digits + absent), priority
// detection & app-value mapping, strict-schema construction, and the
// field-sanitizer that stitches them together. They run with plain Node and no
// network — the model-dependent extraction (name/boat/issue wording) is
// validated separately with the live staging test script.
//
//   Run:  node netlify/functions/ai-extract.test.js

const { normalizePhone, extractPhone, detectPriority, toAppPriority, toDigitStream, buildJsonSchema, sanitizeFields } = require('./ai-extract.js')._test;

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n          expected ${e}\n          got      ${a}`); }
}

// --- Required transcript #1: typed phone + high priority ---------------------
const T1 = 'Gavin, phone 604-555-1234, 2022 Bayliner VR5, trailer tire is damaged, high priority.';
console.log('\n[1] "Gavin ... 604-555-1234 ... 2022 Bayliner VR5 ... high priority."');
eq(normalizePhone('604-555-1234'), '(604) 555-1234', 'phone normalizes to (604) 555-1234');
eq(toAppPriority(detectPriority(T1)), 'high', 'priority => high');
// The 2022 model year must NOT be mistaken for a phone number.
eq(normalizePhone('2022'), '', 'model year 2022 is not a phone number');

// --- Required transcript #2: spoken-digit phone ------------------------------
console.log('\n[2] spoken-digit phone');
eq(normalizePhone('six oh four, five five five, one two three four'), '(604) 555-1234', 'spoken digits => (604) 555-1234');
eq(normalizePhone('six zero four five five five one two three four'), '(604) 555-1234', '"zero" variant => (604) 555-1234');
eq(normalizePhone('1 604 555 1234'), '(604) 555-1234', 'leading country code 1 stripped');

// --- Required transcript #3: no phone number ---------------------------------
console.log('\n[3] no phone number spoken');
const T3 = 'Bayliner coming in for winterization, no rush.';
eq(normalizePhone(''), '', 'empty => blank (never invented)');
eq(sanitizeFields({ phone: '' }, ['phone'], T3).phone, '', 'sanitize leaves phone blank when absent');

// --- Required transcript #4: no priority -------------------------------------
console.log('\n[4] no priority spoken');
const T4 = 'Gavin, 2019 Yamaha, oil change please.';
eq(detectPriority(T4), '', 'no cue => blank tier');
eq(sanitizeFields({ priority: '' }, ['priority'], T4).priority, '', 'sanitize leaves priority blank (keeps app default)');

// --- Required transcript #5: "This is urgent" / "low priority" ---------------
console.log('\n[5] urgent / low priority phrasing');
eq(toAppPriority(detectPriority('This is urgent.')), 'high', '"urgent" => high');
eq(detectPriority('Handle it whenever, low priority.'), 'low', '"low priority" => low tier');
eq(toAppPriority(detectPriority('Handle it whenever, low priority.')), 'normal', 'low tier clamps to app value normal');
eq(toAppPriority(detectPriority('emergency, boat is sinking')), 'high', '"emergency" => high');
eq(toAppPriority(detectPriority('rush job')), 'high', '"rush" => high');

// --- Review fix #1: de-prioritizing phrases must NOT read as High ------------
// ("not urgent"/"no rush" contain "urgent"/"rush" — negatives processed first.)
console.log('\n[fix1] negation ordering');
eq(toAppPriority(detectPriority('not urgent')), 'normal', '"not urgent" => Normal');
eq(toAppPriority(detectPriority('no rush')), 'normal', '"no rush" => Normal');
eq(toAppPriority(detectPriority('no rush needed')), 'normal', '"no rush needed" => Normal');
eq(toAppPriority(detectPriority('low priority')), 'normal', '"low priority" => Normal (app value)');
eq(toAppPriority(detectPriority('urgent')), 'high', '"urgent" => High');
eq(toAppPriority(detectPriority('rush job')), 'high', '"rush job" => High');
// Documented deterministic conflict rule: de-prioritizing language wins.
eq(toAppPriority(detectPriority('not urgent, but please rush it')), 'normal', '"not urgent, but please rush it" => Normal (de-prioritizing wins, documented)');

// --- Review fix #2: phone anti-hallucination --------------------------------
// A valid-looking number the model returns must appear in the transcript.
console.log('\n[fix2] phone anti-hallucination');
eq(sanitizeFields({ phone: '6045551234' }, ['phone'], 'Bayliner coming in for service, no phone number given.').phone, '', 'model number absent from transcript => blank');
eq(sanitizeFields({ phone: '6045551234' }, ['phone'], T1).phone, '(604) 555-1234', 'model number present in transcript => kept & formatted');
eq(sanitizeFields({ phone: '6045551234' }, ['phone'], 'reach them at six oh four five five five one two three four').phone, '(604) 555-1234', 'spoken-digit equivalent in transcript => kept');
eq(toDigitStream('six oh four five five five one two three four'), '6045551234', 'toDigitStream converts spoken digits');

// --- Review fix #3: priority comes ONLY from the transcript ------------------
// The model's own priority value is never trusted.
console.log('\n[fix3] priority from transcript only');
eq(sanitizeFields({ priority: 'high' }, ['priority'], 'Oil change, no priority mentioned.').priority, '', 'no cue + model says high => blank');
eq(sanitizeFields({ priority: '' }, ['priority'], 'This is high priority.').priority, 'high', 'transcript high + model blank => high');
eq(sanitizeFields({ priority: 'high' }, ['priority'], 'Winterize it, no rush.').priority, 'normal', 'transcript no rush + model high => normal');

// --- Review fix #4: candidate-based phone extraction (staging bug) ----------
// The old normalizer concatenated ALL transcript digits; these prove the new
// candidate scanner isolates individual numbers and prefers the labelled/last.
console.log('\n[fix4] candidate-based phone extraction');
eq(extractPhone('Gavin Mercer phone 604-5555-1234 urgent 604-5555-1234 604555-1234 phone number 604-555-1234'), '(604) 555-1234', 'staging transcript: malformed repeats, final labelled valid wins');
eq(extractPhone('phone 604-5555-1234 corrected phone number 604-555-1234'), '(604) 555-1234', 'malformed then valid correction => corrected number');
eq(extractPhone('phone 604-555-1234 604-555-1234'), '(604) 555-1234', 'repeated valid number => that number');
eq(extractPhone('phone 604-555-1234 2022 Bayliner VR5'), '(604) 555-1234', 'phone then 4-digit boat year => year not borrowed');
eq(extractPhone('invoice 12345, slip 7, hours 8, sku 9981'), '', 'multiple unrelated numeric values => blank');
eq(extractPhone('Bayliner in for winterization, no phone given'), '', 'no valid phone => blank');
eq(extractPhone('call six oh four five five five one two three four'), '(604) 555-1234', 'spoken-digit form still works');
eq(extractPhone('phone 1 604 555 1234'), '(604) 555-1234', 'leading country code handled');
// End-to-end through sanitizeFields (phone now comes from transcript, not model).
eq(sanitizeFields({ phone: '9999999999' }, ['phone'], 'phone number 604-555-1234, 2022 Bayliner').phone, '(604) 555-1234', 'sanitize ignores model phone, extracts labelled transcript number');
eq(sanitizeFields({ phone: '6045551234' }, ['phone'], 'no number spoken at all').phone, '', 'sanitize => blank when transcript has no phone');

// --- Extra guards ------------------------------------------------------------
console.log('\n[extra] schema & sanitizer guards');
const schema = buildJsonSchema(['customerName', 'phone', 'priority']);
eq(schema.strict, true, 'schema is strict');
eq(schema.schema.additionalProperties, false, 'no additional properties allowed');
eq(schema.schema.required, ['customerName', 'phone', 'priority'], 'all fields required');
eq(schema.schema.properties.priority.enum, ['high', 'normal', 'low', ''], 'priority constrained to enum');
// Full end-to-end sanitize on transcript #1's model output shape.
const s1 = sanitizeFields(
  { customerName: 'Gavin', phone: '604 555 1234', boatYear: '2022', boatMake: 'Bayliner', boatModel: 'VR5', issue: 'trailer tire is damaged', priority: 'high' },
  ['customerName', 'phone', 'boatYear', 'boatMake', 'boatModel', 'issue', 'priority'], T1
);
eq(s1, { customerName: 'Gavin', phone: '(604) 555-1234', boatYear: '2022', boatMake: 'Bayliner', boatModel: 'VR5', issue: 'trailer tire is damaged', priority: 'high' }, 'transcript #1 full sanitize');
// Model hallucinates a phone that was never spoken -> normalizer keeps only
// real digits; a bogus non-numeric string collapses to blank.
eq(sanitizeFields({ phone: 'not sure' }, ['phone'], 'no number here').phone, '', 'non-numeric model phone => blank');

console.log(`\n${failed === 0 ? 'ALL PASSED' : 'SOME FAILED'} — ${passed} passed, ${failed} failed\n`);
if (typeof process !== 'undefined' && process.exit) process.exit(failed === 0 ? 0 : 1);
