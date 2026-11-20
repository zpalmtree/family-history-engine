#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function classifyDeploymentCoverage({ targetSha, runs, isAncestor }) {
  const candidates = [];
  for (const run of runs || []) {
    if (!run.headSha) continue;
    const exact = run.headSha === targetSha || run.headSha.startsWith(targetSha) || targetSha.startsWith(run.headSha);
    const descendant = exact ? false : await isAncestor(targetSha, run.headSha);
    if (exact || descendant) candidates.push({ ...run, relation: exact ? "exact" : "descendant" });
  }
  candidates.sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
  const success = candidates.find((run) => run.conclusion === "success");
  if (success) return status("covered", targetSha, success, `A successful ${success.relation} main deployment covers the target.`);
  const pending = candidates.find((run) => ["queued", "in_progress", "pending", "waiting", "requested"].includes(run.status));
  if (pending) return status("pending", targetSha, pending, `A covering ${pending.relation} deployment is ${pending.status}.`);
  const failed = candidates.find((run) => run.conclusion && run.conclusion !== "cancelled" && run.conclusion !== "skipped");
  if (failed) return status("failed", targetSha, failed, `The latest covering deployment concluded ${failed.conclusion}.`);
  const cancelled = candidates.find((run) => run.conclusion === "cancelled");
  if (cancelled) return status("not-covered", targetSha, cancelled, "A covering run was cancelled or superseded; coverage requires a successful descendant.");
  return status("not-covered", targetSha, null, "No exact or descendant main deployment run was found.");
}

function status(coverage, targetSha, run, detail) {
  return {
    coverage,
    targetSha,
    relation: run?.relation || null,
    run: run ? { id: run.databaseId || run.id, headSha: run.headSha, status: run.status, conclusion: run.conclusion, url: run.url, createdAt: run.createdAt } : null,
    detail,
  };
}

export async function getDeploymentStatus(targetSha, { cwd = process.cwd() } = {}) {
  try {
    const raw = execFileSync("gh", ["run", "list", "--workflow", "deploy-viewer.yml", "--branch", "main", "--limit", "50", "--json", "databaseId,headSha,status,conclusion,url,createdAt"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    const runs = JSON.parse(raw);
    return await classifyDeploymentCoverage({ targetSha, runs, isAncestor: (ancestor, candidate) => isGitHubAncestor(ancestor, candidate, cwd) });
  } catch (error) {
    return { coverage: "unavailable", targetSha, relation: null, run: null, detail: String(error?.stderr || error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 500) };
  }
}

async function isGitHubAncestor(ancestor, candidate, cwd) {
  const local = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, candidate], { cwd, stdio: "ignore" });
  if (local.status === 0) return true;
  if (local.status === 1) return false;
  try {
    const repository = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
    const comparison = execFileSync("gh", ["api", `repos/${repository}/compare/${ancestor}...${candidate}`, "--jq", ".status"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
    return comparison === "ahead" || comparison === "identical";
  } catch { return false; }
}

function valueAfter(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

async function main() {
  const args = process.argv.slice(2);
  const targetSha = valueAfter(args, "--sha");
  if (!targetSha || !/^[0-9a-f]{7,40}$/i.test(targetSha)) throw new Error("--sha requires a 7 through 40 character Git commit SHA.");
  const result = await getDeploymentStatus(targetSha);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Deployment coverage for ${targetSha}: ${result.coverage}`);
    console.log(result.detail);
    if (result.run) console.log(`Run ${result.run.id}: ${result.run.status}/${result.run.conclusion || "pending"} ${result.run.url}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
