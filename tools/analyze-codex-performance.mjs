#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_HOURS = 24;
const MAX_HOURS = 8_760;

export function analyzeEvents(events, file = "session.jsonl") {
  const state = { metadata: {}, turns: [], current: null, file };
  for (const event of events) consumeEvent(state, event);
  return finishAnalysis(state);
}

function consumeEvent(state, event) {
  const timestampMs = Date.parse(event.timestamp);
  if (!Number.isFinite(timestampMs)) return;
  const payload = event.payload || {};
  if (event.type === "session_meta") {
    state.metadata = { cwd: payload.cwd, sessionId: payload.id || payload.session_id };
    return;
  }
  if (event.type === "event_msg" && payload.type === "task_started") {
    state.current = newTurn(timestampMs, payload.turn_id);
    state.turns.push(state.current);
    return;
  }
  const turn = state.current;
  if (!turn) return;
  turn.endedAtMs = Math.max(turn.endedAtMs, timestampMs);
  if (event.type === "turn_context") {
    turn.model = payload.model || turn.model;
    turn.effort = payload.effort || turn.effort;
    return;
  }
  if (event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(payload.type)) {
    turn.active = false;
    turn.completionType = payload.type;
    return;
  }
  if (event.type === "event_msg" && payload.type === "token_count" && payload.info) {
    turn.tokenInfo = payload.info;
    return;
  }
  if (event.type !== "response_item") return;
  if (payload.type === "custom_tool_call") {
    turn.toolInputBytes += jsonBytes(payload.input);
    const nestedNames = nestedToolNames(payload.input);
    turn.nestedCallsPerOuter.push(nestedNames.length);
    for (const name of nestedNames) turn.byNestedTool.set(name, (turn.byNestedTool.get(name) || 0) + 1);
    if (turn.previousToolOutputAtMs !== null) turn.decisionGapsMs.push(Math.max(0, timestampMs - turn.previousToolOutputAtMs));
    turn.pendingCalls.set(payload.call_id, { name: payload.name || "unknown", startedAtMs: timestampMs, nestedNames });
    return;
  }
  if (payload.type !== "custom_tool_call_output") return;
  const outputBytes = jsonBytes(payload.output);
  turn.toolOutputBytes += outputBytes;
  const call = turn.pendingCalls.get(payload.call_id);
  if (call) {
    const durationMs = Math.max(0, timestampMs - call.startedAtMs);
    turn.toolDurationsMs.push(durationMs);
    incrementTool(turn.byTool, call.name, durationMs);
    if (call.nestedNames.length === 1) {
      const nested = turn.attributedNested.get(call.nestedNames[0]) || { calls: 0, outputBytes: 0, outerDurationMs: 0 };
      nested.calls += 1;
      nested.outputBytes += outputBytes;
      nested.outerDurationMs += durationMs;
      turn.attributedNested.set(call.nestedNames[0], nested);
    }
    turn.pendingCalls.delete(payload.call_id);
  }
  turn.previousToolOutputAtMs = timestampMs;
}

