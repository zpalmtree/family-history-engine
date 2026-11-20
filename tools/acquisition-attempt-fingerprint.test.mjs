import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { acquisitionAttemptFingerprint } from "./acquisition-attempt-fingerprint.mjs";
import { migrateTargetAttempts } from "./migrate-acquisition-attempt-fingerprints.mjs";

test("acquisition fingerprints normalize recorder aliases and bounded coverage", () => {
  const shared = { targetId: "target", routeId: "route", note: " same   note ", coverage: " Page 1 ", candidateUrls: ["https://example.test/b", "https://example.test/a"] };
  assert.equal(
    acquisitionAttemptFingerprint({ ...shared, outcome: "retryable-error" }),
    acquisitionAttemptFingerprint({ ...shared, outcome: "error-retryable", candidateUrls: [...shared.candidateUrls].reverse() }),
  );
});

test("legacy acquisition attempts gain stable IDs without losing an old fingerprint", () => {
  const target = { id: "target", routes: [{ id: "route", attempts: [
    { attemptedAt: "2026-01-01T00:00:00Z", outcome: "alternate-provider", note: "same", fingerprint: "old-label" },
    { attemptedAt: "2026-01-02T00:00:00Z", outcome: "alternate-provider", note: "same" },
  ] }] };
  assert.ok(migrateTargetAttempts(target) > 0);
  const [first, second] = target.routes[0].attempts;
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.legacyFingerprint, "old-label");
  assert.match(first.id, /^attempt-[0-9a-f]{16}$/);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(second.fingerprintBasis, "legacy-v1-attempted-at");
  assert.equal(migrateTargetAttempts(target), 0);
});

test("official Archion candidate routes are accepted without allowing arbitrary subdomains", () => {
  const source = fs.readFileSync(new URL("./record-acquisition-attempt.mjs", import.meta.url), "utf8");
  assert.match(source, /hostname === "www\.archion\.de"/);
  assert.doesNotMatch(source, /endsWith\("\.archion\.de"\)/);
});

test("official Landesarchiv and Archives of Michigan candidate routes are exact-allowlisted", () => {
  const source = fs.readFileSync(new URL("./record-acquisition-attempt.mjs", import.meta.url), "utf8");
  assert.match(source, /hostname === "www\.landesarchiv-bw\.de"/);
  assert.match(source, /hostname === "www2\.landesarchiv-bw\.de"/);
  assert.match(source, /hostname === "michigan\.access\.preservica\.com"/);
  assert.doesNotMatch(source, /endsWith\("\.preservica\.com"\)/);
  assert.doesNotMatch(source, /endsWith\("\.landesarchiv-bw\.de"\)/);
});
