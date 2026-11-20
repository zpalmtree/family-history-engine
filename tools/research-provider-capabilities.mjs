import fs from "node:fs";

const DEFAULT_REGISTRY_URL = new URL("./research-provider-capabilities.json", import.meta.url);
const TOP_FIELDS = new Set(["schemaVersion", "registryVersion", "coverageContractVersion", "providers"]);
const PROVIDER_FIELDS = new Set(["id", "label", "accessClass", "capabilities", "browserBatch"]);
const BROWSER_FIELDS = new Set(["state", "transport", "hosts", "operations"]);
const HOST_FIELDS = new Set(["kind", "value"]);
const OPERATION_FIELDS = new Set(["id", "routePolicy"]);
const ACCESS_CLASSES = new Set(["free", "free-account", "subscription", "mixed"]);
const BROWSER_STATES = new Set(["implemented", "scaffold"]);
const HOST_KINDS = new Set(["exact", "domain"]);
const ROUTE_POLICIES = new Set([
  "provider-read-route",
  "ancestry-record",
  "ancestry-public-tree-results",
  "ancestry-public-tree-person",
  "antenati-register-ark",
  "findmypast-transcript",
  "findmypast-newspaper-results",
  "familysearch-image-metadata",
  "pcusa-catalog-results",
  "pcusa-catalog-detail",
  "pcusa-catalog-marc",
  "pcusa-digital-context",
  "ava-index-document",
  "archion-braunschweig-catalog",
  "scaffold",
]);
const IMPLEMENTED_BROWSER_CONTRACTS = Object.freeze({
  ancestry: {
    hosts: ["domain:ancestry.com", "domain:ancestry.co.uk"],
    operations: [
      "search-results:provider-read-route",
      "public-tree-results:ancestry-public-tree-results",
      "public-tree-person:ancestry-public-tree-person",
      "record-facts:ancestry-record",
    ],
  },
  antenati: {
    hosts: ["domain:antenati.cultura.gov.it"],
    operations: ["registry-context:antenati-register-ark"],
  },
  findmypast: {
    hosts: ["domain:findmypast.com", "domain:findmypast.co.uk"],
    operations: [
      "findmypast-row:provider-read-route",
      "findmypast-transcript:findmypast-transcript",
      "findmypast-newspaper-results:findmypast-newspaper-results",
    ],
  },
  familysearch: {
    hosts: ["domain:familysearch.org"],
    operations: [
      "fulltext-search:provider-read-route",
      "record-facts:provider-read-route",
      "page-links:provider-read-route",
      "page-context:provider-read-route",
      "viewer-metadata:familysearch-image-metadata",
    ],
  },
  pcusa: {
    hosts: ["exact:catalog.history.pcusa.org", "exact:digital.history.pcusa.org"],
    operations: [
      "catalog-results:pcusa-catalog-results",
      "catalog-detail:pcusa-catalog-detail",
      "catalog-marc:pcusa-catalog-marc",
      "digital-context:pcusa-digital-context",
    ],
  },
  ava: {
    hosts: ["exact:ava.fidlar.com"],
    operations: ["document-search:ava-index-document", "document-image-context:ava-index-document"],
  },
  archion: {
    hosts: ["exact:www.archion.de"],
    operations: ["catalog-results:archion-braunschweig-catalog"],
  },
});
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MUTABLE_OR_SECRET_KEY = /(credential|secret|token|cookie|password|passphrase|\bpin\b|cvv|cvc|card|entitlement|access[-_]?expires|subscription[-_]?expires|session[-_]?state|sign[-_]?in[-_]?state|logged[-_]?in|current[-_]?quota)/i;

let defaultRegistry;

export function loadResearchProviderCapabilities({ file = DEFAULT_REGISTRY_URL, fresh = false } = {}) {
  if (!fresh && file === DEFAULT_REGISTRY_URL && defaultRegistry) return defaultRegistry;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const registry = validateResearchProviderCapabilities(raw);
  if (file === DEFAULT_REGISTRY_URL) defaultRegistry = registry;
  return registry;
}

