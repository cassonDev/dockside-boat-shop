#!/usr/bin/env node
/*
 * storage-inventory-and-classify.js  —  READ ONLY. DELETES NOTHING.
 *
 * Exports a complete inventory of the `work-order-photos` bucket and reconciles
 * it against public.work_order_photos, classifying every object and record into
 * the seven states agreed for the private-storage conversion:
 *
 *   1. Active photo record with a valid object.
 *   2. Inactive / archived photo record with a valid object.
 *   3. Photo record whose object is MISSING in storage.            (REVIEW)
 *   4. Storage object referenced by a photo record.                (reconciled)
 *   5. Storage object with NO matching photo record (orphan).      (REVIEW)
 *   6. Photo record explicitly approved for permanent purge.
 *   7. Ambiguous object requiring manual review (bad name shape,   (REVIEW)
 *      unexpected suffix, extra folder depth, path/record mismatch).
 *
 * Only category 6 may EVER be auto-deleted, and only by a separate, controlled,
 * retention-gated server-side release. Categories 3, 5 and 7 are REPORTED for
 * human review here and never touched.
 *
 * Usage (run locally, never in the browser):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/storage-inventory-and-classify.js [--json out.json]
 *
 * Requires the SERVICE-ROLE key (not the anon key) so it can list every object
 * and read every row regardless of RLS. Keep that key OUT of the browser and
 * out of source control — pass it via the environment only.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'work-order-photos';
const NAME_RE = /^[^/]+\/[^/]+-(orig|thumb)\.jpg$/;

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}
const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

// Recursively list every object under the bucket (storage.list is one level).
async function listAllObjects(prefix = '') {
  const out = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder entry has no id/metadata; recurse into it.
      if (entry.id === null || (entry.metadata == null && !/\.[a-z0-9]+$/i.test(entry.name))) {
        out.push(...await listAllObjects(full));
      } else {
        out.push({ path: full, size: entry.metadata && entry.metadata.size, updatedAt: entry.updated_at });
      }
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function fetchAllPhotoRows() {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('work_order_photos')
      .select('id, work_order_id, shop_id, storage_path, thumb_path, active, archived_at, archived_by, purge_approved_at, purge_after, storage_deleted_at, replaced_by_photo_id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`photo rows query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

(async () => {
  const [objects, rows] = await Promise.all([listAllObjects(), fetchAllPhotoRows()]);

  const objectSet = new Set(objects.map(o => o.path));
  const referenced = new Set(); // object paths named by some DB row
  for (const r of rows) { if (r.storage_path) referenced.add(r.storage_path); if (r.thumb_path) referenced.add(r.thumb_path); }

  const report = {
    generatedAt: new Date().toISOString(),
    bucket: BUCKET,
    totals: { objects: objects.length, photoRows: rows.length },
    cat1_activeRecordValidObject: [],
    cat2_inactiveRecordValidObject: [],
    cat3_recordMissingObject: [],       // REVIEW — never delete
    cat4_objectReferencedByRecord: 0,   // count only (reconciled)
    cat5_orphanObjectNoRecord: [],      // REVIEW — never delete
    cat6_approvedForPurge: [],          // the only eventually-auto-deletable set
    cat7_ambiguousReview: [],           // REVIEW — never delete
    badNameObjects: [],
    duplicatePathRows: [],
  };

  // --- Record-driven classification (categories 1,2,3,6) ---
  for (const r of rows) {
    const paths = [r.storage_path, r.thumb_path].filter(Boolean);
    const missing = paths.filter(p => !objectSet.has(p));
    if (missing.length) report.cat3_recordMissingObject.push({ id: r.id, workOrderId: r.work_order_id, missing });
    else if (r.active === false) report.cat2_inactiveRecordValidObject.push({ id: r.id, workOrderId: r.work_order_id });
    else report.cat1_activeRecordValidObject.push({ id: r.id, workOrderId: r.work_order_id });

    if (r.purge_approved_at && r.purge_after && !r.storage_deleted_at) {
      const retentionPassed = new Date(r.purge_after).getTime() <= Date.now();
      report.cat6_approvedForPurge.push({ id: r.id, workOrderId: r.work_order_id, purgeAfter: r.purge_after, retentionPassed });
    }
  }
  report.cat4_objectReferencedByRecord = objects.filter(o => referenced.has(o.path)).length;

  // --- Object-driven classification (categories 5,7) ---
  for (const o of objects) {
    const validName = NAME_RE.test(o.path);
    if (!validName) { report.badNameObjects.push(o.path); report.cat7_ambiguousReview.push({ path: o.path, reason: 'name does not match <wo_id>/<id>-{orig|thumb}.jpg' }); continue; }
    if (!referenced.has(o.path)) report.cat5_orphanObjectNoRecord.push(o.path);
  }

  // --- Duplicate path check (should be empty; a path owned by two rows is ambiguous) ---
  const byPath = new Map();
  for (const r of rows) {
    for (const p of [r.storage_path, r.thumb_path].filter(Boolean)) {
      byPath.set(p, (byPath.get(p) || []).concat(r.id));
    }
  }
  for (const [p, ids] of byPath) if (ids.length > 1) { report.duplicatePathRows.push({ path: p, rowIds: ids }); report.cat7_ambiguousReview.push({ path: p, reason: `referenced by ${ids.length} rows` }); }

  const summary = {
    objects: report.totals.objects,
    photoRows: report.totals.photoRows,
    cat1_activeValid: report.cat1_activeRecordValidObject.length,
    cat2_inactiveValid: report.cat2_inactiveRecordValidObject.length,
    cat3_recordMissingObject_REVIEW: report.cat3_recordMissingObject.length,
    cat4_objectsReferenced: report.cat4_objectReferencedByRecord,
    cat5_orphanObjects_REVIEW: report.cat5_orphanObjectNoRecord.length,
    cat6_approvedForPurge: report.cat6_approvedForPurge.length,
    cat7_ambiguous_REVIEW: report.cat7_ambiguousReview.length,
    badNameObjects: report.badNameObjects.length,
    duplicatePathRows: report.duplicatePathRows.length,
  };

  console.log('\n=== work-order-photos inventory & classification (READ ONLY) ===');
  console.table(summary);
  if (report.cat3_recordMissingObject.length) console.log('\nCAT 3 — records with MISSING objects (review):\n', report.cat3_recordMissingObject);
  if (report.cat5_orphanObjectNoRecord.length) console.log('\nCAT 5 — orphan objects with NO record (review, DO NOT auto-delete):\n', report.cat5_orphanObjectNoRecord);
  if (report.cat7_ambiguousReview.length) console.log('\nCAT 7 — ambiguous (review):\n', report.cat7_ambiguousReview);
  console.log('\nNothing was deleted. Categories 3, 5 and 7 are for human review.');

  const jsonFlagIdx = process.argv.indexOf('--json');
  if (jsonFlagIdx !== -1 && process.argv[jsonFlagIdx + 1]) {
    require('fs').writeFileSync(process.argv[jsonFlagIdx + 1], JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${process.argv[jsonFlagIdx + 1]}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
