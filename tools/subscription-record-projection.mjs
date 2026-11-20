// Projects one acquired subscription queue target into its records-manifest entry.
//
// The queue is a compatibility projection, and its source, reference and viewer
// copies can lag behind reviews. A new record takes its citation from the canonical
// source atom. A re-import refreshes custody and publication state, but never
// rewrites an existing record's citation or its approved viewer presentation.
export function projectSubscriptionManifestRecord({
  target,
  existing = {},
  atom,
  sha256,
  length,
  archiveFile,
  rightsBasis,
  rightsConfirmedAt,
}) {
  const record = {
    ...existing,
    id: target.id,
    sourceAtomId: target.atomId || target.id,
    source: existing.source || atom?.source || atom?.provider || target.source,
    reference: existing.reference || atom?.reference || target.reference,
    people: target.people,
    catalogueUrl: target.catalogueUrl,
    acquiredAt: target.acquiredAt,
    mediaType: target.mediaType,
    sha256,
    length,
    rights: "family-viewer-approved",
    rightsBasis,
    rightsConfirmedAt,
    privacy: "private",
    storage: "encrypted-external",
    archivePath: `FamilyHistorySourceMasters/${archiveFile}`,
    encryption: "windows-efs",
    peopleVerifiedAt: target.peopleVerifiedAt,
    peopleVerificationBasis: target.peopleVerificationBasis
  };

  if (target.viewerPublishState === "published" && target.publishEligible === true) {
    // A newly published record takes the queue's viewer; an already approved one
    // keeps its reviewed presentation and approval date.
    record.viewer = existing.viewer?.approved === true
      ? { ...existing.viewer, blobPath: subscriptionBlobPath(target) }
      : {
        approved: true,
        approvedAt: target.viewerPublishedAt || target.acquiredAt,
        ...target.viewer,
        blobPath: subscriptionBlobPath(target)
      };
  } else {
    delete record.viewer;
  }
  return record;
}

export function subscriptionBlobPath(target) {
  return `records/${target.id}/original${extensionFor(target.mediaType)}`;
}

function extensionFor(mediaType) {
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/webp") return ".webp";
  return ".jpg";
}
