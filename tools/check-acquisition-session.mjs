#!/usr/bin/env node

import fs from "node:fs";
import { actionableStatuses, sessionPath, terminalStatuses } from "./acquisition-session-lib.mjs";

const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const family = JSON.parse(fs.readFileSync(new URL("../data/family/people.json", import.meta.url), "utf8"));
const personIds = new Set(family.people.map((person) => person.id));
const issues = [];
const ids = new Set();
const priorities = new Set(["P0", "P1", "P2", "P3"]);

if (session.schemaVersion !== 3 || !Array.isArray(session.targets)) issues.push("unsupported acquisition session ledger");
if (!Array.isArray(session.citationCoverage)) issues.push("citationCoverage must be an array");
if (JSON.stringify(session).match(/BLOB_READ_WRITE_TOKEN|password\s*[=:]|card(number)?\s*[=:]/i)) {
  issues.push("ledger contains a credential or payment-data marker");
}

for (const target of session.targets || []) {
  if (!target.id || ids.has(target.id)) issues.push(`invalid or duplicate target id: ${target.id || "(missing)"}`);
  ids.add(target.id);
  for (const field of ["sourceId", "sourceQueue", "provider", "route", "status", "artifactPurpose"]) {
    if (!target[field] || typeof target[field] !== "string") issues.push(`${target.id} is missing ${field}`);
  }
  if (!priorities.has(target.priority)) issues.push(`${target.id} has invalid priority: ${target.priority}`);
  if (!terminalStatuses.has(target.status) && !actionableStatuses.has(target.status)) {
    issues.push(`${target.id} has unsupported status: ${target.status}`);
  }
  if (!Array.isArray(target.people) || target.people.some((id) => !personIds.has(id))) {
    issues.push(`${target.id} links an unknown person`);
  }
  if (target.artifact) {
    if (!/^[a-f0-9]{64}$/.test(target.artifact.sha256 || "")) issues.push(`${target.id} artifact has invalid SHA-256`);
    if (!Number.isInteger(target.artifact.length) || target.artifact.length < 1) issues.push(`${target.id} artifact has invalid byte length`);
    if (target.status === "published" && target.artifact.viewerPublishState !== "published") {
      issues.push(`${target.id} is published without a published viewer artifact`);
    }
  } else if (["published", "preserved-withheld", "archived-pending-upload"].includes(target.status)) {
    issues.push(`${target.id} has artifact status without artifact metadata`);
  }
  if (!target.reconciliation || target.reconciliation.status !== target.status) {
    issues.push(`${target.id} has stale or missing reconciliation`);
  }
  if (!Array.isArray(target.routes)) issues.push(`${target.id} routes must be an array`);
  if (target.atomId !== target.sourceId) issues.push(`${target.id} has a stale compatibility atomId`);
  if (Object.hasOwn(target, "evidenceRole")) issues.push(`${target.id} retains a global evidenceRole`);
  if (target.status === "requires-user-action"
      && target.reconciliation?.reasonCode === "needs-submit-confirmation"
      && !target.routes.some((route) => route.status === "needs-submit-confirmation"
        && route.confirmationPhrase === `SUBMIT ${route.authorizationTargetId || target.id}`)) {
    issues.push(`${target.id} needs submission confirmation but has no exact phrase`);
  }
  if (target.status === "requires-user-action"
      && target.reconciliation?.reasonCode === "needs-purchase-confirmation"
      && !target.routes.some((route) => route.status === "needs-purchase-confirmation"
        && route.confirmationPhrase === `PAY ${target.id}`)) {
    issues.push(`${target.id} needs purchase confirmation but has no exact phrase`);
  }
}

const citationIds = new Set();
for (const citation of session.citationCoverage || []) {
  if (!citation.citationId || citationIds.has(citation.citationId)) issues.push(`invalid or duplicate citation id: ${citation.citationId}`);
  citationIds.add(citation.citationId);
  if (!new Set(["exactly-satisfied", "actionable-source-atoms", "explicit-gaps", "non-documentary"]).has(citation.status)) {
    issues.push(`${citation.citationId} has invalid exact coverage status: ${citation.status}`);
  }
  if (/inferred|semantic|no-stable-url/.test(JSON.stringify(citation))) {
    issues.push(`${citation.citationId} still relies on non-authoritative citation inference`);
  }
}
if (session.summary?.targetCount !== ids.size) issues.push("summary target count is stale");
if (session.summary?.citations?.total !== citationIds.size) issues.push("summary citation count is stale");

if (issues.length) {
  console.error(`acquisition session check failed:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
console.log(`acquisition session ok: ${ids.size} targets; ${citationIds.size} citations reconciled`);
