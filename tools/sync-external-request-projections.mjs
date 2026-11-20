#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deriveExternalRequest, projectExternalRequestOntoRoute } from "./external-request-store.mjs";
import { entityMap, loadResearchStore, projectRoot, readJson, serializeJson } from "./research-store.mjs";

const store = loadResearchStore();
const requests = entityMap(store.externalRequests, "id", "external request");
const checkOnly = process.argv.includes("--check");
let changed = 0;
for (const target of store.acquisitionTargets) {
  let dirty = false;
  for (const route of target.routes || []) {
    if (!route.requestId) continue;
    const request = requests.get(route.requestId);
    if (!request) throw new Error(`${target.id}/${route.id} references missing request ${route.requestId}`);
    const projectedRoute = structuredClone(route);
    projectExternalRequestOntoRoute(projectedRoute, request);
    const derived = { routeStatus: projectedRoute.status };
    const projection = projectedRoute.requestProjection;
    if (route.status !== derived.routeStatus
        || route.confirmationPhrase !== request.guard.requiredPhrase
        || route.authorization
        || JSON.stringify(route.requestProjection) !== JSON.stringify(projection)) {
      route.status = projectedRoute.status;
      route.confirmationPhrase = request.guard.requiredPhrase;
      delete route.authorization;
      route.requestProjection = projection;
      dirty = true;
    }
  }
  if (dirty) {
    if (!checkOnly) fs.writeFileSync(target.__file, serializeJson(target));
    changed += 1;
  }
}

const queueFile = path.join(projectRoot, "evidence", "tlcpl", "scan-queue.json");
const queue = readJson(queueFile);
const requestStatusView = (queue.requestBatches || []).map((batch) => {
  const request = requests.get(batch.externalRequestId || batch.slug);
  if (!request) throw new Error(`TLCPL batch ${batch.slug} has no external request`);
  const derived = deriveExternalRequest(request);
  return { slug: batch.slug, operationalState: derived.operationalState, revision: request.revision };
});
if (JSON.stringify(queue.requestStatusView) !== JSON.stringify(requestStatusView)) {
  queue.requestStatusView = requestStatusView;
  if (!checkOnly) fs.writeFileSync(queueFile, serializeJson(queue));
  changed += 1;
}
if (checkOnly && changed) {
  console.error(`external request projections are stale in ${changed} file(s); run npm run research:requests:sync`);
  process.exit(1);
}
console.log(`external request projections ${checkOnly ? "ok" : "synchronized"} (${changed} file(s) changed)`);
if (!checkOnly) {
  // Request state is projected into acquisition targets, which in turn feed
  // the generated acquisition-session queue. Rebuild every research view in
  // the same mutation so an otherwise valid request event cannot leave the
  // exact committed handoff stale.
  execFileSync(process.execPath, [path.join(projectRoot, "tools", "build-research-system.mjs"), "--write"], {
    cwd: projectRoot,
    stdio: "inherit"
  });
}
