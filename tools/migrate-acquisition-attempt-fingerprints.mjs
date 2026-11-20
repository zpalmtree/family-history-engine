#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquisitionAttemptFingerprint } from "./acquisition-attempt-fingerprint.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";

export function migrateTargetAttempts(target) {
  let changed = 0;
  const seen = new Set();
  for (const route of target.routes || []) {
    for (let index = 0; index < (route.attempts || []).length; index += 1) {
      const attempt = route.attempts[index];
      const input = {
        targetId: target.id,
        routeId: route.id,
        outcome: attempt.outcome,
        note: attempt.note,
        coverage: attempt.scope?.coverage,
        coverageDetails: attempt.scope?.coverageContractVersion === 1 ? attempt.scope : undefined,
        candidateUrls: attempt.candidateUrls,
      };
      let fingerprint = acquisitionAttemptFingerprint(input);
      if (seen.has(fingerprint)) {
        fingerprint = acquisitionAttemptFingerprint({ ...input, legacySalt: `${attempt.attemptedAt || "unknown-time"}:${index}` });
        if (attempt.fingerprintBasis !== "legacy-v1-attempted-at") {
          attempt.fingerprintBasis = "legacy-v1-attempted-at";
          changed += 1;
        }
      }
      seen.add(fingerprint);
      if (attempt.fingerprint !== fingerprint && !/^[0-9a-f]{64}$/.test(attempt.fingerprint || "")) {
        if (attempt.fingerprint) attempt.legacyFingerprint = attempt.fingerprint;
        attempt.fingerprint = fingerprint;
        changed += 1;
      }
      if (!attempt.id) {
        attempt.id = `attempt-${fingerprint.slice(0, 16)}`;
        changed += 1;
      }
    }
  }
  return changed;
}

function main() {
  const check = process.argv.includes("--check");
  const directory = path.resolve("evidence/acquisition/targets");
  let changedFiles = 0;
  let changedFields = 0;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
    const file = path.join(directory, name);
    const target = JSON.parse(fs.readFileSync(file, "utf8"));
    const changed = migrateTargetAttempts(target);
    if (!changed) continue;
    changedFiles += 1;
    changedFields += changed;
    if (!check) writeJsonAtomic(file, target);
  }
  if (check && changedFiles) throw new Error(`${changedFiles} acquisition target file(s) need stable attempt fingerprints/IDs`);
  console.log(`${check ? "checked" : "migrated"} acquisition attempt identity: ${changedFiles} file(s), ${changedFields} field change(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
