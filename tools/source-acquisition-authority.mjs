export const canonicalAcquisitionTargetSchemaVersion = 4;

export const sourceOwnedArtifactFields = Object.freeze([
  "artifactPurpose",
  "recordClass",
  "artifactPolicy",
  "viewerPolicy"
]);

export function projectAcquisitionArtifactPolicy(source, target) {
  if (!source) throw new Error(`${target?.id || "acquisition target"} links a missing canonical source`);
  return {
    artifactPurpose: source.artifactPurpose,
    recordClass: source.recordClass,
    artifactPolicy: source.artifactPolicy,
    viewerPolicy: source.viewerPolicy,
    publishEligible: target?.desiredArtifact?.publishEligible === true
  };
}

export function acquisitionTargetAuthorityIssues(target) {
  const issues = [];
  if (target.schemaVersion !== canonicalAcquisitionTargetSchemaVersion) {
    issues.push(`${target.id} has unsupported acquisition schema`);
  }
  for (const field of sourceOwnedArtifactFields) {
    if (Object.hasOwn(target, field)) issues.push(`${target.id} duplicates source-owned ${field}`);
    if (Object.hasOwn(target.desiredArtifact || {}, field)) {
      issues.push(`${target.id} desiredArtifact duplicates source-owned ${field}`);
    }
  }
  if (!target.desiredArtifact || typeof target.desiredArtifact !== "object" || Array.isArray(target.desiredArtifact)) {
    issues.push(`${target.id} requires desiredArtifact acquisition intent`);
    return issues;
  }
  for (const field of Object.keys(target.desiredArtifact)) {
    if (field !== "publishEligible") issues.push(`${target.id} desiredArtifact has unsupported acquisition field ${field}`);
  }
  if (typeof target.desiredArtifact.publishEligible !== "boolean") {
    issues.push(`${target.id} desiredArtifact.publishEligible must be boolean`);
  }
  return issues;
}

export function reconcileProviderPublishEligibility(providerEligible, source, target) {
  if (source?.viewerPolicy === "withheld-control") return false;
  if (canonicalViewerPublicationApproved(source, target)) return true;
  return Boolean(providerEligible);
}

export function canonicalViewerPublicationApproved(source, target) {
  return source?.viewerPolicy === "approved-private"
    && target?.desiredArtifact?.publishEligible === true;
}

export function documentarySourceRequiresAcquisitionTarget(source) {
  return source?.kind === "documentary" && source.artifactPolicy !== "citation-only";
}
