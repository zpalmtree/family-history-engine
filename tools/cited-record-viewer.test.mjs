import test from "node:test";
import assert from "node:assert/strict";
import { affirmativeCitationsBySource, citedRecordViewerGaps, promoteTarget } from "./cited-record-viewer.mjs";

function context({ record = {}, source = {}, target = {}, assessment = "established", role = "direct" } = {}) {
  const baseRecord = {
    id: "rec", sourceAtomId: "rec", sha256: "abc", archivePath: "Masters/rec.jpg",
    rights: "family-viewer-approved", privacy: "private", mediaType: "image/jpeg", ...record
  };
  const baseSource = {
    id: "rec", viewerPolicy: "withheld-control", personLinks: [{ personId: "p" }],
    personLinksVerifiedAt: "2026-10-30", ...source
  };
  const baseTarget = {
    id: "rec", sourceId: "rec", desiredArtifact: { publishEligible: false },
    viewerPublishState: "withheld-control", ...target
  };
  return {
    manifest: { records: [baseRecord] },
    sourcesById: new Map([["rec", baseSource]]),
    targetsById: new Map([["rec", baseTarget]]),
    targetsBySourceId: new Map([["rec", baseTarget]]),
    citations: affirmativeCitationsBySource([{
      assertions: [{ id: "a", assessment, evidence: [{ sourceId: "rec", role }] }]
    }])
  };
}

test("a withheld original cited directly for an established claim is a gap", () => {
  assert.deepEqual(citedRecordViewerGaps(context()).gaps.map((gap) => gap.id), ["rec"]);
});

test("indirect evidence for an established claim also counts", () => {
  assert.equal(citedRecordViewerGaps(context({ role: "indirect" })).gaps.length, 1);
});

test("context, contradicting and unresolved citations do not count", () => {
  assert.equal(citedRecordViewerGaps(context({ role: "context" })).gaps.length, 0);
  assert.equal(citedRecordViewerGaps(context({ role: "contradicts" })).gaps.length, 0);
  assert.equal(citedRecordViewerGaps(context({ assessment: "unresolved" })).gaps.length, 0);
  assert.equal(citedRecordViewerGaps(context({ assessment: "candidate" })).gaps.length, 0);
});

test("published, pending, restricted or unverified records are not gaps", () => {
  assert.equal(citedRecordViewerGaps(context({ record: { viewer: { approved: true } } })).gaps.length, 0);
  assert.equal(citedRecordViewerGaps(context({
    source: { viewerPolicy: "approved-private" },
    target: { desiredArtifact: { publishEligible: true }, viewerPublishState: "pending-upload" }
  })).gaps.length, 0);
  assert.equal(citedRecordViewerGaps(context({ record: { privacy: "restricted" } })).gaps.length, 0);
  const restrictedRights = citedRecordViewerGaps(context({ record: { rights: "restricted" } }));
  assert.equal(restrictedRights.gaps.length + restrictedRights.awaitingRights.length, 0);
  assert.equal(citedRecordViewerGaps(context({ source: { personLinksVerifiedAt: undefined } })).gaps.length, 0);
});

test("records without viewer rights are reported separately, not as gaps", () => {
  const result = citedRecordViewerGaps(context({ record: { rights: "archive-only-pending-provider-approval" } }));
  assert.equal(result.gaps.length, 0);
  assert.equal(result.awaitingRights.length, 1);
});

test("only a user-recorded exclusion suppresses a gap", () => {
  assert.equal(citedRecordViewerGaps(context({ target: { viewerExclusion: { decidedBy: "agent" } } })).gaps.length, 1);
  assert.equal(citedRecordViewerGaps(context({ target: { viewerExclusion: { decidedBy: "user" } } })).gaps.length, 0);
});

test("promotion sets publication intent and binds principals to the record's atom", () => {
  const promoted = promoteTarget(
    { id: "rec", publishEligible: false, evidenceRole: "candidate-control", withholdReason: "x", viewerPublishState: "withheld-control" },
    { titleMode: "people", titlePrincipals: [{ personId: "p" }], category: "Census", title: "legacy" },
    "rec"
  );
  assert.equal(promoted.desiredArtifact.publishEligible, true);
  assert.equal(promoted.publishEligible, true);
  assert.equal(promoted.evidenceRole, "direct-or-supporting");
  assert.equal(promoted.withholdReason, undefined);
  assert.equal(promoted.viewerPublishState, "pending-upload");
  assert.equal(promoted.viewer.title, undefined);
  assert.deepEqual(promoted.viewer.titlePrincipals, [{ personId: "p", sourceAtomId: "rec" }]);
});

test("promotion refuses a legacy or malformed presentation", () => {
  assert.throws(() => promoteTarget({ id: "rec", viewer: { title: "Manual", category: "Census" } }, undefined, "rec"));
  assert.throws(() => promoteTarget({ id: "rec" }, { titleMode: "people", titlePrincipals: ["p"], category: "Census" }, "rec"));
});

test("a TIFF master can be shown (through its previews); other unviewable types cannot", () => {
  assert.deepEqual(citedRecordViewerGaps(context({ record: { mediaType: "image/tiff", archivePath: "Masters/rec.tif" } })).gaps.map((gap) => gap.id), ["rec"]);
  assert.equal(citedRecordViewerGaps(context({ record: { mediaType: "application/zip" } })).gaps.length, 0);
});
