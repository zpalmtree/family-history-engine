#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseWorktreePorcelain(raw) {
  return String(raw)
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const entry = { path: null, head: null, branch: null, detached: false, prunable: false, prunableReason: null };
      for (const field of record.split("\0").filter(Boolean)) {
        const separator = field.indexOf(" ");
        const key = separator === -1 ? field : field.slice(0, separator);
        const value = separator === -1 ? true : field.slice(separator + 1);
        if (key === "worktree") entry.path = value;
        else if (key === "HEAD") entry.head = value;
        else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") entry.detached = true;
        else if (key === "prunable") {
          entry.prunable = true;
          entry.prunableReason = value === true ? null : value;
        }
      }
      return entry;
    });
}

export function buildWorktreeReport(entries, details, { baseRef = "main", generatedAt = new Date().toISOString() } = {}) {
  const worktrees = entries.map((entry) => {
    const detail = details.get(entry.path) || {};
    return {
      path: entry.path,
      branch: entry.branch,
      detached: entry.detached,
      head: entry.head,
      prunable: entry.prunable,
      prunableReason: entry.prunableReason,
      exists: detail.exists ?? false,
      state: detail.dirtyEntryCount == null ? "unavailable" : detail.dirtyEntryCount ? "dirty" : "clean",
      dirtyEntryCount: detail.dirtyEntryCount ?? null,
      mergedIntoBase: detail.mergedIntoBase ?? null,
      ahead: detail.ahead ?? null,
      behind: detail.behind ?? null,
      lastCommitAt: detail.lastCommitAt ?? null,
    };
  });
  return {
    schemaVersion: 1,
    generatedAt,
    baseRef,
    summary: {
      total: worktrees.length,
      clean: worktrees.filter((item) => item.state === "clean").length,
      dirty: worktrees.filter((item) => item.state === "dirty").length,
      unavailable: worktrees.filter((item) => item.state === "unavailable").length,
      prunable: worktrees.filter((item) => item.prunable).length,
      mergedIntoBase: worktrees.filter((item) => item.mergedIntoBase === true).length,
      unmerged: worktrees.filter((item) => item.mergedIntoBase === false).length,
    },
    worktrees,
  };
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args, cwd) {
  try {
    return { ok: true, output: runGit(args, cwd) };
  } catch {
    return { ok: false, output: "" };
  }
}

function inspectWorktree(entry, repository, baseRef) {
  const exists = Boolean(entry.path && fs.existsSync(entry.path));
  if (!exists || entry.prunable || !entry.head) return { exists };
  const status = tryGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], entry.path);
  const dirtyEntryCount = status.ok ? status.output.split("\0").filter(Boolean).length : null;
  const ancestor = tryGit(["merge-base", "--is-ancestor", entry.head, baseRef], repository);
  const divergence = tryGit(["rev-list", "--left-right", "--count", `${baseRef}...${entry.head}`], repository);
  const [behind, ahead] = divergence.ok ? divergence.output.split(/\s+/).map(Number) : [null, null];
  const committed = tryGit(["show", "-s", "--format=%cI", entry.head], repository);
  return {
    exists,
    dirtyEntryCount,
    mergedIntoBase: ancestor.ok,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    lastCommitAt: committed.ok ? committed.output : null,
  };
}

export function formatWorktreeReport(report) {
  const { summary } = report;
  const lines = [
    `Worktrees: ${summary.total} total; ${summary.clean} clean; ${summary.dirty} dirty; ${summary.prunable} prunable; ${summary.unmerged} unmerged into ${report.baseRef}.`,
  ];
  for (const item of report.worktrees) {
    const identity = item.branch || "detached";
    const divergence = item.ahead == null ? "divergence unavailable" : `ahead ${item.ahead}, behind ${item.behind}`;
    const merge = item.mergedIntoBase == null ? "merge unknown" : item.mergedIntoBase ? "merged" : "unmerged";
    const flags = [item.state, merge, divergence];
    if (item.prunable) flags.push("PRUNABLE");
    lines.push(`  ${identity} — ${flags.join("; ")} — ${item.path}`);
  }
  lines.push("Read-only report: no worktree was pruned, removed, reset, or modified.");
  return lines.join("\n");
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const repository = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  const baseRef = valueAfter(args, "--base") || "main";
  runGit(["rev-parse", "--verify", baseRef], repository);
  const raw = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = parseWorktreePorcelain(raw);
  const details = new Map(entries.map((entry) => [entry.path, inspectWorktree(entry, repository, baseRef)]));
  const report = buildWorktreeReport(entries, details, { baseRef });
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatWorktreeReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
