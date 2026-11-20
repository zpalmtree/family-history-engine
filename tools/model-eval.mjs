#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, writeJsonCreateOnlyAtomic } from "./atomic-json.mjs";
import { parseSchedulerSelection } from "./research-scheduler-store.mjs";
import {
  OPERATIONS, RISKS, MODALITIES, CONTEXT_BANDS, DATA_CLASSES, VERDICTS, AGREEMENTS,
  buildTaskEnvelope, classifySchedulerSelection, assertTaskEnvelope, assertSafeRunSummary, fingerprint,
  qualifyResults, chooseRoute, estimateWave, evaluationConfigFingerprint, evaluationCellIdentity,
  evaluationCellKey, configSupportsTask
} from "./model-eval-core.mjs";
import { preflightRunners, runModel } from "./model-eval-runners.mjs";
import { primaryCheckout } from "./tree-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalRoot = path.join(projectRoot, "evals", "model-routing");
const privateRoot = path.join(projectRoot, ".model-evals");
const config = readJson(path.join(evalRoot, "config.json"));
const schema = readJson(path.join(evalRoot, "schemas", "model-output.schema.json"));
const { command, options } = parseArgs(process.argv.slice(2));

await main();

async function main() {
  if (command === "capture") return capture();
  if (command === "preflight") return preflight();
  if (command === "plan") return plan();
  if (command === "run") return run();
  if (command === "score") return score();
  if (command === "report") return report();
  if (command === "route") return route();
  usage(command ? `unknown command ${command}` : null);
}

function capture() {
  ensurePrimaryMainCheckout();
  const selectionFile = options.selection ? resolveExisting(options.selection) : null;
  const promptFile = resolveExisting(required("prompt-file"));
  const repoSha = git("rev-parse", "HEAD").trim();
  let classified;
  let native;
  if (selectionFile) {
    const parsed = parseSchedulerSelection(readJson(selectionFile));
    if (parsed.selection.scope !== "main") throw new Error("model eval capture currently supports main scope only");
    classified = classifySchedulerSelection(parsed);
    native = {
      kind: parsed.kind,
      itemId: parsed.item.id,
      actionKind: parsed.item?.action?.kind || parsed.item?.actionKind || null,
      selectionToken: parsed.selection.token
    };
  } else {
    const operation = enumOption("operation", OPERATIONS);
    const risk = enumOption("risk", RISKS);
    classified = { operation, risk, modality: options.modality || "text", toolClass: options["tool-class"] || "none" };
    native = { kind: "manual", itemId: options["item-id"] || `manual-${Date.now()}`, actionKind: null, selectionToken: null };
  }
  const prompt = fs.readFileSync(promptFile, "utf8");
  if (!prompt.trim() || Buffer.byteLength(prompt) > 8_000_000) throw new Error("prompt file must contain 1 to 8,000,000 bytes");
  const dataClass = options["data-class"] || "permitted-private";
  if (!DATA_CLASSES.includes(dataClass) || dataClass === "secret") throw new Error("secret-bearing packets are never eligible for model evaluation");
  const envelope = buildTaskEnvelope({
    capturedAt: new Date().toISOString(), repoSha, scope: "main", native,
    operation: classified.operation, risk: classified.risk,
    modality: enumValue(options.modality || classified.modality, MODALITIES, "modality"),
    contextBand: enumValue(options.context || "medium", CONTEXT_BANDS, "context"),
    toolClass: options["tool-class"] || classified.toolClass,
    oracleClass: options.oracle || "human-rubric", dataClass,
    inputRefs: parseInputRefs(options.input),
    allowedActions: ["read", "propose"],
    strata: listOption(options.strata),
    summary: required("summary")
  });
  const caseFile = path.join(evalRoot, "cases", `${envelope.taskFingerprint}.json`);
  writeJsonCreateOnlyAtomic(caseFile, envelope);
  const packetFile = path.join(privateRoot, "packets", `${envelope.taskFingerprint}.json`);
  writePrivateCreateOnly(packetFile, { schemaVersion: 1, taskFingerprint: envelope.taskFingerprint, dataClass, prompt });
  output({ taskFingerprint: envelope.taskFingerprint, caseFile: relative(caseFile), packetFile: relative(packetFile), classification: classified });
}