export function validateResearchProviderCapabilities(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The research provider capability registry must be one JSON object.");
  }
  rejectMutableOrSecretKeys(input);
  rejectUnknownFields(input, TOP_FIELDS, "registry");
  if (input.schemaVersion !== 1) throw new Error("Provider capability schemaVersion must be exactly 1.");
  if (typeof input.registryVersion !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.registryVersion)) {
    throw new Error("Provider capability registryVersion must be an ISO date.");
  }
  if (input.coverageContractVersion !== 1) {
    throw new Error("Provider capability coverageContractVersion must be exactly 1.");
  }
  if (!Array.isArray(input.providers) || !input.providers.length) {
    throw new Error("Provider capability providers must be a non-empty array.");
  }

  const providerIds = new Set();
  const providers = input.providers.map((provider, index) => validateProvider(provider, index, providerIds));
  return deepFreeze({
    schemaVersion: 1,
    registryVersion: input.registryVersion,
    coverageContractVersion: 1,
    providers,
  });
}

function validateProvider(provider, index, providerIds) {
  const label = `providers[${index}]`;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error(`${label} must be an object.`);
  rejectUnknownFields(provider, PROVIDER_FIELDS, label);
  if (!ID_PATTERN.test(provider.id || "")) throw new Error(`${label}.id is invalid.`);
  if (providerIds.has(provider.id)) throw new Error(`Duplicate provider id: ${provider.id}.`);
  providerIds.add(provider.id);
  if (typeof provider.label !== "string" || !provider.label.trim() || provider.label.length > 100) {
    throw new Error(`${label}.label must be 1 through 100 characters.`);
  }
  if (!ACCESS_CLASSES.has(provider.accessClass)) throw new Error(`${label}.accessClass is invalid.`);
  if (!Array.isArray(provider.capabilities) || !provider.capabilities.length
      || provider.capabilities.some((capability) => !OPERATION_PATTERN.test(capability || ""))) {
    throw new Error(`${label}.capabilities must be a non-empty array of stable identifiers.`);
  }
  if (new Set(provider.capabilities).size !== provider.capabilities.length) {
    throw new Error(`${label}.capabilities contains duplicates.`);
  }
  const browserBatch = validateBrowserBatch(provider.browserBatch, label, provider.id);
  return {
    id: provider.id,
    label: provider.label.trim(),
    accessClass: provider.accessClass,
    capabilities: [...provider.capabilities],
    browserBatch,
  };
}