function finishAnalysis({ metadata, turns, file }) {
  if (!turns.length) return null;
  const latest = turns.at(-1);
  const toolDurations = turns.flatMap((turn) => turn.toolDurationsMs);
  const decisionGaps = turns.flatMap((turn) => turn.decisionGapsMs);
  const nestedCounts = turns.flatMap((turn) => turn.nestedCallsPerOuter);
  const byTool = new Map();
  const byNestedTool = new Map();
  const attributedNested = new Map();
  for (const turn of turns) {
    for (const [name, value] of turn.byTool) {
      const aggregate = byTool.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
      aggregate.count += value.count;
      aggregate.totalMs += value.totalMs;
      aggregate.maxMs = Math.max(aggregate.maxMs, value.maxMs);
      byTool.set(name, aggregate);
    }
    for (const [name, count] of turn.byNestedTool) byNestedTool.set(name, (byNestedTool.get(name) || 0) + count);
    for (const [name, value] of turn.attributedNested) {
      const aggregate = attributedNested.get(name) || { calls: 0, outputBytes: 0, outerDurationMs: 0 };
      aggregate.calls += value.calls;
      aggregate.outputBytes += value.outputBytes;
      aggregate.outerDurationMs += value.outerDurationMs;
      attributedNested.set(name, aggregate);
    }
  }
  const elapsedMs = sum(turns.map((turn) => Math.max(0, turn.endedAtMs - turn.startedAtMs)));
  const activeElapsedMs = latest.active ? Math.max(0, latest.endedAtMs - latest.startedAtMs) : 0;
  const toolMs = sum(toolDurations);
  const lastTokens = latest.tokenInfo?.last_token_usage || {};
  const report = {
    file,
    cwd: metadata.cwd,
    sessionId: metadata.sessionId,
    turnId: latest.turnId,
    turnCount: turns.length,
    active: latest.active,
    completionType: latest.completionType,
    startedAt: new Date(turns[0].startedAtMs).toISOString(),
    endedAt: new Date(latest.endedAtMs).toISOString(),
    model: latest.model || [...turns].reverse().find((turn) => turn.model)?.model || "unknown",
    effort: latest.effort || [...turns].reverse().find((turn) => turn.effort)?.effort || "unknown",
    elapsedMs,
    activeElapsedMs,
    outerToolCalls: nestedCounts.length,
    completedToolCalls: toolDurations.length,
    pendingToolCalls: sum(turns.map((turn) => turn.pendingCalls.size)),
    toolMs,
    nonToolMs: Math.max(0, elapsedMs - toolMs),
    toolShare: elapsedMs ? toolMs / elapsedMs : 0,
    toolDuration: distribution(toolDurations),
    decisionGap: distribution(decisionGaps),
    toolInputBytes: sum(turns.map((turn) => turn.toolInputBytes)),
    toolOutputBytes: sum(turns.map((turn) => turn.toolOutputBytes)),
    context: {
      inputTokens: lastTokens.input_tokens || 0,
      cachedInputTokens: lastTokens.cached_input_tokens || 0,
      outputTokens: lastTokens.output_tokens || 0,
      reasoningOutputTokens: lastTokens.reasoning_output_tokens || 0,
      windowTokens: latest.tokenInfo?.model_context_window || 0,
    },
    byTool: Object.fromEntries([...byTool].map(([name, value]) => [name, {
      ...value,
      averageMs: value.count ? value.totalMs / value.count : 0,
    }])),
    nestedCalls: {
      count: sum(nestedCounts),
      averagePerOuter: nestedCounts.length ? sum(nestedCounts) / nestedCounts.length : 0,
      maxPerOuter: nestedCounts.length ? Math.max(...nestedCounts) : 0,
      zero: nestedCounts.filter((count) => count === 0).length,
      one: nestedCounts.filter((count) => count === 1).length,
      multiple: nestedCounts.filter((count) => count > 1).length,
      byTool: Object.fromEntries(byNestedTool),
      attributed: Object.fromEntries(attributedNested),
    },
  };
  report.warnings = evaluatePerformance(report);
  return report;
}

export function evaluatePerformance(report) {
  const warnings = [];
  const contextShare = report.context.windowTokens ? report.context.inputTokens / report.context.windowTokens : 0;
  threshold(warnings, "context", contextShare, 0.70, 0.80, "Latest model-cycle context is growing", "ratio");
  threshold(warnings, "outer-calls", report.outerToolCalls, 80, 120, "Many outer tool cycles are increasing orchestration time", "count");
  threshold(warnings, "active-time", report.activeElapsedMs, 30 * 60_000, 45 * 60_000, "The current turn has been active for a long time", "ms");
  threshold(warnings, "tool-output", report.toolOutputBytes, 8 * 1024 * 1024, 12 * 1024 * 1024, "Tool output is expanding session context", "bytes");
  if (report.outerToolCalls >= 20 && report.nestedCalls.averagePerOuter < 1.5) {
    warnings.push(warning("low-batching", "warning", "Independent tool work may be under-batched", report.nestedCalls.averagePerOuter, "ratio"));
  }
  if (report.decisionGap.medianMs > 8_000 || report.decisionGap.p95Ms > 30_000) {
    warnings.push(warning("decision-gap", "warning", "Result-to-next-call gaps indicate orchestration/model time", { medianMs: report.decisionGap.medianMs, p95Ms: report.decisionGap.p95Ms }, "duration"));
  }
  const imageBytes = Object.entries(report.nestedCalls.attributed)
    .filter(([name]) => /image|screenshot|view_image/i.test(name))
    .reduce((total, [, value]) => total + value.outputBytes, 0);
  if (imageBytes > 2 * 1024 * 1024) warnings.push(warning("image-output", "warning", "Image results account for more than 2 MiB of attributed output", imageBytes, "bytes"));
  return warnings;
}

