import {
  isResearchProviderHostAllowed,
  loadResearchProviderCapabilities,
  researchProviderCapability,
  researchProviderOperation,
} from "./research-provider-capabilities.mjs";

const RESULT_FIELDS = new Set(["schemaVersion", "provider", "operation", "status", "candidates", "coverage", "gate", "errorCode"]);
const CANDIDATE_FIELDS = new Set(["url", "text", "label"]);
const COVERAGE_FIELDS = new Set([
  "scope",
  "paginationComplete",
  "truncated",
  "providerCoverageVerified",
  "verificationBasis",
]);
const GATE_FIELDS = new Set(["actor", "reason", "retryWhen"]);
const RESULT_STATUSES = new Set(["completed", "needs-user", "waiting-external", "waiting-system", "retryable-error"]);
const GATE_ACTORS = new Set(["user", "external", "system"]);
const SENSITIVE_KEY = /(password|passphrase|pin|cvv|cvc|card|cookie|authorization|secret|token|credential|email|phone|address)/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function normalizeProviderAdapterResult(input, { registry = loadResearchProviderCapabilities() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provider adapter result must be one object.");
  rejectSensitiveKeys(input);
  rejectUnknownFields(input, RESULT_FIELDS, "provider adapter result");
  if (input.schemaVersion !== 1) throw new Error("Provider adapter result schemaVersion must be exactly 1.");
  const provider = researchProviderCapability(input.provider, registry);
  const operation = researchProviderOperation(provider.id, input.operation, registry);
  if (!RESULT_STATUSES.has(input.status)) throw new Error("Provider adapter result status is invalid.");

  const candidates = normalizeCandidates(input.candidates || [], provider, registry);
  const coverage = input.coverage === undefined ? undefined : normalizeProviderCoverage(input.coverage);
  const gate = input.gate === undefined ? undefined : normalizeGate(input.gate);
  const errorCode = input.errorCode === undefined ? undefined : normalizeIdentifier(input.errorCode, "errorCode");

  if (input.status === "completed" && !coverage) throw new Error("Completed provider adapter results require structured coverage.");
  if (input.status !== "completed" && candidates.length) throw new Error("Only completed provider adapter results may contain candidates.");
  if (input.status === "needs-user" && gate?.actor !== "user") throw new Error("needs-user provider results require a user gate.");
  if (input.status === "waiting-external" && gate?.actor !== "external") throw new Error("waiting-external provider results require an external gate.");
  if (input.status === "waiting-system" && gate?.actor !== "system") throw new Error("waiting-system provider results require a system gate.");
  if (["completed", "retryable-error"].includes(input.status) && gate) {
    throw new Error(`${input.status} provider results must not contain a gate.`);
  }
  if (input.status === "retryable-error" && !errorCode) throw new Error("retryable-error provider results require errorCode.");
  if (input.status !== "retryable-error" && errorCode) throw new Error("Only retryable-error provider results may contain errorCode.");

  return {
    schemaVersion: 1,
    provider: provider.id,
    operation: operation.id,
    status: input.status,
    candidates,
    ...(coverage ? { coverage } : {}),
    ...(gate ? { gate } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function normalizeProviderCoverage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provider coverage must be one object.");
  rejectSensitiveKeys(input, "coverage");
  rejectUnknownFields(input, COVERAGE_FIELDS, "coverage");
  const scope = normalizedText(input.scope, "coverage.scope", 1_000);
  for (const field of ["paginationComplete", "truncated", "providerCoverageVerified"]) {
    if (typeof input[field] !== "boolean") throw new Error(`coverage.${field} must be boolean.`);
  }
  const verificationBasis = input.verificationBasis === undefined
    ? ""
    : normalizedText(input.verificationBasis, "coverage.verificationBasis", 1_000);
  if (input.providerCoverageVerified && !verificationBasis) {
    throw new Error("Verified provider coverage requires coverage.verificationBasis.");
  }
  return {
    scope,
    paginationComplete: input.paginationComplete,
    truncated: input.truncated,
    providerCoverageVerified: input.providerCoverageVerified,
    ...(verificationBasis ? { verificationBasis } : {}),
  };
}

export function boundedNegativeEligibility(input, options) {
  let result;
  try {
    result = normalizeProviderAdapterResult(input, options);
  } catch (error) {
    return { eligible: false, reasons: [`invalid-adapter-result: ${safeError(error)}`] };
  }
  const reasons = [];
  if (result.status !== "completed") reasons.push("adapter-did-not-complete");
  if (result.candidates.length) reasons.push("candidate-results-exist");
  if (!result.coverage?.paginationComplete) reasons.push("pagination-incomplete-or-unknown");
  if (result.coverage?.truncated !== false) reasons.push("result-set-truncated-or-unknown");
  if (!result.coverage?.providerCoverageVerified) reasons.push("provider-coverage-unverified");
  if (!result.coverage?.verificationBasis) reasons.push("coverage-verification-basis-missing");
  return { eligible: reasons.length === 0, reasons, result };
}

export function assertBoundedNegativeEligible(input, options) {
  const assessment = boundedNegativeEligibility(input, options);
  if (!assessment.eligible) {
    throw new Error(`not-found-bounded requires complete, untruncated, verified provider coverage: ${assessment.reasons.join(", ")}`);
  }
  return assessment.result;
}

export function boundedNegativeAttemptFromAdapterResult(input, options) {
  const result = assertBoundedNegativeEligible(input, options);
  return {
    outcome: "not-found-bounded",
    scope: {
      coverageContractVersion: 1,
      coverage: result.coverage.scope,
      paginationComplete: true,
      truncated: false,
      providerCoverageVerified: true,
      verificationBasis: result.coverage.verificationBasis,
    },
  };
}

export function isVerifiedBoundedNegativeAttempt(attempt) {
  if (!attempt || !["not-found", "not-found-bounded"].includes(attempt.outcome)) return false;
  const coverage = attempt.scope;
  return coverage?.coverageContractVersion === 1
    && typeof coverage.coverage === "string"
    && Boolean(coverage.coverage.trim())
    && coverage.paginationComplete === true
    && coverage.truncated === false
    && coverage.providerCoverageVerified === true
    && typeof coverage.verificationBasis === "string"
    && Boolean(coverage.verificationBasis.trim());
}

export function verifiedBoundedCoverage({ coverage, verificationBasis }) {
  return {
    coverageContractVersion: 1,
    coverage: normalizedText(coverage, "coverage", 1_000),
    paginationComplete: true,
    truncated: false,
    providerCoverageVerified: true,
    verificationBasis: normalizedText(verificationBasis, "verificationBasis", 1_000),
  };
}

function normalizeCandidates(candidates, provider, registry) {
  if (!Array.isArray(candidates) || candidates.length > 1_000) {
    throw new Error("Provider adapter candidates must be an array of at most 1000 items.");
  }
  const seen = new Set();
  const normalized = [];
  for (const [index, candidate] of candidates.entries()) {
    const label = `candidates[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${label} must be an object.`);
    rejectUnknownFields(candidate, CANDIDATE_FIELDS, label);
    const text = candidate.text === undefined ? "" : normalizedText(candidate.text, `${label}.text`, 12_000);
    const candidateLabel = candidate.label === undefined ? "" : normalizedText(candidate.label, `${label}.label`, 500);
    let url = "";
    if (candidate.url !== undefined) {
      const parsed = new URL(candidate.url);
      if (parsed.protocol !== "https:") throw new Error(`${label}.url must use HTTPS.`);
      if (!isResearchProviderHostAllowed(provider.id, parsed.hostname, registry)) {
        throw new Error(`${label}.url is outside the ${provider.id} provider hosts.`);
      }
      if (parsed.username || parsed.password) throw new Error(`${label}.url must not contain credentials.`);
      for (const key of [...parsed.searchParams.keys()]) if (SENSITIVE_KEY.test(key)) parsed.searchParams.delete(key);
      url = parsed.toString();
    }
    if (!url && !text && !candidateLabel) throw new Error(`${label} must contain url, text, or label.`);
    const key = `${url}\u0000${text}\u0000${candidateLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...(url ? { url } : {}), ...(text ? { text } : {}), ...(candidateLabel ? { label: candidateLabel } : {}) });
  }
  return normalized;
}

function normalizeGate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provider adapter gate must be one object.");
  rejectSensitiveKeys(input, "gate");
  rejectUnknownFields(input, GATE_FIELDS, "gate");
  if (!GATE_ACTORS.has(input.actor)) throw new Error("gate.actor must be user, external, or system.");
  return {
    actor: input.actor,
    reason: normalizeIdentifier(input.reason, "gate.reason"),
    retryWhen: normalizedText(input.retryWhen, "gate.retryWhen", 500),
  };
}

function normalizeIdentifier(value, label) {
  if (!ID_PATTERN.test(value || "")) throw new Error(`${label} must be a stable lowercase identifier.`);
  return value;
}

function normalizedText(value, label, maximum) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} must be 1 through ${maximum} characters.`);
  return normalized;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}.`);
}

function rejectSensitiveKeys(value, trail = "result") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Sensitive field is forbidden in provider adapter result: ${trail}.${key}.`);
    rejectSensitiveKeys(child, `${trail}.${key}`);
  }
}

function safeError(error) {
  return String(error?.message || error).replace(/\s+/g, " ").trim().slice(0, 500);
}