async function preflight() {
  const selected = resolveConfigs(options.config);
  const results = [];
  for (const item of selected) {
    try { results.push({ configId: item.id, ...(await preflightRunners(item, { projectRoot })) }); }
    catch (error) { results.push({ configId: item.id, available: false, detail: error.message }); }
  }
  output({ schemaVersion: 1, results });
}

function plan() {
  if (Date.now() > Date.parse(`${config.pricingReviewAfter}T23:59:59Z`)) {
    throw new Error(`model pricing is stale after ${config.pricingReviewAfter}; verify official prices and version config.json before planning a paid wave`);
  }
  const cases = resolveCases(options.task);
  if (!cases.length) throw new Error("no captured cases matched; use capture first");
  const configs = resolveConfigs(options.config);
  const inputBytesByTask = Object.fromEntries(cases.map((item) => {
    const packet = readJson(path.join(privateRoot, "packets", `${item.taskFingerprint}.json`));
    const bytes = Buffer.byteLength(packet.prompt, "utf8") + Buffer.byteLength(JSON.stringify(schema), "utf8") + 2_000;
    return [item.taskFingerprint, bytes];
  }));
  const repetitions = numberOption("repetitions", 1);
  if (!Number.isInteger(repetitions) || repetitions > 5) throw new Error("--repetitions must be an integer from 1 to 5");
  const wave = estimateWave(cases, configs, { overrunFraction: config.policy.actualApiOverrunFraction, inputBytesByTask, repetitions });
  const waveFile = path.join(privateRoot, "waves", `${wave.estimateHash}.json`);
  writePrivateCreateOnly(waveFile, wave);
  output({ ...wave, waveFile: relative(waveFile), note: "No provider was invoked. Run requires this exact estimate hash." });
}

async function run() {
  ensurePrimaryMainCheckout();
  const task = one(resolveCases(required("task")), "task");
  const selectedConfig = one(resolveConfigs(required("config")), "config");
  const estimateHash = required("estimate-hash");
  const waveFile = path.join(privateRoot, "waves", `${estimateHash}.json`);
  if (!fs.existsSync(waveFile)) throw new Error("matching estimate wave does not exist; run plan first");
  const wave = readJson(waveFile);
  if (!wave.estimates.some((item) => item.taskFingerprint === task.taskFingerprint && item.configId === selectedConfig.id)) throw new Error("estimate does not cover this compatible task/configuration pair");
  const packet = readJson(path.join(privateRoot, "packets", `${task.taskFingerprint}.json`));
  if (packet.dataClass !== task.dataClass) throw new Error("private packet data class disagrees with tracked envelope");
  const preflightResult = await preflightRunners(selectedConfig, { projectRoot });
  if (!preflightResult.available) throw new Error(`${selectedConfig.id} unavailable: ${preflightResult.detail}`);
  const priorRuns = privateRunsForWave(estimateHash);
  const priorActualApiUsd = priorRuns
    .filter((item) => item.cost?.billingBasis === "actual-api")
    .reduce((sum, item) => sum + Number(item.cost.usd || 0), 0);
  const usedReplicates = new Set(priorRuns.filter((item) => item.taskFingerprint === task.taskFingerprint && item.configId === selectedConfig.id).map((item) => item.replicate || 1));
  const pairEstimate = wave.estimates.find((item) => item.taskFingerprint === task.taskFingerprint && item.configId === selectedConfig.id && !usedReplicates.has(item.replicate));
  if (!pairEstimate) throw new Error("all estimated repetitions for this task/configuration pair have already run");
  if (selectedConfig.price.billingBasis === "actual-api"
    && priorActualApiUsd + pairEstimate.estimatedUsd > wave.approvedActualApiUsd) {
    throw new Error("this run would exceed the approved actual-API wave ceiling; create a new estimate wave");
  }
  const runSeed = { taskFingerprint: task.taskFingerprint, configId: selectedConfig.id, estimateHash, replicate: pairEstimate.replicate, startedAt: new Date().toISOString() };
  const runId = `run-${fingerprint("model-eval-run-v1", runSeed).slice(0, 16)}`;
  const privateDirectory = path.join(privateRoot, "runs", task.taskFingerprint, runId);
  const result = await runModel(selectedConfig, { packet, schema, privateDirectory, projectRoot, runnerVersion: preflightResult.detail });
  const cost = costFor(selectedConfig, result.usage);
  const privateRun = { schemaVersion: 1, runId, taskFingerprint: task.taskFingerprint, configId: selectedConfig.id, estimateHash, replicate: pairEstimate.replicate, cost, ...result };
  writePrivateCreateOnly(path.join(privateDirectory, "run.json"), privateRun);
  const actualAfter = priorActualApiUsd + (cost.billingBasis === "actual-api" ? cost.usd : 0);
  output({ runId, taskFingerprint: task.taskFingerprint, configId: selectedConfig.id, replicate: pairEstimate.replicate, status: result.failure ? "failed" : "completed", failureKind: result.failure?.kind || null, outputHash: result.outputHash, usage: result.usage, timing: result.timing, cost, actualApiWaveUsd: actualAfter, approvedActualApiUsd: wave.approvedActualApiUsd, overrun: actualAfter > wave.approvedActualApiUsd, next: `npm run model:eval -- score --run ${runId} --task ${task.taskFingerprint} --verdict <grade> --agreement <level>` });
}

