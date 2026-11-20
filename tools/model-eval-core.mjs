import crypto from "node:crypto";

export const OPERATIONS = Object.freeze([
  "orchestration-local",
  "narrative",
  "source-reading",
  "proof-reconciliation",
  "research-planning",
  "provider-results",
  "engineering",
  "acquisition-operations",
  "critical-side-effects"
]);
export const RISKS = Object.freeze(["R0", "R1", "R2", "R3"]);
export const MODALITIES = Object.freeze(["text", "image", "mixed"]);
export const CONTEXT_BANDS = Object.freeze(["small", "medium", "large"]);
export const DATA_CLASSES = Object.freeze(["public", "permitted-private", "provider-restricted", "secret"]);
export const VERDICTS = Object.freeze(["pass", "minor", "material-fail", "critical-fail", "ambiguous"]);
export const AGREEMENTS = Object.freeze(["exact", "substantive", "partial", "disagree", "not-compared"]);
export const ROUTE_MODES = Object.freeze(["reference-only", "review-required", "low-touch"]);

const OPERATION_SET = new Set(OPERATIONS);
const RISK_SET = new Set(RISKS);
const MODALITY_SET = new Set(MODALITIES);
const CONTEXT_SET = new Set(CONTEXT_BANDS);
const DATA_SET = new Set(DATA_CLASSES);
const VERDICT_SET = new Set(VERDICTS);
const AGREEMENT_SET = new Set(AGREEMENTS);
const ROUTE_MODE_SET = new Set(ROUTE_MODES);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(namespace, value) {
  return crypto.createHash("sha256").update(`${namespace}\0${canonicalJson(value)}`).digest("hex");
}

export function classifySchedulerSelection(parsed) {
  const kind = parsed?.kind;
  const actionKind = parsed?.item?.action?.kind || parsed?.item?.actionKind || parsed?.item?.kind;
  if (kind === "source-review") return classification("source-reading", "R2", "mixed", "canonical-read");
  if (["closure-review", "reopen-trigger", "origin-gap"].includes(kind)) {
    return classification("proof-reconciliation", "R2", "text", "canonical-read");
  }
  if (kind === "route-discovery") return classification("research-planning", "R2", "text", "canonical-read");
  if (kind === "question") {
    if (actionKind === "review") return classification("proof-reconciliation", "R2", "mixed", "canonical-read");
    if (actionKind === "search") return classification("provider-results", "R2", "mixed", "live-provider-read");
    if (actionKind === "acquisition") return classification("acquisition-operations", "R2", "mixed", "provider-read");
    if (["request", "purchase"].includes(actionKind)) {
      return classification("critical-side-effects", "R3", "mixed", "external-write");
    }
  }
  if (kind === "acquisition") {
    const text = canonicalJson(parsed.item).toLowerCase();
    const sideEffect = /(payment|purchase|submit|contact|sign.?in|auth|canonical mutation|write)/.test(text);
    return classification(sideEffect ? "critical-side-effects" : "acquisition-operations", sideEffect ? "R3" : "R2", "mixed", sideEffect ? "external-write" : "provider-read");
  }
  return classification("critical-side-effects", "R3", "mixed", "unknown");
}

function classification(operation, risk, modality, toolClass) {
  return { operation, risk, modality, toolClass };
}

export function buildTaskEnvelope({
  taskId,
  capturedAt,
  repoSha,
  scope = "main",
  native,
  operation,
  risk,
  modality = "text",
  contextBand = "medium",
  toolClass = "none",
  oracleClass = "human-rubric",
  dataClass = "permitted-private",
  instructionsVersion = "model-routing-v1",
  outputSchemaVersion = 1,
  inputRefs = [],
  allowedActions = ["read", "propose"],
  strata = [],
  summary
}) {
  const identity = {
    schemaVersion: 1, repoSha, scope, native, operation, risk, modality, contextBand, toolClass,
    oracleClass, dataClass, instructionsVersion, outputSchemaVersion, inputRefs, allowedActions, strata, summary
  };
  const taskFingerprint = fingerprint("model-eval-task-v1", identity);
  const envelope = { schemaVersion: 1, taskId: taskId || `task-${taskFingerprint.slice(0, 16)}`, taskFingerprint, capturedAt, ...identity };
  assertTaskEnvelope(envelope);
  return envelope;
}

