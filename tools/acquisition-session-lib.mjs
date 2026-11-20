import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { acquisitionTargetStatuses } from "./research-acquisition.mjs";
import { buildResearchProjections } from "./research-projections.mjs";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import { inResearchScope } from "./research-scope.mjs";

export const sessionPath = path.join(projectRoot, "evidence", "acquisition-session-queue.json");

export const actionableStatuses = new Set([
  "archived-pending-upload",
  "needs-locator",
  "queued-search",
  "needs-result-review",
  "ready-download",
  "reply-triage",
  "ready-subscription-capture",
  "retryable-error",
  "route-discovery"
]);

export const terminalStatuses = new Set(
  [...acquisitionTargetStatuses].filter((status) => !actionableStatuses.has(status))
);

export function buildAcquisitionSession() {
  const store = loadResearchStore();
  const manifest = readJson(path.join(projectRoot, "evidence", "records-manifest.json"));
  return buildResearchProjections(store, { manifest }).acquisitionSession;
}

export function writeAcquisitionSession(session = buildAcquisitionSession()) {
  writeJsonAtomic(sessionPath, session);
}

export function acquisitionTargetsForScope(session, scope) {
  return session.targets.filter((target) => inResearchScope(target, scope));
}

export function acquisitionTargetIdsForScope(session, scope) {
  return new Set(acquisitionTargetsForScope(session, scope).flatMap((target) => [
    target.id,
    target.sourceId,
    target.atomId,
    ...(target.routes || []).map((route) => route.id)
  ].filter(Boolean)));
}