function score() {
  ensurePrimaryMainCheckout();
  const task = one(resolveCases(required("task")), "task");
  const runId = required("run");
  const runFile = path.join(privateRoot, "runs", task.taskFingerprint, runId, "run.json");
  if (!fs.existsSync(runFile)) throw new Error("private run record does not exist");
  const raw = readJson(runFile);
  const selectedConfig = one(resolveConfigs(raw.configId), "config");
  const verdict = enumOption("verdict", VERDICTS);
  const agreement = enumOption("agreement", AGREEMENTS);
  const note = options["note-file"] ? fs.readFileSync(resolveExisting(options["note-file"]), "utf8") : "";
  const solBaseline = numberOption("sol-baseline-tokens", 0);
  const solReview = numberOption("sol-review-tokens", 0);
  const fallback = numberOption("fallback-sol-tokens", 0);
  const candidateTokens = Number(raw.usage?.inputTokens || 0) + Number(raw.usage?.outputTokens || 0);
  const summary = {
    schemaVersion: 1, runId, taskFingerprint: task.taskFingerprint, configId: selectedConfig.id,
    operation: task.operation, strata: task.strata, startedAt: raw.startedAt, completedAt: raw.completedAt,
    status: raw.failure ? "failed" : "completed", outputHash: raw.outputHash, runnerFingerprint: raw.runnerFingerprint,
    evaluationConfigFingerprint: evaluationConfigFingerprint(config, selectedConfig, schema),
    usage: raw.usage, timing: raw.timing, cost: costFor(selectedConfig, raw.usage),
    validations: { schemaPassed: !raw.failure, policyPassed: raw.failure?.kind !== "policy-violation", repeatAnchor: options["repeat-anchor"] === true, repeatAnchorPassed: options["repeat-anchor-passed"] === true },
    referenceAgreement: { level: agreement, mismatchedFields: listOption(options.mismatch) },
    verdict: { grade: verdict, adjudicator: options.adjudicator || "sol-xhigh-plus-human-rubric", noteHash: note ? fingerprint("model-eval-adjudication-v1", note) : null },
    tokenSavings: { solBaselineTokens: solBaseline, solReviewTokens: solReview, fallbackSolTokens: fallback, candidateTokens, netSolTokens: solBaseline - solReview - fallback }
  };
  assertSafeRunSummary(summary);
  if (note) writePrivateCreateOnly(path.join(privateRoot, "runs", task.taskFingerprint, runId, "adjudication.txt"), note);
  const resultFile = path.join(evalRoot, "results", task.taskFingerprint, `${runId}.json`);
  writeJsonCreateOnlyAtomic(resultFile, summary);
  output({ resultFile: relative(resultFile), verdict, agreement, noteStoredPrivately: Boolean(note) });
}