export function assertTaskEnvelope(value) {
  assertExactKeys(value, [
    "schemaVersion", "taskId", "taskFingerprint", "capturedAt", "repoSha", "scope", "native", "operation", "risk",
    "modality", "contextBand", "toolClass", "oracleClass", "dataClass", "instructionsVersion", "outputSchemaVersion",
    "inputRefs", "allowedActions", "strata", "summary"
  ], "task envelope");
  if (value.schemaVersion !== 1) fail("task envelope schemaVersion must be 1");
  if (!/^task-[a-f0-9]{16}$/.test(value.taskId || "")) fail("task envelope has invalid taskId");
  if (!/^[a-f0-9]{64}$/.test(value.taskFingerprint || "")) fail("task envelope has invalid fingerprint");
  if (!validTimestamp(value.capturedAt)) fail("task envelope has invalid capturedAt");
  if (!/^[a-f0-9]{40}$/.test(value.repoSha || "")) fail("task envelope has invalid repoSha");
  if (value.scope !== "main") fail("model evaluation currently permits only main scope");
  if (!OPERATION_SET.has(value.operation)) fail(`invalid operation ${value.operation}`);
  if (!RISK_SET.has(value.risk)) fail(`invalid risk ${value.risk}`);
  if (!MODALITY_SET.has(value.modality)) fail(`invalid modality ${value.modality}`);
  if (!CONTEXT_SET.has(value.contextBand)) fail(`invalid context band ${value.contextBand}`);
  if (!DATA_SET.has(value.dataClass)) fail(`invalid data class ${value.dataClass}`);
  assertExactKeys(value.native, ["kind", "itemId", "actionKind", "selectionToken"], "task envelope native identity");
  if (typeof value.native.kind !== "string" || typeof value.native.itemId !== "string"
    || ![value.native.actionKind, value.native.selectionToken].every((item) => item === null || typeof item === "string")) {
    fail("task envelope native identity has invalid fields");
  }
  if (!Array.isArray(value.inputRefs) || value.inputRefs.some((ref) => !safeInputRef(ref))) fail("task envelope has unsafe inputRefs");
  if (!Array.isArray(value.allowedActions) || value.allowedActions.some((item) => !["read", "propose"].includes(item))) {
    fail("candidate task actions must be read/propose only");
  }
  if (!Array.isArray(value.strata) || value.strata.some((item) => typeof item !== "string" || !item)) fail("invalid strata");
  if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 500) fail("task envelope requires a bounded summary");
  const { taskId: ignoredTaskId, taskFingerprint: ignoredFingerprint, capturedAt: ignoredCapturedAt, ...identity } = value;
  const expected = fingerprint("model-eval-task-v1", identity);
  if (value.taskFingerprint !== expected) fail("task envelope fingerprint does not seal its identity");
  return value;
}

function safeInputRef(ref) {
  return ref && Object.keys(ref).sort().join(",") === "path,role,sha256"
    && typeof ref.path === "string" && !ref.path.startsWith("/") && !ref.path.includes("..")
    && /^[a-f0-9]{64}$/.test(ref.sha256 || "") && typeof ref.role === "string" && ref.role.length > 0;
}

