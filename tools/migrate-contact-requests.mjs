#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { externalRequestPayloadSha256 } from "./external-request-store.mjs";
import { entityMap, loadResearchStore } from "./research-store.mjs";

const store = loadResearchStore();
const requests = entityMap(store.externalRequests, "id", "external request");
const requestByRoute = new Map();
for (const request of store.externalRequests) for (const item of request.items || []) {
  requestByRoute.set(`${item.targetId}\0${item.routeId}`, request);
}
let migrated = 0;
for (const target of store.acquisitionTargets) {
  if (!target.contactRequest) continue;
  const matches = (target.routes || []).map((route) => ({
    route,
    request: route.requestId ? requests.get(route.requestId) : requestByRoute.get(`${target.id}\0${route.id}`)
  })).filter((item) => item.request);
  if (matches.length !== 1) throw new Error(`${target.id} contactRequest does not map to exactly one canonical request`);
  const { route, request } = matches[0];
  if (request.revision !== 0 || request.events.length) {
    throw new Error(`${request.id} has events; legacy payload migration would invalidate recorded history`);
  }
  request.spec = target.contactRequest;
  request.payloadSha256 = externalRequestPayloadSha256(request);
  route.requestId = request.id;
  delete target.contactRequest;
  writeJsonAtomic(request.__file, request);
  writeJsonAtomic(target.__file, target);
  migrated += 1;
}
execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { stdio: "inherit" });
console.log(`migrated ${migrated} legacy contact request payload(s)`);