function attributedImageBytes(report) {
  return Object.entries(report.nestedCalls.attributed)
    .filter(([name]) => /image|screenshot|view_image/i.test(name))
    .reduce((total, [, value]) => total + value.outputBytes, 0);
}

function numericDistribution(values, suffix) {
  if (!values.length) return { count: 0, [`median${suffix}`]: 0, [`p95${suffix}`]: 0, [`max${suffix}`]: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    [`median${suffix}`]: percentile(sorted, 0.5),
    [`p95${suffix}`]: percentile(sorted, 0.95),
    [`max${suffix}`]: sorted.at(-1),
  };
}

export function aggregatePerformanceReports(reports, { hours = null, generatedAt = new Date().toISOString() } = {}) {
  const warningCounts = {};
  for (const report of reports) {
    for (const item of report.warnings) warningCounts[item.code] = (warningCounts[item.code] || 0) + 1;
  }
  const contextShares = reports.map((report) => report.context.windowTokens ? report.context.inputTokens / report.context.windowTokens : 0);
  return {
    schemaVersion: 1,
    generatedAt,
    hours,
    privacy: "aggregate metadata only; no prompts, commands, URLs, tool output, or file paths",
    sessionCount: reports.length,
    activeSessionCount: reports.filter((report) => report.active).length,
    completedSessionCount: reports.filter((report) => !report.active).length,
    firstStartedAt: reports.length ? reports.map((report) => report.startedAt).sort().at(0) : null,
    lastEndedAt: reports.length ? reports.map((report) => report.endedAt).sort().at(-1) : null,
    totals: {
      rolloutFileBytes: sum(reports.map((report) => report.rolloutFileBytes || 0)),
      turns: sum(reports.map((report) => report.turnCount)),
      outerToolCalls: sum(reports.map((report) => report.outerToolCalls)),
      completedToolCalls: sum(reports.map((report) => report.completedToolCalls)),
      elapsedMs: sum(reports.map((report) => report.elapsedMs)),
      toolMs: sum(reports.map((report) => report.toolMs)),
      toolInputBytes: sum(reports.map((report) => report.toolInputBytes)),
      toolOutputBytes: sum(reports.map((report) => report.toolOutputBytes)),
      attributedImageOutputBytes: sum(reports.map(attributedImageBytes)),
    },
    distributions: {
      rolloutFile: numericDistribution(reports.map((report) => report.rolloutFileBytes || 0), "Bytes"),
      sessionElapsed: numericDistribution(reports.map((report) => report.elapsedMs), "Ms"),
      outerToolCalls: numericDistribution(reports.map((report) => report.outerToolCalls), "Count"),
      toolOutput: numericDistribution(reports.map((report) => report.toolOutputBytes), "Bytes"),
      decisionGapMedian: numericDistribution(reports.map((report) => report.decisionGap.medianMs), "Ms"),
      contextShare: numericDistribution(contextShares, "Ratio"),
    },
    thresholdCounts: {
      contextAtLeast70Percent: contextShares.filter((value) => value >= 0.70).length,
      outerCallsAtLeast80: reports.filter((report) => report.outerToolCalls >= 80).length,
      toolOutputAtLeast8MiB: reports.filter((report) => report.toolOutputBytes >= 8 * 1024 * 1024).length,
    },
    warningCounts,
  };
}

