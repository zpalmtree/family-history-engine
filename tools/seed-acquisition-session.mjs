#!/usr/bin/env node

import fs from "node:fs";
import { buildAcquisitionSession, sessionPath, writeAcquisitionSession } from "./acquisition-session-lib.mjs";

const checkOnly = process.argv.includes("--check");
const existing = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : {};
const session = buildAcquisitionSession(existing);

if (checkOnly) {
  if (!fs.existsSync(sessionPath)) throw new Error("acquisition session ledger has not been generated");
  const comparable = (value) => JSON.stringify({ ...value, createdAt: undefined, updatedAt: undefined });
  if (comparable(existing) !== comparable(session)) {
    throw new Error("acquisition session ledger is stale; run npm run records:session:seed");
  }
  console.log(`acquisition session ledger is current: ${session.targets.length} targets`);
} else {
  writeAcquisitionSession(session);
  console.log(`seeded acquisition session ledger: ${session.targets.length} targets, ${session.citationCoverage.length} citations`);
}
