import test from "node:test";
import assert from "node:assert/strict";
import { projectSubscriptionManifestRecord } from "./subscription-record-projection.mjs";

const baseTarget = {
  id: "findmypast-example-baptism-1835",
  source: "Findmypast, stale queue source",
  reference: "Stale queue reference, page 436",
  people: ["example-person"],
  catalogueUrl: "https://www.findmypast.com/search/results?lastname=example",
  acquiredAt: "2026-07-14",
  mediaType: "image/jpeg",
  peopleVerifiedAt: "2026-07-14",
  peopleVerificationBasis: "Queue basis",
  viewerPublishState: "published",
  publishEligible: true,
  viewer: { titleMode: "people", description: "Stale queue description." },
};
const atom = {
  id: baseTarget.id,
  provider: "Findmypast",
  source: "Findmypast, Staffordshire Baptisms",
  reference: "Reviewed reference, page 437 (right page, facing 436)",
};
const project = (overrides) => projectSubscriptionManifestRecord({
  target: baseTarget,
  atom,
  sha256: "a".repeat(64),
  length: 1234,
  archiveFile: `${baseTarget.id}.jpg`,
  rightsBasis: "basis",
  rightsConfirmedAt: "2026-07-13",
  ...overrides,
});

test("a new record takes its citation from the canonical source atom, not the queue", () => {
  const record = project({ existing: undefined });
  assert.equal(record.reference, atom.reference);
  assert.equal(record.source, atom.source);
});

test("a re-import never rewrites an existing record's citation", () => {
  const record = project({ existing: { id: baseTarget.id, source: "Reviewed source", reference: "Reviewed reference" } });
  assert.equal(record.reference, "Reviewed reference");
  assert.equal(record.source, "Reviewed source");
});

test("the queue citation remains the fallback when no source atom exists", () => {
  const record = project({ atom: undefined });
  assert.equal(record.reference, baseTarget.reference);
  assert.equal(record.source, baseTarget.source);
});

test("a re-import keeps an approved viewer's reviewed presentation and approval date", () => {
  const reviewed = {
    approved: true,
    approvedAt: "2026-08-01",
    titleMode: "people",
    description: "Reviewed description.",
    blobPath: "records/old/original.jpg",
  };
  const record = project({ existing: { id: baseTarget.id, viewer: reviewed } });
  assert.equal(record.viewer.description, "Reviewed description.");
  assert.equal(record.viewer.approvedAt, "2026-08-01");
  assert.equal(record.viewer.blobPath, `records/${baseTarget.id}/original.jpg`);
});

test("a newly published record takes the queue viewer", () => {
  const record = project({ existing: { id: baseTarget.id } });
  assert.deepEqual(record.viewer, {
    approved: true,
    approvedAt: "2026-07-14",
    titleMode: "people",
    description: "Stale queue description.",
    blobPath: `records/${baseTarget.id}/original.jpg`,
  });
});

test("an unpublished or ineligible record loses its viewer", () => {
  const existing = { id: baseTarget.id, viewer: { approved: true, description: "Reviewed." } };
  assert.equal(project({ existing, target: { ...baseTarget, viewerPublishState: "withheld-control" } }).viewer, undefined);
  assert.equal(project({ existing, target: { ...baseTarget, publishEligible: false } }).viewer, undefined);
});

test("custody fields always come from the current master", () => {
  const record = project({ existing: { id: baseTarget.id, sha256: "b".repeat(64), length: 1 } });
  assert.equal(record.sha256, "a".repeat(64));
  assert.equal(record.length, 1234);
  assert.equal(record.archivePath, `FamilyHistorySourceMasters/${baseTarget.id}.jpg`);
});
