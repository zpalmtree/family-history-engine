#!/usr/bin/env node
// Release the public engine.
//
//   npm run engine:release -- --message "<what changed>"          dry run: shows what would change
//   npm run engine:release -- --message "<what changed>" --push   commits and pushes it
//
// Builds the privacy-gated export from HEAD (tools/engine-export.mjs; it
// refuses on any name, term or identifier from this tree), checks out the
// public repository named by tree.config.json engineExport.publicRepo,
// replaces its files with the export, and prints the change. Only --push
// commits (under a neutral author, never the owner's Git identity) and
// pushes. This repository's own history is never pushed anywhere public.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEngineExport, engineVersionFrom } from "./engine-export.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

const RELEASE_AUTHOR = ["-c", "user.name=family-history-engine", "-c", "user.email=family-history-engine@users.noreply.github.com"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const message = value("--message");
  const push = args.includes("--push");
  if (!message || !message.trim()) throw new Error('usage: npm run engine:release -- --message "<what changed>" [--push]');
  const repo = loadTreeConfig().engineExport?.publicRepo;
  if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error("Set engineExport.publicRepo (owner/name) in tree.config.json.");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "engine-release-"));
  const exportDir = path.join(work, "export");
  const cloneDir = path.join(work, "public");
  try {
    const result = buildEngineExport({ out: exportDir, ref: "HEAD" });
    if (result.violations.length) {
      for (const violation of result.violations.slice(0, 20)) console.error(`  ${violation.file}: ${violation.term} (${violation.reason})`);
      throw new Error("The privacy gate refused the export; nothing was released.");
    }
    run("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, cloneDir]);
    for (const file of run("git", ["ls-files", "-z"], { cwd: cloneDir }).split("\0").filter(Boolean)) fs.rmSync(path.join(cloneDir, file), { force: true });
    fs.cpSync(exportDir, cloneDir, { recursive: true });
    run("git", ["add", "-A"], { cwd: cloneDir });
    const stat = run("git", ["diff", "--cached", "--stat"], { cwd: cloneDir }).trim();
    if (!stat) {
      console.log(`The public engine at ${repo} already matches HEAD; nothing to release.`);
      return;
    }
    console.log(`Changes to ${repo}:\n${stat}`);
    if (!push) {
      console.log("Dry run: nothing was committed or pushed. Re-run with --push to release.");
      return;
    }
    run("git", [...RELEASE_AUTHOR, "commit", "--quiet", "-m", message], { cwd: cloneDir });
    // Pushed over SSH: a CLI OAuth token without the workflow scope cannot
    // update the repository's CI workflow.
    run("git", ["push", "--quiet", `git@github.com:${repo}.git`, "HEAD:main"], { cwd: cloneDir });
    // Tag the release with the changelog's version unless that tag exists.
    const version = engineVersionFrom();
    const tags = run("git", ["ls-remote", "--tags", `https://github.com/${repo}.git`, `refs/tags/v${version}`], { cwd: cloneDir }).trim();
    if (tags) console.log(`Tag v${version} already exists; add a new changelog heading to tag the next release.`);
    else {
      run("git", [...RELEASE_AUTHOR, "tag", "-a", `v${version}`, "-m", `family-history-engine ${version}`], { cwd: cloneDir });
      run("git", ["push", "--quiet", `git@github.com:${repo}.git`, `v${version}`], { cwd: cloneDir });
      console.log(`Tagged v${version}.`);
    }
    console.log(`Released to https://github.com/${repo}: ${run("git", ["rev-parse", "--short", "HEAD"], { cwd: cloneDir }).trim()}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