function report() {
  const cases = jsonFiles(path.join(evalRoot, "cases")).map(readJson).map(assertTaskEnvelope);
  const casesByFingerprint = new Map(cases.map((item) => [item.taskFingerprint, item]));
  const results = jsonFiles(path.join(evalRoot, "results")).map(readJson).map(assertSafeRunSummary);
  for (const result of results) {
    const task = casesByFingerprint.get(result.taskFingerprint);
    if (!task) throw new Error(`model result ${result.runId} references an unknown task`);
    if (result.operation !== task.operation) throw new Error(`model result ${result.runId} operation disagrees with its task envelope`);
  }
  const cells = {};
  for (const item of config.configs.filter((candidate) => !candidate.reference)) {
    const currentConfigFingerprint = evaluationConfigFingerprint(config, item, schema);
    const groups = new Map();
    for (const task of cases.filter((candidate) => configSupportsTask(item, candidate))) {
      const key = evaluationCellKey(item.id, task);
      if (!groups.has(key)) groups.set(key, { identity: evaluationCellIdentity(task), taskFingerprints: new Set() });
      groups.get(key).taskFingerprints.add(task.taskFingerprint);
    }
    for (const [key, group] of groups) {
      const compatible = results.filter((run) => run.configId === item.id
        && group.taskFingerprints.has(run.taskFingerprint)
        && run.evaluationConfigFingerprint === currentConfigFingerprint);
      const activeRunnerFingerprint = compatible.toSorted((a, b) => b.completedAt.localeCompare(a.completedAt))[0]?.runnerFingerprint || null;
      const matching = compatible.filter((run) => run.runnerFingerprint === activeRunnerFingerprint)
        .toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
      cells[key] = {
        ...qualifyResults(matching, config.policy),
        cell: { configId: item.id, ...group.identity },
        activeRunnerFingerprint,
        evaluationConfigFingerprint: currentConfigFingerprint
      };
    }
  }
  const document = { schemaVersion: 1, configFingerprint: fingerprint("model-eval-config-v1", config), generatedAt: new Date().toISOString(), resultCount: results.length, cells };
  if (options.write) {
    ensurePrimaryMainCheckout();
    writeJsonAtomic(path.join(evalRoot, "report.json"), document);
  } else if (options.check) {
    const existing = readJson(path.join(evalRoot, "report.json"));
    if (JSON.stringify({ ...existing, generatedAt: null }) !== JSON.stringify({ ...document, generatedAt: null })) throw new Error("model routing report is stale; run report --write");
  }
  if (!options.quiet) output(document);
}

function route() {
  let envelope;
  if (options.selection) {
    const parsed = parseSchedulerSelection(readJson(resolveExisting(options.selection)));
    const classified = classifySchedulerSelection(parsed);
    envelope = buildTaskEnvelope({
      capturedAt: new Date().toISOString(), repoSha: git("rev-parse", "HEAD").trim(), scope: "main",
      native: { kind: parsed.kind, itemId: parsed.item.id, actionKind: parsed.item?.action?.kind || parsed.item?.actionKind || null, selectionToken: parsed.selection.token },
      ...classified, contextBand: enumValue(options.context || "medium", CONTEXT_BANDS, "context"),
      oracleClass: "routing-only", dataClass: enumValue(options["data-class"] || "permitted-private", DATA_CLASSES, "data-class"),
      summary: options.summary || `Route scheduler selection ${parsed.kind}/${parsed.item.id}`
    });
  } else envelope = one(resolveCases(required("task")), "task");
  const reportFile = path.join(evalRoot, "report.json");
  const savedReport = fs.existsSync(reportFile) ? readJson(reportFile) : null;
  const qualifications = savedReport?.configFingerprint === fingerprint("model-eval-config-v1", config) ? savedReport.cells : {};
  output(chooseRoute(envelope, config, qualifications));
}