function threshold(warnings, code, value, moderate, strong, message, unit) {
  if (value >= strong) warnings.push(warning(code, "strong", message, value, unit));
  else if (value >= moderate) warnings.push(warning(code, "warning", message, value, unit));
}

function warning(code, severity, message, value, unit) { return { code, severity, message, value, unit, automaticAction: false }; }

export async function analyzeSessionFile(file) {
  const state = { metadata: {}, turns: [], current: null, file };
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { consumeEvent(state, JSON.parse(line)); } catch { /* tolerate an in-progress final line */ }
  }
  return finishAnalysis(state);
}

function newTurn(startedAtMs, turnId) {
  return { turnId, active: true, completionType: null, startedAtMs, endedAtMs: startedAtMs, model: null, effort: null, pendingCalls: new Map(), toolDurationsMs: [], decisionGapsMs: [], previousToolOutputAtMs: null, toolInputBytes: 0, toolOutputBytes: 0, tokenInfo: null, byTool: new Map(), nestedCallsPerOuter: [], byNestedTool: new Map(), attributedNested: new Map() };
}

function incrementTool(map, name, durationMs) {
  const aggregate = map.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
  aggregate.count += 1;
  aggregate.totalMs += durationMs;
  aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
  map.set(name, aggregate);
}

function distribution(values) {
  if (!values.length) return { count: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return { count: sorted.length, medianMs: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) };
}

function percentile(sorted, fraction) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value ?? "")); }
function nestedToolNames(value) {
  const source = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return [...source.matchAll(/\btools\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)].map((match) => match[1]);
}

async function findRecentSessions(root, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1_000;
  const files = [];
  if (!fs.existsSync(root)) return files;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && fs.statSync(fullPath).mtimeMs >= cutoff) files.push(fullPath);
    }
  }
  return files;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}
