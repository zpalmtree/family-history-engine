// Which pending records a publish run may upload.
//
// `npm run records:publish:* -- --record <id>` cannot work: npm appends extra arguments to the
// last command of the script chain (a data:check), never to the publisher. The selection
// therefore also comes from PUBLISH_TARGET_IDS (comma or space separated), which survives the
// npm and `vercel env run` layers; --record and --target are honoured when the publisher is run
// directly. With no selection every eligible pending record is published, as before.
export function requestedPublishIds(argv = process.argv, env = process.env) {
  const ids = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    if ((argv[index] === "--record" || argv[index] === "--target") && argv[index + 1]) ids.add(argv[index + 1]);
  }
  for (const id of String(env.PUBLISH_TARGET_IDS || "").split(/[\s,]+/)) if (id) ids.add(id);
  return ids;
}

// Narrows the pending list to the requested ids; every requested id must be pending.
export function selectRequested(pending, requested, idOf = (entry) => entry.id) {
  if (!requested.size) return { selected: pending, skipped: [] };
  const selected = pending.filter((entry) => requested.has(idOf(entry)));
  const found = new Set(selected.map(idOf));
  const unavailable = [...requested].filter((id) => !found.has(id));
  if (unavailable.length) throw new Error(`requested record(s) are not eligible pending uploads: ${unavailable.join(", ")}`);
  return { selected, skipped: pending.filter((entry) => !requested.has(idOf(entry))).map(idOf) };
}

// Narrows the approved records a derivative run reads and hashes. With no selection every approved
// record is processed, as before; with one, every requested id must be an approved viewer record.
export function selectApproved(records, requested, idOf = (record) => record.id) {
  if (!requested.size) return records;
  const known = new Set(records.map(idOf));
  const unknown = [...requested].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`requested record(s) are not approved viewer records: ${unknown.join(", ")}`);
  return records.filter((record) => requested.has(idOf(record)));
}
