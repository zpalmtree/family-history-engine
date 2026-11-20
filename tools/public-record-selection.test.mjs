import test from "node:test";
import assert from "node:assert/strict";

import { blobPathFor, manifestViewerFor, publicationFacts, selectPendingPublicRecords } from "./public-record-publication.mjs";

const viewer = {
  titleMode: "people",
  titlePrincipals: [{ personId: "john-example", sourceAtomId: "deed" }],
  category: "Deed",
  titleQualifier: "Deed Record 27, 1844",
  description: "Deed.",
  date: "23 Nov 1844"
};

test("a canonical pending-upload target is selected even when the queue copy is stale", () => {
  const pending = selectPendingPublicRecords({
    queueTargets: [{ id: "deed", status: "acquired", viewerPublishState: "withheld-control" }],
    canonicalTargets: new Map([["deed", { id: "deed", viewerPublishState: "pending-upload", viewer }]]),
    manifestRecords: new Map([["deed", { id: "deed", sha256: "a", length: 1, mediaType: "application/pdf" }]])
  });
  assert.deepEqual(pending.map((entry) => entry.id), ["deed"]);
});

test("a stale queue pending flag does not override a canonical target that is already published", () => {
  const pending = selectPendingPublicRecords({
    queueTargets: [{ id: "deed", status: "acquired", viewerPublishState: "pending-upload", viewer }],
    canonicalTargets: new Map([["deed", { id: "deed", viewerPublishState: "published", viewer }]]),
    manifestRecords: new Map([["deed", { id: "deed" }]])
  });
  assert.equal(pending.length, 0);
});

test("records outside the public queue are never selected", () => {
  const pending = selectPendingPublicRecords({
    queueTargets: [],
    canonicalTargets: new Map([["fs", { id: "fs", viewerPublishState: "pending-upload", viewer }]]),
    manifestRecords: new Map([["fs", { id: "fs" }]])
  });
  assert.equal(pending.length, 0);
});

test("a selected record without a manifest entry is refused", () => {
  assert.throws(() => selectPendingPublicRecords({
    queueTargets: [{ id: "deed", status: "acquired" }],
    canonicalTargets: new Map([["deed", { id: "deed", viewerPublishState: "pending-upload", viewer }]]),
    manifestRecords: new Map()
  }), /no records-manifest entry/);
});

test("custody facts come from the manifest, not the queue copy", () => {
  const facts = publicationFacts({
    item: { id: "deed", sha256: "stale", peopleVerificationBasis: "old" },
    record: { id: "deed", sha256: "fresh", length: 9, mediaType: "application/pdf", rights: "family-viewer-approved", archivePath: "FamilyHistorySourceMasters/deed.pdf", peopleVerifiedAt: "2026-11-03", peopleVerificationBasis: "new" }
  });
  assert.equal(facts.sha256, "fresh");
  assert.equal(facts.archiveFile, "deed.pdf");
  assert.equal(facts.peopleVerificationBasis, "new");
});

test("the manifest viewer block uses the canonical structured presentation and drops a manual title", () => {
  const block = manifestViewerFor({
    canonical: { viewer: { ...viewer, title: "Manual title" } },
    item: { viewer: { title: "Stale queue title" } },
    record: { id: "deed", mediaType: "application/pdf" }
  }, "2026-11-03");
  assert.equal(block.title, undefined);
  assert.equal(block.titleMode, "people");
  assert.equal(block.approvedAt, "2026-11-03");
  assert.equal(block.blobPath, blobPathFor("deed", "application/pdf"));
  assert.equal(block.blobPath, "records/deed/original.pdf");
});

test("a published queue entry takes its people and reading from the manifest", async () => {
  const { queueFieldsFromManifest } = await import("./public-record-publication.mjs");
  const fields = queueFieldsFromManifest({ id: "deed", people: ["john-example"], reference: "new", peopleVerifiedAt: "2026-11-03", peopleVerificationBasis: "basis", sha256: "x" });
  assert.deepEqual(fields, { people: ["john-example"], reference: "new", peopleVerifiedAt: "2026-11-03", peopleVerificationBasis: "basis" });
});