function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_024 / 1_024).toFixed(2)} MiB`;
}

export function formatPerformanceReport(report) {
  const contextPercent = report.context.windowTokens ? report.context.inputTokens / report.context.windowTokens * 100 : 0;
  const state = report.active ? "active" : report.completionType || "complete";
  const lines = [
    `Codex session: ${path.basename(report.file)} (${state}; ${report.turnCount} turn(s))`,
    `  latest-turn=${report.turnId || "unknown"} model=${report.model} effort=${report.effort}`,
    `  aggregate elapsed=${formatDuration(report.elapsedMs)} tool=${formatDuration(report.toolMs)} (${(report.toolShare * 100).toFixed(1)}%) non-tool/orchestration=${formatDuration(report.nonToolMs)}`,
    `  completed-tools=${report.completedToolCalls} pending-tools=${report.pendingToolCalls} tool-latency median=${formatDuration(report.toolDuration.medianMs)} p95=${formatDuration(report.toolDuration.p95Ms)}`,
    `  result-to-next-call median=${formatDuration(report.decisionGap.medianMs)} p95=${formatDuration(report.decisionGap.p95Ms)}`,
    `  tool-I/O input=${formatBytes(report.toolInputBytes)} output=${formatBytes(report.toolOutputBytes)}`,
    `  nested-tool batching outer=${report.outerToolCalls} average-per-cycle=${report.nestedCalls.averagePerOuter.toFixed(2)} multiple=${report.nestedCalls.multiple}`,
    `  latest-model-cycle input=${report.context.inputTokens.toLocaleString()} cached=${report.context.cachedInputTokens.toLocaleString()} output=${report.context.outputTokens.toLocaleString()} context=${contextPercent.toFixed(1)}%`,
  ];
  for (const item of report.warnings) lines.push(`  ${item.severity.toUpperCase()} ${item.code}: ${item.message} (warn only)`);
  return lines.join("\n");
}

export function formatPerformanceHistory(history) {
  if (!history.sessionCount) return `No matching Codex sessions were updated in the last ${history.hours} hour(s).`;
  const toolShare = history.totals.elapsedMs ? history.totals.toolMs / history.totals.elapsedMs * 100 : 0;
  const lines = [
    `Codex history: ${history.sessionCount} session(s) over the last ${history.hours} hour(s); ${history.activeSessionCount} active.`,
    `  rollout files total=${formatBytes(history.totals.rolloutFileBytes)} median=${formatBytes(history.distributions.rolloutFile.medianBytes)} p95=${formatBytes(history.distributions.rolloutFile.p95Bytes)}`,
    `  aggregate turns=${history.totals.turns} outer-tools=${history.totals.outerToolCalls} elapsed=${formatDuration(history.totals.elapsedMs)} tool-share=${toolShare.toFixed(1)}%`,
    `  tool-I/O input=${formatBytes(history.totals.toolInputBytes)} output=${formatBytes(history.totals.toolOutputBytes)} attributed-images=${formatBytes(history.totals.attributedImageOutputBytes)}`,
    `  per-session outer-tools median=${history.distributions.outerToolCalls.medianCount} p95=${history.distributions.outerToolCalls.p95Count}; decision-gap median-of-medians=${formatDuration(history.distributions.decisionGapMedian.medianMs)} p95=${formatDuration(history.distributions.decisionGapMedian.p95Ms)}`,
    `  threshold sessions context>=70%: ${history.thresholdCounts.contextAtLeast70Percent}; outer-calls>=80: ${history.thresholdCounts.outerCallsAtLeast80}; output>=8MiB: ${history.thresholdCounts.toolOutputAtLeast8MiB}`,
    "Aggregate metadata only: prompts, commands, URLs, tool output, and rollout paths are never displayed.",
  ];
  return lines.join("\n");
}

function valueAfter(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

async function main() {
  const args = process.argv.slice(2);
  const requested = valueAfter(args, "--session");
  const hours = Number(valueAfter(args, "--hours") || DEFAULT_HOURS);
  const history = args.includes("--history");
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw new Error(`--hours must be between 0 and ${MAX_HOURS}.`);
  if (requested && history) throw new Error("--history cannot be combined with --session.");
  let files;
  if (requested) files = [path.resolve(requested)];
  else {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    files = await findRecentSessions(path.join(codexHome, "sessions"), hours);
    if (!args.includes("--all-active") && process.env.CODEX_THREAD_ID) {
      const exact = files.filter((file) => file.includes(process.env.CODEX_THREAD_ID));
      if (exact.length) files = exact;
    }
  }
  const analyzed = [];
  for (const file of files) {
    const report = await analyzeSessionFile(file);
    if (report) report.rolloutFileBytes = fs.statSync(file).size;
    analyzed.push(report);
  }
  let reports = analyzed.filter((report) => report && (requested || report.cwd === process.cwd()));
  if (history) {
    reports.sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
    const aggregate = aggregatePerformanceReports(reports, { hours });
    console.log(args.includes("--json") ? JSON.stringify(aggregate, null, 2) : formatPerformanceHistory(aggregate));
    return;
  }
  if (!requested && !args.includes("--all-active")) {
    const current = process.env.CODEX_THREAD_ID;
    const exact = reports.filter((report) => report.sessionId === current || report.file.includes(current || "\0"));
    reports = exact.length ? exact : reports.filter((report) => report.active).sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt)).slice(0, 1);
  } else if (!requested) reports = reports.filter((report) => report.active);
  reports.sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
  if (args.includes("--json")) {
    console.log(JSON.stringify(args.includes("--all-active") ? reports : reports[0] || null, null, 2));
    return;
  }
  if (!reports.length) {
    console.log(`No matching Codex session for ${process.cwd()} was updated in the last ${hours} hour(s).`);
    return;
  }
  console.log("Metadata-only report: prompts, commands, URLs, and tool output are never displayed. Warnings never change session state.\n");
  console.log(reports.map(formatPerformanceReport).join("\n\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
