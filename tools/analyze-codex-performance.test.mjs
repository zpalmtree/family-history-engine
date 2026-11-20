import assert from "node:assert/strict";
import test from "node:test";

import { aggregatePerformanceReports, analyzeEvents, evaluatePerformance, formatPerformanceHistory } from "./analyze-codex-performance.mjs";

test("analyzeEvents separates tool wall time from orchestration time without retaining content", () => {
  const events = [
    event("2026-07-15T00:00:00.000Z", "session_meta", { cwd: "/project", id: "session-1" }),
    event("2026-07-15T00:00:01.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    event("2026-07-15T00:00:01.100Z", "turn_context", { model: "gpt-test", effort: "high" }),
    event("2026-07-15T00:00:03.000Z", "response_item", { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "await tools.exec_command({cmd: privateCommand})" }),
    event("2026-07-15T00:00:05.000Z", "response_item", { type: "custom_tool_call_output", call_id: "call-1", output: "private output" }),
    event("2026-07-15T00:00:09.000Z", "response_item", { type: "custom_tool_call", call_id: "call-2", name: "web", input: "await Promise.all([tools.web__run(privateQuery), tools.exec_command(privateCommand)])" }),
    event("2026-07-15T00:00:10.000Z", "response_item", { type: "custom_tool_call_output", call_id: "call-2", output: "private result" }),
    event("2026-07-15T00:00:11.000Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 800, cached_input_tokens: 600, output_tokens: 20, reasoning_output_tokens: 10 },
        model_context_window: 1_000,
      },
    }),
    event("2026-07-15T00:00:13.000Z", "event_msg", { type: "task_complete" }),
  ];

  const report = analyzeEvents(events, "/tmp/session.jsonl");
  assert.equal(report.elapsedMs, 12_000);
  assert.equal(report.toolMs, 3_000);
  assert.equal(report.nonToolMs, 9_000);
  assert.equal(report.completedToolCalls, 2);
  assert.equal(report.decisionGap.medianMs, 4_000);
  assert.equal(report.context.inputTokens, 800);
  assert.equal(report.active, false);
  assert.deepEqual(Object.keys(report.byTool), ["exec", "web"]);
  assert.deepEqual(report.nestedCalls, {
    count: 3,
    averagePerOuter: 1.5,
    maxPerOuter: 2,
    zero: 0,
    one: 1,
    multiple: 1,
    byTool: { exec_command: 2, web__run: 1 },
    attributed: {
      exec_command: {
        calls: 1,
        outputBytes: Buffer.byteLength(JSON.stringify("private output")),
        outerDurationMs: 2_000,
      },
    },
  });
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("analyzeEvents aggregates all turns while retaining latest-turn state", () => {
  const events = [
    event("2026-07-15T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "old" }),
    event("2026-07-15T00:00:02.000Z", "event_msg", { type: "task_complete" }),
    event("2026-07-15T00:00:05.000Z", "event_msg", { type: "task_started", turn_id: "current" }),
    event("2026-07-15T00:00:08.000Z", "response_item", { type: "custom_tool_call", call_id: "pending", name: "exec" }),
  ];

  const report = analyzeEvents(events);
  assert.equal(report.turnId, "current");
  assert.equal(report.turnCount, 2);
  assert.equal(report.elapsedMs, 5_000);
  assert.equal(report.active, true);
  assert.equal(report.pendingToolCalls, 1);
});

test("performance thresholds are warning-only and never request compaction", () => {
  const report = analyzeEvents([
    event("2026-07-15T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "current" }),
    event("2026-07-15T00:31:00.000Z", "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 750 }, model_context_window: 1_000 } }),
  ]);
  const warnings = evaluatePerformance(report);
  assert.ok(warnings.some((item) => item.code === "context"));
  assert.ok(warnings.some((item) => item.code === "active-time"));
  assert.ok(warnings.every((item) => item.automaticAction === false));
});

test("historical aggregation remains content-free and reports scalability thresholds", () => {
  const first = analyzeEvents([
    event("2026-07-15T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "first" }),
    event("2026-07-15T00:00:01.000Z", "response_item", { type: "custom_tool_call", call_id: "image", name: "exec", input: "tools.view_image(secretPath)" }),
    event("2026-07-15T00:00:03.000Z", "response_item", { type: "custom_tool_call_output", call_id: "image", output: "secret image bytes" }),
    event("2026-07-15T00:00:04.000Z", "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 750 }, model_context_window: 1_000 } }),
    event("2026-07-15T00:00:05.000Z", "event_msg", { type: "task_complete" }),
  ]);
  first.rolloutFileBytes = 2_000;
  const second = analyzeEvents([
    event("2026-07-16T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "second" }),
    event("2026-07-16T00:00:02.000Z", "event_msg", { type: "task_complete" }),
  ]);
  second.rolloutFileBytes = 4_000;
  const aggregate = aggregatePerformanceReports([first, second], { hours: 48, generatedAt: "2026-07-20T00:00:00Z" });
  assert.equal(aggregate.sessionCount, 2);
  assert.equal(aggregate.totals.rolloutFileBytes, 6_000);
  assert.equal(aggregate.thresholdCounts.contextAtLeast70Percent, 1);
  assert.ok(aggregate.totals.attributedImageOutputBytes > 0);
  assert.equal(JSON.stringify(aggregate).includes("secret"), false);
  assert.match(formatPerformanceHistory(aggregate), /Aggregate metadata only/);
});

function event(timestamp, type, payload) {
  return { timestamp, type, payload };
}
