// Seed data + helpers for the Dockside prototype.

export const MECHANICS = [
  { id: 'm1', name: 'Jordan Reyes', outOfOffice: true },
  { id: 'm2', name: 'Mia Osei', outOfOffice: false },
  { id: 'm3', name: 'Diego Park', outOfOffice: false },
  { id: 'm4', name: 'Casey Nguyen', outOfOffice: false },
  { id: 'm5', name: 'Tyler Brooks', outOfOffice: true },
];

const BOATS = [
  'Cobalt 26 Cuddy Cabin', 'Bayliner 21 Bowrider', 'Boston Whaler 17 Montauk',
  'Sea Ray 24 Sundancer', 'Yamaha 212X Jet Boat', 'Grady-White 22 Seafarer',
  'Chaparral 19 SSi', 'MasterCraft X20', 'Key West 17 Sportsman',
  'Regal 26 Express', 'Pontoon 22 Bennington', 'Robalo R242',
  'Scout 245 XSF', 'Malibu Wakesetter 23', 'Tracker Pro 175',
];

const ISSUES = [
  { text: 'Engine cranks but won\u2019t start', size: 'L', priority: 'high' },
  { text: 'Bilge pump not engaging', size: 'M', priority: 'normal' },
  { text: 'Hull scratch below waterline', size: 'S', priority: 'normal' },
  { text: 'Outdrive making grinding noise', size: 'L', priority: 'high' },
  { text: 'Trim tabs unresponsive', size: 'M', priority: 'normal' },
  { text: 'Fuel gauge reads empty when full', size: 'S', priority: 'normal' },
  { text: 'Overheating at cruising speed', size: 'L', priority: 'high' },
  { text: 'Stereo/electronics dead', size: 'S', priority: 'normal' },
  { text: 'Steering wheel loose, hard to turn', size: 'M', priority: 'high' },
  { text: 'Annual winterization service', size: 'M', priority: 'normal' },
  { text: 'Prop replacement, hit debris', size: 'S', priority: 'normal' },
  { text: 'Battery won\u2019t hold charge', size: 'S', priority: 'normal' },
  { text: 'Leaking transom seal', size: 'M', priority: 'high' },
  { text: 'Full detail + bottom paint', size: 'L', priority: 'normal' },
  { text: 'Livewell pump failure', size: 'S', priority: 'normal' },
];

const FIRST = ['Sandra','Marcus','Elena','Tom','Priya','Wyatt','Renee','Hank','Alicia','Ben','Nora','Owen','Cara','Doug','Fiona','Greg','Ivy','Leo','Maya','Nate','Paige','Quinn','Rex','Sofia','Uma','Vic','Wes','Zoe','Kai','Lena'];
const LAST = ['Lin','Alvarez','Fitzgerald','Sanderson','Chowdhury','Bennett','Okafor','Silva','Marsh','Delgado','Ferris','Whitfield','Grant','Novak','Pace','Reyes','Ibarra','Sloan','Vance','Ward'];

// Simple integer hash so picks spread evenly regardless of array length
// (naive `seed % arr.length` breaks when seed's step shares a factor with arr.length).
function hash(n) {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
function randChoice(arr, seed) { return arr[hash(seed) % arr.length]; }

function jobCode(i) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  let n = i * 104729 + 17;
  for (let k = 0; k < 5; k++) { s += chars[n % chars.length]; n = Math.floor(n / chars.length) + i * 7; }
  return s;
}

export function newJobCode(existingIds) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let k = 0; k < 5; k++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (existingIds.includes(code));
  return code;
}

export function generateJobs() {
  const jobs = [];
  const statuses = ['open', 'open', 'in progress', 'in progress', 'done'];
  const now = Date.now();
  for (let i = 0; i < 32; i++) {
    const issue = randChoice(ISSUES, i * 3 + 1);
    const mech = MECHANICS[i % MECHANICS.length];
    const status = randChoice(statuses, i * 5 + 2);
    const createdAt = now - (i * 7 + (i % 4) * 3) * 3600 * 1000;
    const hasEntries = status !== 'open';
    jobs.push({
      id: jobCode(i + 1),
      customerName: `${randChoice(FIRST, i)} ${randChoice(LAST, i * 2 + 1)}`,
      phone: `(555) ${String(100 + (i * 37) % 900).padStart(3,'0')}-${String(1000 + (i * 91) % 9000).padStart(4,'0')}`,
      boatMakeModel: randChoice(BOATS, i),
      issue: issue.text,
      photos: [],
      size: issue.size,
      priority: issue.priority,
      assignedMechanic: mech.id,
      status,
      createdAt,
      entries: hasEntries ? [
        {
          timestamp: createdAt + 3600 * 1000 * 4,
          findings: 'Confirmed customer-reported issue on inspection.',
          fix: status === 'done' ? 'Replaced faulty part and tested under load.' : 'Diagnostics in progress, ordering part.',
          timeSpent: `${1 + (i % 3)}.5 hrs`,
          materials: i % 2 === 0 ? 'Gasket kit, marine grease' : 'None yet',
          photos: [],
        },
      ] : [],
    });
  }
  return jobs;
}