function resolveCases(value) {
  const cases = jsonFiles(path.join(evalRoot, "cases")).map(readJson).map(assertTaskEnvelope);
  if (!value) return cases;
  const wanted = listOption(value);
  return cases.filter((item) => wanted.some((needle) => item.taskFingerprint === needle || item.taskId === needle));
}

function resolveConfigs(value) {
  if (!value) return config.configs.filter((item) => item.enabled);
  const wanted = listOption(value);
  const selected = config.configs.filter((item) => wanted.includes(item.id));
  if (selected.length !== wanted.length) throw new Error("one or more model configuration IDs are unknown");
  return selected;
}

function parseInputRefs(value) {
  return listOption(value).map((entry) => {
    const separator = entry.lastIndexOf(":");
    const file = separator > 1 ? entry.slice(0, separator) : entry;
    const role = separator > 1 ? entry.slice(separator + 1) : "input";
    const absolute = path.resolve(projectRoot, file);
    if (!absolute.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(absolute)) throw new Error(`unsafe or missing input ref ${file}`);
    return { path: path.relative(projectRoot, absolute).replaceAll(path.sep, "/"), role, sha256: sha256File(absolute) };
  });
}

function costFor(modelConfig, usage) {
  const input = Math.max(0, Number(usage.inputTokens || 0) - Number(usage.cachedInputTokens || 0));
  const cached = Number(usage.cachedInputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const cachedRate = Number(modelConfig.price.cachedInputPerMillion ?? modelConfig.price.inputPerMillion);
  const usd = (input * modelConfig.price.inputPerMillion + cached * cachedRate + outputTokens * modelConfig.price.outputPerMillion) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, billingBasis: modelConfig.price.billingBasis };
}

function ensurePrimaryMainCheckout() {
  const primary = primaryCheckout();
  if (primary && projectRoot !== primary) throw new Error("writes require the primary checkout");
  if (git("branch", "--show-current").trim() !== "main") throw new Error("writes require branch main");
  const [ahead, behind] = git("rev-list", "--left-right", "--count", "main...origin/main").trim().split(/\s+/).map(Number);
  if (ahead !== 0 || behind !== 0) throw new Error("primary main must be synchronized with origin/main before model-eval writes");
}

function writePrivateCreateOnly(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(privateRoot)) fs.chmodSync(privateRoot, 0o700);
  fs.chmodSync(path.dirname(file), 0o700);
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === text) return false;
    throw new Error(`private immutable file already exists with different content: ${file}`);
  }
  fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  return true;
}

function privateRunsForWave(estimateHash) {
  return jsonFiles(path.join(privateRoot, "runs"))
    .filter((file) => path.basename(file) === "run.json")
    .map(readJson)
    .filter((item) => item.estimateHash === estimateHash);
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name)).sort();
}

function parseArgs(args) {
  const [first, ...rest] = args;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) opts[key] = true;
    else opts[key] = rest[++i];
  }
  return { command: first, options: opts };
}

function required(name) { const value = options[name]; if (value === undefined || value === true || value === "") throw new Error(`--${name} is required`); return value; }
function enumOption(name, values) { return enumValue(required(name), values, name); }
function enumValue(value, values, name) { if (!values.includes(value)) throw new Error(`--${name} must be one of ${values.join(", ")}`); return value; }
function listOption(value) { return value === undefined || value === true || value === "" ? [] : String(value).split(",").map((item) => item.trim()).filter(Boolean); }
function numberOption(name, fallback) { if (options[name] === undefined) return fallback; const value = Number(options[name]); if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be non-negative`); return value; }
function one(values, name) { if (values.length !== 1) throw new Error(`exactly one ${name} is required; found ${values.length}`); return values[0]; }
function resolveExisting(value) { const file = path.resolve(value); if (!fs.existsSync(file)) throw new Error(`file does not exist: ${file}`); return file; }
function git(...args) { return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }); }
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function relative(file) { return path.relative(projectRoot, file).replaceAll(path.sep, "/"); }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function usage(error) {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write("Usage: npm run model:eval -- <capture|preflight|plan|run|score|report|route> [options]\n");
  process.exitCode = error ? 64 : 0;
}
