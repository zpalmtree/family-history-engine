import assert from "node:assert/strict";
import test from "node:test";

import { buildWorktreeReport, formatWorktreeReport, parseWorktreePorcelain } from "./worktree-status.mjs";

test("parseWorktreePorcelain preserves branch, detached, and prunable state", () => {
  const raw = [
    "worktree /repo", "HEAD abc", "branch refs/heads/main", "",
    "worktree /tmp/lane", "HEAD def", "detached", "prunable missing administrative file", "",
  ].join("\0");
  assert.deepEqual(parseWorktreePorcelain(raw), [
    { path: "/repo", head: "abc", branch: "main", detached: false, prunable: false, prunableReason: null },
    { path: "/tmp/lane", head: "def", branch: null, detached: true, prunable: true, prunableReason: "missing administrative file" },
  ]);
});

test("buildWorktreeReport exposes only aggregate dirty state and never proposes cleanup", () => {
  const entries = parseWorktreePorcelain("worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/lane\0HEAD def\0branch refs/heads/topic\0\0");
  const details = new Map([
    ["/repo", { exists: true, dirtyEntryCount: 0, mergedIntoBase: true, ahead: 0, behind: 0, lastCommitAt: "2026-07-20T00:00:00Z" }],
    ["/tmp/lane", { exists: true, dirtyEntryCount: 3, mergedIntoBase: false, ahead: 2, behind: 1, lastCommitAt: "2026-07-19T00:00:00Z" }],
  ]);
  const report = buildWorktreeReport(entries, details, { baseRef: "main", generatedAt: "2026-07-20T01:00:00Z" });
  assert.deepEqual(report.summary, { total: 2, clean: 1, dirty: 1, unavailable: 0, prunable: 0, mergedIntoBase: 1, unmerged: 1 });
  assert.equal(report.worktrees[1].dirtyEntryCount, 3);
  assert.equal(Object.hasOwn(report.worktrees[1], "dirtyPaths"), false);
  assert.match(formatWorktreeReport(report), /Read-only report/);
  assert.doesNotMatch(formatWorktreeReport(report), /git worktree (remove|prune)/);
});
