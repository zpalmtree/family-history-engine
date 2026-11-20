#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopMirror } from "./tree-config.mjs";

// Incremental mirror of the project into the Windows Desktop copy.
//
// The Desktop copy sits on DrvFS, where every file operation is a slow 9P round
// trip: copying and re-hashing all ~8,000 files took about five minutes per
// commit. A per-clone manifest under .git records the hash and size of every
// file this tool last copied and verified, so a routine sync copies only files
// whose source hash changed, size-checks the rest concurrently, and removes
// files that left the project. A full byte-for-byte verification of the whole
// copy still runs at least once a day, and `--full` / `--check` keep the strict
// behaviour on demand.

// tree.config.json paths.desktopMirror; null means this tree keeps no mirror.
export const defaultTargetRoot = desktopMirror();
export const manifestVersion = 1;
export const fullVerifyIntervalMs = 24 * 60 * 60 * 1000;
const deletedSuffix = " (deleted locally)";

export function listProjectFiles(projectRoot) {
  const tracked = gitZ(projectRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const deletedFiles = new Set(gitZ(projectRoot, ["ls-files", "-z", "--deleted"]));
  const projectFiles = tracked.filter((relativePath) => !deletedFiles.has(relativePath)).sort();
  return { projectFiles: [...new Set(projectFiles)], deletedFiles };
}

export function defaultManifestPath(projectRoot) {
  const result = spawnSync("git", ["rev-parse", "--git-path", "desktop-sync-manifest.json"], { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git rev-parse --git-path failed: ${result.stderr || "unknown error"}`);
  return path.resolve(projectRoot, result.stdout.trim());
}

export function readManifest(manifestPath, targetRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.version !== manifestVersion || manifest.targetRoot !== targetRoot || typeof manifest.files !== "object") return null;
    return manifest;
  } catch {
    return null;
  }
}

export async function syncDesktop({
  projectRoot,
  targetRoot,
  mode = "sync",
  manifestPath = defaultManifestPath(projectRoot),
  now = Date.now(),
  concurrency = 32
}) {
  if (!["sync", "check", "full"].includes(mode)) throw new Error(`Unknown sync mode: ${mode}`);
  targetRoot = path.resolve(targetRoot);
  if (targetRoot === path.resolve(projectRoot)) throw new Error("Desktop sync target must be different from the project worktree");

  const { projectFiles, deletedFiles } = listProjectFiles(projectRoot);
  const source = new Map();
  for (const relativePath of projectFiles) {
    const sourcePath = path.join(projectRoot, relativePath);
    let stat;
    try { stat = fs.statSync(sourcePath); } catch { stat = null; }
    if (!stat?.isFile()) throw new Error(`tracked source file is missing or not a regular file: ${relativePath}`);
    source.set(relativePath, { sha256: sha256(fs.readFileSync(sourcePath)), size: stat.size });
  }

  if (mode === "check") {
    const mismatches = await verifyAll({ source, targetRoot, deletedFiles, concurrency });
    if (mismatches.length) throw mismatchError("differs from", mismatches);
    return { mode, files: projectFiles.length, copied: 0, removed: 0, unchanged: projectFiles.length, deletedPending: deletedFiles.size, verifiedAll: true };
  }

  const manifest = mode === "full" ? null : readManifest(manifestPath, targetRoot);
  const verifyEverything = !manifest || !(now - Date.parse(manifest.lastFullVerifiedAt || 0) < fullVerifyIntervalMs);
  const toCopy = [];
  let unchanged = 0;

  if (mode === "full") {
    toCopy.push(...projectFiles);
  } else if (verifyEverything) {
    // No trustworthy manifest (first run, new target, or daily re-verify):
    // hash every target file and copy only the ones that differ.
    await pool(projectFiles, concurrency, async (relativePath) => {
      const targetHash = await hashIfFile(path.join(targetRoot, relativePath));
      if (targetHash === source.get(relativePath).sha256) unchanged += 1;
      else toCopy.push(relativePath);
    });
  } else {
    await pool(projectFiles, concurrency, async (relativePath) => {
      const current = source.get(relativePath);
      const recorded = manifest.files[relativePath];
      if (!recorded || recorded.sha256 !== current.sha256) {
        toCopy.push(relativePath);
        return;
      }
      const targetStat = await fs.promises.stat(path.join(targetRoot, relativePath)).catch(() => null);
      if (targetStat?.isFile() && targetStat.size === recorded.size) unchanged += 1;
      else toCopy.push(relativePath);
    });
  }
  toCopy.sort();

  try {
    await pool(toCopy, concurrency, async (relativePath) => {
      const targetPath = path.join(targetRoot, relativePath);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.copyFile(path.join(projectRoot, relativePath), targetPath);
    });

    // Files that left the project: working-tree deletions (as before) plus
    // files this tool previously mirrored that are no longer project files.
    const removals = new Set(deletedFiles);
    if (manifest) {
      for (const relativePath of Object.keys(manifest.files)) {
        if (!source.has(relativePath)) removals.add(relativePath);
      }
    }
    let removed = 0;
    for (const relativePath of [...removals].sort()) {
      const targetPath = path.join(targetRoot, relativePath);
      const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
      if (!stat) continue;
      if (!stat.isFile()) throw new Error(`deleted project path is not a regular file in the Desktop copy: ${relativePath}`);
      fs.rmSync(targetPath);
      removed += 1;
    }

    const mismatches = await verifyFiles(toCopy, { source, targetRoot, concurrency });
    for (const relativePath of deletedFiles) {
      if (fs.existsSync(path.join(targetRoot, relativePath))) mismatches.push(`${relativePath}${deletedSuffix}`);
    }
    // DrvFS/NTFS can briefly expose the previous bytes immediately after a
    // copy. Recheck the bounded mismatch set before failing.
    const stillMismatched = [];
    for (const entry of mismatches) {
      if (entry.endsWith(deletedSuffix)) {
        if (fs.existsSync(path.join(targetRoot, entry.slice(0, -deletedSuffix.length)))) stillMismatched.push(entry);
      } else if (await hashIfFile(path.join(targetRoot, entry)) !== source.get(entry).sha256) {
        stillMismatched.push(entry);
      }
    }
    if (stillMismatched.length) throw mismatchError("failed verification against", stillMismatched);

    const files = {};
    for (const relativePath of projectFiles) files[relativePath] = source.get(relativePath);
    writeManifest(manifestPath, {
      version: manifestVersion,
      targetRoot,
      lastSyncedAt: new Date(now).toISOString(),
      lastFullVerifiedAt: verifyEverything || mode === "full"
        ? new Date(now).toISOString()
        : manifest.lastFullVerifiedAt,
      files
    });
    return {
      mode,
      files: projectFiles.length,
      copied: toCopy.length,
      removed,
      unchanged,
      deletedPending: deletedFiles.size,
      verifiedAll: verifyEverything || mode === "full"
    };
  } catch (error) {
    // A partial sync leaves the copy in an unknown state; force the next run
    // to re-verify every file rather than trust stale manifest entries.
    fs.rmSync(manifestPath, { force: true });
    throw error;
  }
}

async function verifyAll({ source, targetRoot, deletedFiles, concurrency }) {
  const mismatches = await verifyFiles([...source.keys()], { source, targetRoot, concurrency });
  for (const relativePath of [...deletedFiles].sort()) {
    if (fs.existsSync(path.join(targetRoot, relativePath))) mismatches.push(`${relativePath}${deletedSuffix}`);
  }
  return mismatches;
}

async function verifyFiles(relativePaths, { source, targetRoot, concurrency }) {
  const mismatches = [];
  await pool(relativePaths, concurrency, async (relativePath) => {
    if (await hashIfFile(path.join(targetRoot, relativePath)) !== source.get(relativePath).sha256) mismatches.push(relativePath);
  });
  return mismatches.sort();
}

async function hashIfFile(filePath) {
  try {
    return sha256(await fs.promises.readFile(filePath));
  } catch {
    return null;
  }
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`);
  fs.renameSync(temporary, manifestPath);
}

function mismatchError(verb, mismatches) {
  return new Error(
    `Desktop copy ${verb} the worktree for ${mismatches.length} tracked file(s):\n`
      + mismatches.map((file) => `- ${file}`).join("\n")
  );
}

// spawnSync buffers at most 1 MiB of stdout by default. The NUL-separated
// file list passed that on 8 Nov 2026 (11,000+ paths), and the overflow
// surfaced only as "unknown error" with a null status, so every Desktop sync
// silently stopped. Allow far more than the project will plausibly reach.
export const gitOutputMaxBuffer = 256 * 1024 * 1024;

function gitZ(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: gitOutputMaxBuffer });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString() || "unknown error"}`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const targetArgIndex = args.indexOf("--target");
  const configuredTarget = targetArgIndex >= 0 ? args[targetArgIndex + 1] : "";
  if (targetArgIndex >= 0 && !configuredTarget) throw new Error("--target requires a destination directory");
  if (args.includes("--check") && args.includes("--full")) throw new Error("--check and --full are mutually exclusive");
  const chosenTarget = configuredTarget || process.env.FAMILY_HISTORY_WINDOWS_COPY || defaultTargetRoot;
  if (!chosenTarget) {
    console.log("No Desktop mirror is configured (tree.config.json paths.desktopMirror); nothing to sync.");
    return;
  }
  const targetRoot = path.resolve(chosenTarget);
  const mode = args.includes("--check") ? "check" : args.includes("--full") ? "full" : "sync";
  const started = Date.now();
  const result = await syncDesktop({ projectRoot, targetRoot, mode });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (mode === "check") {
    console.log(`Desktop copy verified: ${result.files} current project files match ${targetRoot}; ${result.deletedPending} pending deletion(s) absent (${seconds}s)`);
  } else {
    console.log(
      `Desktop copy synced and verified: ${result.copied} changed file(s) copied, ${result.removed} removed, `
        + `${result.unchanged} unchanged (${result.verifiedAll ? "hash-verified" : "size-checked against the sync manifest"}) `
        + `of ${result.files} at ${targetRoot} (${seconds}s)`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
