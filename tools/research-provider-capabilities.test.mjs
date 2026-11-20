import assert from "node:assert/strict";
import test from "node:test";

import {
  implementedResearchProviders,
  isResearchProviderHostAllowed,
  loadResearchProviderCapabilities,
  researchProviderCapability,
  validateResearchProviderCapabilities,
} from "./research-provider-capabilities.mjs";
import { validateResearchBatchPlan } from "./research-browser-batch-lib.mjs";

test("the versioned registry separates implemented adapters from route scaffolds", () => {
  const registry = loadResearchProviderCapabilities({ fresh: true });
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.coverageContractVersion, 1);
  assert.deepEqual(implementedResearchProviders(registry).map((provider) => provider.id), [
    "ancestry",
    "antenati",
    "findmypast",
    "familysearch",
    "pcusa",
    "ava",
    "archion",
  ]);
  for (const providerId of [
    "msa-guide",
    "mdlandrec",
    "staffs-name-indexes",
    "staffs-history",
    "tna-discovery",
    "freebmd",
    "freereg",
    "freecen",
  ]) {
    assert.equal(researchProviderCapability(providerId, registry).browserBatch.state, "scaffold", providerId);
  }
});

test("registry host rules preserve domains without accepting lookalikes", () => {
  const registry = loadResearchProviderCapabilities();
  assert.equal(isResearchProviderHostAllowed("ancestry", "www.ancestry.com", registry), true);
  assert.equal(isResearchProviderHostAllowed("ancestry", "search.ancestry.co.uk", registry), true);
  assert.equal(isResearchProviderHostAllowed("ancestry", "ancestry.example.com", registry), false);
  assert.equal(isResearchProviderHostAllowed("pcusa", "catalog.history.pcusa.org", registry), true);
  assert.equal(isResearchProviderHostAllowed("pcusa", "other.history.pcusa.org", registry), false);
  assert.equal(isResearchProviderHostAllowed("archion", "www.archion.de", registry), true);
  assert.equal(isResearchProviderHostAllowed("archion", "shop.archion.de", registry), false);
  assert.equal(isResearchProviderHostAllowed("archion", "www.archion.de.example.com", registry), false);
});

test("remaining scaffolded providers cannot be executed through the existing batch runner", () => {
  const input = {
    schemaVersion: 1,
    provider: "msa-guide",
    affinitySlot: "msa-test",
    research: { questionId: "rq-example", actionId: "search-example", coverage: "one register" },
    steps: [{ id: "series", operation: "series-results", url: "https://guide.msa.maryland.gov/" }],
  };
  assert.throws(
    () => validateResearchBatchPlan(input, { checkCanonical: false }),
    /scaffolded but has no implemented read-only browser batch adapter/
  );
});

test("registry validation forbids mutable entitlement and secret state", () => {
  const registry = structuredClone(loadResearchProviderCapabilities());
  registry.providers[0].browserBatch.entitlement = { active: true };
  assert.throws(() => validateResearchProviderCapabilities(registry), /Mutable entitlement or secret field is forbidden/);

  const secretRegistry = structuredClone(loadResearchProviderCapabilities());
  secretRegistry.providers[0].credential = "not-allowed";
  assert.throws(() => validateResearchProviderCapabilities(secretRegistry), /Mutable entitlement or secret field is forbidden/);
});

test("implemented registry operations retain exact route policies", () => {
  const ancestry = researchProviderCapability("ancestry");
  assert.deepEqual(
    ancestry.browserBatch.operations.map((operation) => [operation.id, operation.routePolicy]),
    [
      ["search-results", "provider-read-route"],
      ["public-tree-results", "ancestry-public-tree-results"],
      ["public-tree-person", "ancestry-public-tree-person"],
      ["record-facts", "ancestry-record"],
    ]
  );

  const weakened = structuredClone(loadResearchProviderCapabilities());
  weakened.providers.find((provider) => provider.id === "ancestry")
    .browserBatch.operations.find((operation) => operation.id === "record-facts").routePolicy = "provider-read-route";
  assert.throws(
    () => validateResearchProviderCapabilities(weakened),
    /operations do not match the implemented adapter contract/
  );

  const broadened = structuredClone(loadResearchProviderCapabilities());
  broadened.providers.find((provider) => provider.id === "pcusa")
    .browserBatch.hosts.push({ kind: "domain", value: "history.pcusa.org" });
  assert.throws(
    () => validateResearchProviderCapabilities(broadened),
    /hosts do not match the implemented adapter contract/
  );

  const archion = researchProviderCapability("archion");
  assert.deepEqual(archion.browserBatch, {
    state: "implemented",
    transport: "windows-shared-chrome",
    hosts: [{ kind: "exact", value: "www.archion.de" }],
    operations: [{ id: "catalog-results", routePolicy: "archion-braunschweig-catalog" }],
  });
});