export function assertSafeRunSummary(value) {
  assertExactKeys(value, [
    "schemaVersion", "runId", "taskFingerprint", "configId", "operation", "strata", "startedAt", "completedAt", "status",
    "outputHash", "runnerFingerprint", "evaluationConfigFingerprint", "usage", "timing", "cost", "validations", "referenceAgreement", "verdict", "tokenSavings"
  ], "run summary");
  if (value.schemaVersion !== 1 || !/^run-[a-f0-9]{16}$/.test(value.runId || "")) fail("invalid run summary identity");
  if (!/^[a-f0-9]{64}$/.test(value.taskFingerprint || "") || !/^[a-f0-9]{64}$/.test(value.outputHash || "")) fail("invalid run hashes");
  if (!/^[a-f0-9]{64}$/.test(value.runnerFingerprint || "") || !/^[a-f0-9]{64}$/.test(value.evaluationConfigFingerprint || "")) fail("invalid runner/config fingerprints");
  if (!OPERATION_SET.has(value.operation)) fail("invalid run operation");
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.completedAt)) fail("invalid run timestamps");
  if (!["completed", "failed", "timeout", "unavailable"].includes(value.status)) fail("invalid run status");
  if (!AGREEMENT_SET.has(value.referenceAgreement?.level)) fail("invalid reference agreement");
  if (!VERDICT_SET.has(value.verdict?.grade)) fail("invalid verdict");
  const serialized = canonicalJson(value).toLowerCase();
  for (const forbidden of ["prompt", "outputtext", "rawoutput", "apikey", "credential", "password"]) {
    if (serialized.includes(`\"${forbidden}\"`)) fail(`tracked run summary contains forbidden field ${forbidden}`);
  }
  return value;
}

export function evaluationConfigFingerprint(registry, modelConfig, outputSchema) {
  return fingerprint("model-eval-config-cell-v1", { versions: registry.versions, modelConfig, outputSchema });
}

export function evaluationCellIdentity(task) {
  return {
    operation: task.operation,
    modality: task.modality,
    contextBand: task.contextBand,
    toolClass: task.toolClass,
    dataClass: task.dataClass
  };
}

export function evaluationCellKey(configId, task) {
  const cell = evaluationCellIdentity(task);
  return [configId, cell.operation, cell.modality, cell.contextBand, cell.toolClass, cell.dataClass].join(":");
}

export function betaTailProbability(acceptable, failed, threshold) {
  const alpha = acceptable + 1;
  const beta = failed + 1;
  const n = alpha + beta - 1;
  const k = alpha - 1;
  if (!Number.isInteger(acceptable) || acceptable < 0 || !Number.isInteger(failed) || failed < 0) fail("Beta counts must be non-negative integers");
  if (!(threshold > 0 && threshold < 1)) fail("Beta threshold must be between zero and one");
  let term = (1 - threshold) ** n;
  let total = term;
  for (let i = 0; i < k; i += 1) {
    term *= ((n - i) / (i + 1)) * (threshold / (1 - threshold));
    total += term;
  }
  return Math.min(1, Math.max(0, total));
}