function validateBrowserBatch(browserBatch, providerLabel, providerId) {
  const label = `${providerLabel}.browserBatch`;
  if (!browserBatch || typeof browserBatch !== "object" || Array.isArray(browserBatch)) {
    throw new Error(`${label} must be an object.`);
  }
  rejectUnknownFields(browserBatch, BROWSER_FIELDS, label);
  if (!BROWSER_STATES.has(browserBatch.state)) throw new Error(`${label}.state must be implemented or scaffold.`);
  if (browserBatch.transport !== "windows-shared-chrome") {
    throw new Error(`${label}.transport must be windows-shared-chrome.`);
  }
  if (!Array.isArray(browserBatch.hosts) || !browserBatch.hosts.length) {
    throw new Error(`${label}.hosts must be a non-empty array.`);
  }
  const hostKeys = new Set();
  const hosts = browserBatch.hosts.map((host, index) => {
    const hostLabel = `${label}.hosts[${index}]`;
    if (!host || typeof host !== "object" || Array.isArray(host)) throw new Error(`${hostLabel} must be an object.`);
    rejectUnknownFields(host, HOST_FIELDS, hostLabel);
    const value = String(host.value || "").toLocaleLowerCase();
    if (!HOST_KINDS.has(host.kind) || !HOST_PATTERN.test(value)) throw new Error(`${hostLabel} is invalid.`);
    const key = `${host.kind}:${value}`;
    if (hostKeys.has(key)) throw new Error(`${label}.hosts contains duplicate ${key}.`);
    hostKeys.add(key);
    return { kind: host.kind, value };
  });
  if (!Array.isArray(browserBatch.operations) || !browserBatch.operations.length) {
    throw new Error(`${label}.operations must be a non-empty array.`);
  }
  const operationIds = new Set();
  const operations = browserBatch.operations.map((operation, index) => {
    const operationLabel = `${label}.operations[${index}]`;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error(`${operationLabel} must be an object.`);
    rejectUnknownFields(operation, OPERATION_FIELDS, operationLabel);
    if (!OPERATION_PATTERN.test(operation.id || "")) throw new Error(`${operationLabel}.id is invalid.`);
    if (operationIds.has(operation.id)) throw new Error(`${label}.operations contains duplicate ${operation.id}.`);
    operationIds.add(operation.id);
    if (!ROUTE_POLICIES.has(operation.routePolicy)) throw new Error(`${operationLabel}.routePolicy is invalid.`);
    if (browserBatch.state === "implemented" && operation.routePolicy === "scaffold") {
      throw new Error(`${operationLabel} cannot use a scaffold route policy when implemented.`);
    }
    if (browserBatch.state === "scaffold" && operation.routePolicy !== "scaffold") {
      throw new Error(`${operationLabel} must remain scaffold-only until its adapter is implemented.`);
    }
    return { id: operation.id, routePolicy: operation.routePolicy };
  });
  const normalized = { state: browserBatch.state, transport: browserBatch.transport, hosts, operations };
  if (normalized.state === "implemented") validateImplementedBrowserContract(providerId, normalized, label);
  return normalized;
}

function validateImplementedBrowserContract(providerId, browserBatch, label) {
  const expected = IMPLEMENTED_BROWSER_CONTRACTS[providerId];
  if (!expected) throw new Error(`${label} cannot be implemented until its browser adapter contract is registered in code.`);
  const actualHosts = browserBatch.hosts.map((host) => `${host.kind}:${host.value}`).sort();
  const expectedHosts = [...expected.hosts].sort();
  if (JSON.stringify(actualHosts) !== JSON.stringify(expectedHosts)) {
    throw new Error(`${label}.browserBatch hosts do not match the implemented adapter contract.`);
  }
  const actualOperations = browserBatch.operations.map((operation) => `${operation.id}:${operation.routePolicy}`).sort();
  const expectedOperations = [...expected.operations].sort();
  if (JSON.stringify(actualOperations) !== JSON.stringify(expectedOperations)) {
    throw new Error(`${label}.browserBatch operations do not match the implemented adapter contract.`);
  }
}

export function researchProviderCapability(providerId, registry = loadResearchProviderCapabilities()) {
  const provider = registry.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(`Unknown research provider capability: ${providerId}.`);
  return provider;
}

export function researchProviderOperation(providerId, operationId, registry = loadResearchProviderCapabilities()) {
  const provider = researchProviderCapability(providerId, registry);
  const operation = provider.browserBatch.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error(`Unknown research provider operation: ${providerId}/${operationId}.`);
  return operation;
}

export function implementedResearchProviders(registry = loadResearchProviderCapabilities()) {
  return registry.providers.filter((provider) => provider.browserBatch.state === "implemented");
}

export function isResearchProviderHostAllowed(providerId, hostname, registry = loadResearchProviderCapabilities()) {
  const provider = researchProviderCapability(providerId, registry);
  const normalized = String(hostname || "").toLocaleLowerCase().replace(/\.$/, "");
  return provider.browserBatch.hosts.some((host) => host.kind === "exact"
    ? normalized === host.value
    : normalized === host.value || normalized.endsWith(`.${host.value}`));
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}.`);
}

function rejectMutableOrSecretKeys(value, trail = "registry") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (MUTABLE_OR_SECRET_KEY.test(key)) {
      throw new Error(`Mutable entitlement or secret field is forbidden in provider capabilities: ${trail}.${key}.`);
    }
    rejectMutableOrSecretKeys(child, `${trail}.${key}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
