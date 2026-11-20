// Every preserved original that the tree relies on as proof belongs in the
// protected family viewer. A record qualifies when its source master is
// archived and hashed, its rights are family-viewer-approved, its structured
// person links are visually verified, and an established conclusion cites it
// as direct or indirect evidence. Earlier acquisition passes registered many
// such originals as withheld controls by default and never revisited them; this
// module finds those gaps and promotes them to the normal pending-upload state.
//
// Only an explicit user decision recorded as `viewerExclusion` on the canonical
// acquisition target keeps a qualifying record out of the viewer.

import fs from "node:fs";
import path from "node:path";

// A TIFF master is shown only through its generated web previews (browsers cannot draw TIFF).
export const viewerMediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff", "application/pdf"]);
const affirmativeRoles = new Set(["direct", "indirect"]);

export function affirmativeCitationsBySource(proofDocuments) {
  const bySource = new Map();
  for (const document of proofDocuments) {
    for (const assertion of document.assertions || []) {
      if (assertion.assessment !== "established") continue;
      for (const evidence of assertion.evidence || []) {
        if (!affirmativeRoles.has(evidence.role) || !evidence.sourceId) continue;
        const list = bySource.get(evidence.sourceId) || [];
        list.push({ assertionId: assertion.id, role: evidence.role });
        bySource.set(evidence.sourceId, list);
      }
    }
  }
  return bySource;
}

export function citedRecordViewerGaps({ manifest, sourcesById, targetsById, targetsBySourceId, citations }) {
  const gaps = [];
  const awaitingRights = [];
  for (const record of manifest.records || []) {
    if (record.viewer?.approved === true) continue;
    if (!record.sha256 || !record.archivePath) continue;
    const sourceId = record.sourceAtomId || record.id;
    const cited = citations.get(sourceId) || [];
    if (!cited.length) continue;
    const target = targetsById.get(record.id) || targetsBySourceId.get(sourceId);
    if (target?.viewerExclusion?.decidedBy === "user") continue;
    if (record.privacy === "restricted" || record.rights === "restricted"
      || !viewerMediaTypes.has(record.mediaType)) continue;
    if (record.rights !== "family-viewer-approved") {
      awaitingRights.push({ id: record.id, rights: record.rights, source: record.source });
      continue;
    }
    const source = sourcesById.get(sourceId);
    if (!source?.personLinksVerifiedAt || !Array.isArray(source.personLinks)) continue;
    const promoted = source.viewerPolicy === "approved-private"
      && target?.desiredArtifact?.publishEligible === true
      && ["pending-upload", "published"].includes(target?.viewerPublishState);
    if (promoted) continue;
    gaps.push({
      id: record.id,
      sourceId,
      targetId: target?.id,
      citations: cited.length,
      viewerPolicy: source.viewerPolicy,
      viewerPublishState: target?.viewerPublishState
    });
  }
  return { gaps, awaitingRights };
}

export function promoteTarget(target, viewer, sourceId) {
  const next = structuredClone(target);
  next.desiredArtifact = { ...(next.desiredArtifact || {}), publishEligible: true };
  if ("publishEligible" in next) next.publishEligible = true;
  if (next.evidenceRole === "candidate-control") next.evidenceRole = "direct-or-supporting";
  delete next.withholdReason;
  if (next.viewerPublishState !== "published") next.viewerPublishState = "pending-upload";
  const presentation = structuredClone(viewer || next.viewer);
  if (!presentation?.titleMode || !Array.isArray(presentation.titlePrincipals)
      || presentation.titlePrincipals.some((principal) => !principal || typeof principal !== "object")) {
    throw new Error(`${target.id} needs a structured viewer presentation before promotion`);
  }
  delete presentation.title;
  presentation.titlePrincipals = presentation.titlePrincipals
    .map((principal) => ({ ...principal, sourceAtomId: sourceId }));
  next.viewer = presentation;
  return next;
}

export function loadCitedRecordContext(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "evidence", "records-manifest.json"), "utf8"));
  const sourcesById = new Map();
  const sourcePaths = new Map();
  const sourceRoot = path.join(root, "evidence", "sources");
  for (const provider of fs.readdirSync(sourceRoot)) {
    const directory = path.join(sourceRoot, provider);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(directory, file);
      const source = JSON.parse(fs.readFileSync(filePath, "utf8"));
      sourcesById.set(source.id, source);
      sourcePaths.set(source.id, filePath);
    }
  }
  const targetsById = new Map();
  const targetsBySourceId = new Map();
  const targetRoot = path.join(root, "evidence", "acquisition", "targets");
  for (const file of fs.readdirSync(targetRoot)) {
    if (!file.endsWith(".json")) continue;
    const target = JSON.parse(fs.readFileSync(path.join(targetRoot, file), "utf8"));
    targetsById.set(target.id, target);
    if (target.sourceId && !targetsBySourceId.has(target.sourceId)) targetsBySourceId.set(target.sourceId, target);
  }
  const proofDocuments = [];
  for (const kind of ["people", "unions", "kinships"]) {
    const directory = path.join(root, "evidence", "proof", kind);
    for (const file of fs.readdirSync(directory)) {
      if (file.endsWith(".json")) proofDocuments.push(JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
    }
  }
  return {
    manifest,
    sourcesById,
    sourcePaths,
    targetsById,
    targetsBySourceId,
    targetRoot,
    citations: affirmativeCitationsBySource(proofDocuments)
  };
}