export function qualifyResults(results, policy) {
  const adjudicated = results.filter((item) => item.verdict?.grade !== "ambiguous");
  const acceptable = adjudicated.filter((item) => ["pass", "minor"].includes(item.verdict.grade)).length;
  const failed = adjudicated.length - acceptable;
  const critical = adjudicated.some((item) => item.verdict.grade === "critical-fail");
  const earlyMaterial = adjudicated.slice(0, policy.earlyRejectWindow).filter((item) => item.verdict.grade === "material-fail").length;
  const diversity = new Map();
  for (const item of adjudicated) for (const stratum of item.strata || []) diversity.set(stratum, (diversity.get(stratum) || 0) + 1);
  const diverseStrata = [...diversity.values()].filter((count) => count >= policy.minimumCasesPerStratum).length;
  const savings = meanSolSavings(adjudicated, policy.lowTouch.auditRate);
  const lastAudit = adjudicated.slice(-policy.lowTouch.cleanWindow);
  const repeatAnchors = adjudicated.filter((item) => item.validations?.repeatAnchor === true);
  const repeatPassed = repeatAnchors.filter((item) => item.validations?.repeatAnchorPassed === true).length;
  const repeatRate = repeatAnchors.length ? repeatPassed / repeatAnchors.length : 0;
  const reasons = [];
  if (critical) reasons.push("critical failure");
  if (earlyMaterial >= policy.earlyRejectMaterialFailures) reasons.push("early material-failure boundary");
  if (critical || reasons.length) return qualification("rejected", adjudicated, acceptable, failed, diverseStrata, savings, repeatRate, reasons);
  const diversityOk = diverseStrata >= policy.minimumDiverseStrata;
  const lowProbability = betaTailProbability(acceptable, failed, policy.lowTouch.successThreshold);
  const lowClean = lastAudit.length >= policy.lowTouch.cleanWindow && lastAudit.every((item) => !["material-fail", "critical-fail"].includes(item.verdict.grade));
  if (adjudicated.length >= policy.lowTouch.minimumCases && lowProbability >= policy.posteriorConfidence && diversityOk
    && lowClean && repeatRate >= policy.lowTouch.repeatAnchorRate && savings.lowTouch > 0) {
    return qualification("low-touch", adjudicated, acceptable, failed, diverseStrata, savings, repeatRate, reasons);
  }
  const reviewProbability = betaTailProbability(acceptable, failed, policy.reviewRequired.successThreshold);
  if (adjudicated.length >= policy.reviewRequired.minimumCases && reviewProbability >= policy.posteriorConfidence && diversityOk && savings.reviewRequired > 0) {
    return qualification("review-required", adjudicated, acceptable, failed, diverseStrata, savings, repeatRate, reasons);
  }
  if (adjudicated.length >= policy.maximumCases) reasons.push("maximum cases reached without promotion");
  else reasons.push("insufficient evidence");
  return qualification(adjudicated.length >= policy.maximumCases ? "unproven" : "evaluating", adjudicated, acceptable, failed, diverseStrata, savings, repeatRate, reasons);
}

function meanSolSavings(results, auditRate) {
  if (!results.length) return { reviewRequired: 0, lowTouch: 0 };
  let reviewRequired = 0;
  let lowTouch = 0;
  for (const item of results) {
    const measured = item.tokenSavings || {};
    const baseline = Number(measured.solBaselineTokens || 0);
    const review = Number(measured.solReviewTokens || 0);
    const fallback = Number(measured.fallbackSolTokens || 0);
    reviewRequired += Number(measured.netSolTokens || 0);
    lowTouch += baseline - (review * auditRate) - fallback;
  }
  return {
    reviewRequired: reviewRequired / results.length,
    lowTouch: lowTouch / results.length
  };
}

function qualification(mode, adjudicated, acceptable, failed, diverseStrata, savings, repeatRate, reasons) {
  const meanSavings = mode === "low-touch" ? savings.lowTouch : savings.reviewRequired;
  return {
    mode,
    adjudicated: adjudicated.length,
    acceptable,
    failed,
    diverseStrata,
    meanSavings,
    reviewRequiredMeanSavings: savings.reviewRequired,
    lowTouchMeanSavings: savings.lowTouch,
    repeatRate,
    reasons
  };
}

export function chooseRoute(envelope, registry, qualifications = {}) {
  assertTaskEnvelope(envelope);
  if (envelope.risk === "R3" || envelope.operation === "critical-side-effects" || envelope.dataClass === "secret") {
    return routingDecision(envelope, registry.referenceConfigId, "reference-only", "R3, side effects, and secrets are Sol-only", 1);
  }
  const eligible = registry.configs.filter((config) => config.id !== registry.referenceConfigId
    && config.enabled
    && (config.operations || []).includes(envelope.operation)
    && (config.modalities || []).includes(envelope.modality)
    && (config.contextBands || []).includes(envelope.contextBand)
    && (config.toolClasses || []).includes(envelope.toolClass)
    && (config.dataClasses || []).includes(envelope.dataClass)
    && ["review-required", "low-touch"].includes(qualifications[evaluationCellKey(config.id, envelope)]?.mode));
  eligible.sort((a, b) => {
    const qa = qualifications[evaluationCellKey(a.id, envelope)];
    const qb = qualifications[evaluationCellKey(b.id, envelope)];
    return (qb.meanSavings - qa.meanSavings) || (a.price.inputPerMillion + a.price.outputPerMillion) - (b.price.inputPerMillion + b.price.outputPerMillion);
  });
  if (!eligible.length) return routingDecision(envelope, registry.referenceConfigId, "reference-only", "no cheaper configuration has qualified for this task cell", 1);
  const selected = eligible[0];
  const cellKey = evaluationCellKey(selected.id, envelope);
  const mode = qualifications[cellKey].mode;
  const auditRate = mode === "low-touch" ? registry.policy.lowTouch.auditRate : 1;
  return routingDecision(envelope, selected.id, mode, `${selected.id} is qualified for the exact ${envelope.operation} task cell`, auditRate);
}

