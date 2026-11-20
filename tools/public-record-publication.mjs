// Which public source masters are ready to upload, and what the manifest
// should say once they are.
//
// record-recovery-queue.json is a legacy input: nothing regenerates it from
// the canonical acquisition targets, so its copies of a record's viewer state,
// reference and people verification go stale. The canonical target says
// whether a record awaits upload; the manifest record carries its custody
// (hash, length, media type, rights) and verified people. The queue only
// scopes which records belong to the public publisher.

export function extensionFor(mediaType) {
  // Matches import-public-records.mjs, which records the same blob path.
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType === "image/tiff") return ".tif";
  if (mediaType === "image/jp2") return ".jp2";
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/webp") return ".webp";
  return ".jpg";
}

export function blobPathFor(id, mediaType) {
  return `records/${id}/original${extensionFor(mediaType)}`;
}

// One entry per record to upload: the queue item (for scoping and its
// archive file), the canonical target, and the manifest record.
export function selectPendingPublicRecords({ queueTargets = [], canonicalTargets = new Map(), manifestRecords = new Map() }) {
  const pending = [];
  for (const item of queueTargets) {
    if (item.status !== "acquired") continue;
    const canonical = canonicalTargets.get(item.id);
    const canonicalPending = canonical?.viewerPublishState === "pending-upload" && canonical.viewer;
    const queuePending = !canonical && item.viewerPublishState === "pending-upload" && item.viewer;
    if (!canonicalPending && !queuePending) continue;
    const record = manifestRecords.get(item.id);
    if (!record) throw new Error(`refusing to publish ${item.id}: it has no records-manifest entry`);
    pending.push({ id: item.id, item, canonical: canonical || null, record });
  }
  return pending;
}

// The custody and verification facts the upload must check, from the
// manifest (which registration and review keep current), not the queue.
export function publicationFacts({ item, record }) {
  const archiveFile = item.archiveFile || String(record.archivePath || "").split("/").pop();
  return {
    archiveFile,
    sha256: record.sha256,
    length: record.length,
    mediaType: record.mediaType,
    rights: record.rights,
    peopleVerifiedAt: record.peopleVerifiedAt,
    peopleVerificationBasis: record.peopleVerificationBasis
  };
}

// The manifest viewer block for a just-uploaded record, built from the
// canonical structured presentation.
export function manifestViewerFor({ canonical, item, record }, publishedAt) {
  const presentation = canonical?.viewer || item.viewer || {};
  const viewer = { approved: true, approvedAt: publishedAt };
  for (const field of ["titleMode", "titlePrincipals", "titleQualifier", "title", "category", "date", "description"]) {
    if (presentation[field] !== undefined) viewer[field] = presentation[field];
  }
  if (viewer.titleMode) delete viewer.title;
  viewer.blobPath = blobPathFor(record.id, record.mediaType);
  return viewer;
}

// The queue copy of a record's verified people and reading, refreshed from
// the manifest so the queue/manifest/atom agreement checks hold after upload.
export function queueFieldsFromManifest(record) {
  const fields = {};
  for (const field of ["people", "reference", "peopleVerifiedAt", "peopleVerificationBasis"]) {
    if (record[field] !== undefined) fields[field] = record[field];
  }
  return fields;
}