function routingDecision(envelope, configId, mode, reason, auditRate) {
  if (!ROUTE_MODE_SET.has(mode)) fail("invalid routing mode");
  if (!(auditRate > 0 && auditRate <= 1)) fail("routing audit rate must be greater than zero and at most one");
  const identity = { schemaVersion: 1, taskFingerprint: envelope.taskFingerprint, configId, mode, reason, auditRate };
  const sample = Number.parseInt(fingerprint("model-route-audit-v1", identity).slice(0, 13), 16) / 0xfffffffffffff;
  return {
    ...identity,
    decisionId: `route-${fingerprint("model-route-v1", identity).slice(0, 16)}`,
    auditRate,
    solReviewRequired: mode !== "low-touch" || sample < auditRate
  };
}

export function estimateWave(cases, configs, { overrunFraction = 0.1, inputBytesByTask = {}, repetitions = 1 } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) fail("wave repetitions must be an integer from 1 to 5");
  const estimates = [];
  for (const task of cases) {
    for (const config of configs) {
      if (!configSupportsTask(config, task)) continue;
      const inputBytes = Number(inputBytesByTask[task.taskFingerprint] ?? Buffer.byteLength(canonicalJson(task), "utf8"));
      const inputTokens = Math.ceil(inputBytes / 4) + Number(config.promptOverheadTokens || 0);
      const outputTokens = Number(config.maxOutputTokens || 1800);
      const usd = (inputTokens * config.price.inputPerMillion + outputTokens * config.price.outputPerMillion) / 1_000_000;
      for (let replicate = 1; replicate <= repetitions; replicate += 1) {
        estimates.push({ taskFingerprint: task.taskFingerprint, configId: config.id, replicate, inputTokens, outputTokens, estimatedUsd: roundUsd(usd), billingBasis: config.price.billingBasis });
      }
    }
  }
  const actualApiUsd = estimates.filter((item) => item.billingBasis === "actual-api").reduce((sum, item) => sum + item.estimatedUsd, 0);
  const apiEquivalentUsd = estimates.reduce((sum, item) => sum + item.estimatedUsd, 0);
  const identity = { schemaVersion: 1, cases: cases.map((item) => item.taskFingerprint), configs: configs.map((item) => item.id), estimates, overrunFraction, repetitions };
  return { ...identity, estimateHash: fingerprint("model-eval-wave-v1", identity), actualApiUsd: roundUsd(actualApiUsd), apiEquivalentUsd: roundUsd(apiEquivalentUsd), approvedActualApiUsd: roundUsd(actualApiUsd * (1 + overrunFraction)) };
}

export function configSupportsTask(config, task) {
  return config.enabled === true
    && (config.operations || []).includes(task.operation)
    && (config.modalities || []).includes(task.modality)
    && (config.contextBands || []).includes(task.contextBand)
    && (config.toolClasses || []).includes(task.toolClass)
    && (config.dataClasses || []).includes(task.dataClass);
}

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(`${label} contains unknown fields: ${extras.join(", ")}`);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function fail(message) {
  throw new Error(message);
}
