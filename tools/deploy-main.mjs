#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultQueueWaitMs, joinDeployQueue } from "./deploy-queue.mjs";
import { getDeploymentStatus } from "./deploy-status.mjs";
import { REGISTRY_PATHS, registryOverrides, scratchDirectory } from "./registry-rows.mjs";
import { primaryCheckout } from "./tree-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// tree.config.json paths.primaryCheckout; null lets any checkout of the tree write.
export const primaryMainCheckout = primaryCheckout();
// The directory this module runs from: the primary checkout normally, a temporary export during
// deploy:main validation.
export const repositoryRoot = root;
const fixedGeneratedPaths = new Set([
  "data/family-data.js",
  "data/family/people.json",
  "data/family/relationships.json",
  "data/family/tree.json",
  "data/tree-layouts.js",
  "evidence/acquisition-session-queue.json",
  "evidence/source-atoms.json",
  "evidence/viewer-sources.json",
  "viewer-deploy-fingerprint.json"
]);

// Planning documents that no generator, validator, viewer build or life-story
// job reads. A commit made only of these files cannot stale a derived
// artifact, so --docs-only may skip the regeneration/validation pipeline and
// tolerate another session's unstaged work in the shared checkout.
export const docsOnlyPrefixes = ["evidence/research/briefs/"];

// Deployment runs in GitHub Actions after the push. Waiting for it used to be
// the default, which kept a research session idle for several minutes per
// commit and regularly outlived the caller's shell timeout. Waiting is now
// opt-in (--wait, or an explicit --timeout-seconds); check coverage later with
// `npm run deploy:status -- --sha <sha>`.
export const defaultWaitSeconds = 900;
export const maxPathAttempts = 8;

export function parseArguments(args) {
  const message = valueAfter(args, "--message");
  const explicitTimeout = valueAfter(args, "--timeout-seconds");
  const docsOnly = args.includes("--docs-only");
  const isolated = args.includes("--isolated");
  const paths = pathsAfter(args);
  const contents = contentOverridesAfter(args);
  const records = recordsAfter(args);
  const timeoutSeconds = Number(explicitTimeout ?? (args.includes("--wait") ? defaultWaitSeconds : 0));
  if (!message?.trim()) throw new Error('Usage: npm run deploy:main -- --message "Commit message" [--paths <file-or-folder> ...] [--records <record-id> ...] [--wait | --timeout-seconds <n>] [--docs-only | --isolated]');
  if (isolated && (paths.length || contents.length || records.length)) throw new Error("--paths already isolates the commit; drop --isolated.");
  if (docsOnly && records.length) throw new Error("--records is for registry rows; --docs-only commits only planning documents.");
  if (docsOnly && contents.length) throw new Error("--content is for canonical files; --docs-only commits only planning documents.");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("--timeout-seconds must be a non-negative number.");
  }
  if (docsOnly && timeoutSeconds > 0) {
    throw new Error("--docs-only commits publish no viewer artifact, so --wait/--timeout-seconds do not apply.");
  }
  if (docsOnly && isolated) throw new Error("--docs-only and --isolated are different paths; pass one.");
  return { message: message.trim(), timeoutMs: timeoutSeconds * 1000, docsOnly, isolated, paths, contents, records };
}

// --content <repo-path>=<file> commits that repository path with the content of another file
// (for example HEAD's copy of a shared registry plus only this session's entries, written to a
// scratch file) instead of the working-tree copy, which a concurrent session may be rewriting.
// It implies paths mode; the working-tree file itself is never read, staged or refreshed.
export function contentOverridesAfter(args) {
  const overrides = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--content") continue;
    const value = args[index + 1];
    const split = typeof value === "string" ? value.indexOf("=") : -1;
    if (split <= 0 || split === value.length - 1) throw new Error("--content takes <repo-path>=<source-file>.");
    const source = value.slice(split + 1);
    if (!path.isAbsolute(source)) throw new Error(`--content source must be an absolute path: ${source}`);
    overrides.push({ path: normalizeCommitPath(value.slice(0, split)), source });
  }
  const seen = new Set();
  for (const override of overrides) {
    if (seen.has(override.path)) throw new Error(`--content names ${override.path} twice.`);
    seen.add(override.path);
  }
  return overrides;
}

// --records takes every following argument up to the next flag: record or target ids whose rows
// in the shared registry files (records manifest, subscription and recovery queues, Blob
// inventory, extraction campaign, kinship baseline) are committed as HEAD plus exactly those
// rows, so a concurrent session's uncommitted rows in the same files never enter the commit.
export function recordsAfter(args) {
  const ids = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--records") continue;
    for (let next = index + 1; next < args.length && !args[next].startsWith("--"); next += 1) ids.push(args[next]);
  }
  for (const id of ids) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error(`--records takes record ids: ${id}`);
  return [...new Set(ids)];
}

// --paths takes every following argument up to the next flag; --path takes one and may repeat.
export function pathsAfter(args) {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--path" && args[index + 1] !== undefined) paths.push(args[index + 1]);
    if (args[index] !== "--paths") continue;
    for (let next = index + 1; next < args.length && !args[next].startsWith("--"); next += 1) paths.push(args[next]);
  }
  return paths.map(normalizeCommitPath);
}

export function normalizeCommitPath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Empty path given to --paths.");
  let relative = value.trim().replace(/\\/g, "/");
  if (path.isAbsolute(relative)) relative = path.relative(root, relative);
  relative = relative.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  const segments = relative.split("/");
  if (!relative || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`--paths entries must be repository-relative paths without "..": ${value}`);
  }
  if (relative === ".git" || relative.startsWith(".git/")) throw new Error("--paths may not name the .git directory.");
  return relative;
}

// Expand the named entries to the exact files the commit may contain: every tracked or
// untracked (not ignored) file under a folder, a file as itself, and a tracked path that no
// longer exists as a deletion. Anything else is a mistake worth stopping for.
export function expandPathEntries(entries, { isDirectory, exists, listDirectory, isTracked }) {
  const files = new Set();
  for (const entry of entries) {
    if (isDirectory(entry)) {
      const listed = listDirectory(entry);
      if (!listed.length) throw new Error(`--paths folder has no tracked or unignored files: ${entry}`);
      for (const file of listed) files.add(file);
    } else if (exists(entry) || isTracked(entry)) {
      files.add(entry);
    } else {
      throw new Error(`--paths entry is neither a working-tree file nor a tracked path: ${entry}`);
    }
  }
  return [...files].sort();
}

export function parsePorcelainZ(value) {
  const tokens = value.toString("utf8").split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const x = token[0];
    const y = token[1];
    const file = token.slice(3);
    entries.push({ x, y, file });
    if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
  }
  return entries;
}

export function partitionStatus(entries, generatedPaths) {
  const staged = entries.filter((entry) => entry.x !== " " && entry.x !== "?");
  const unstaged = entries.filter((entry) => entry.y !== " " || entry.x === "?");
  const unexpected = unstaged.filter((entry) => !generatedPaths.has(entry.file));
  return { staged, unstaged, unexpected };
}

export function generatedPathsFor(branches) {
  return new Set([
    ...fixedGeneratedPaths,
    ...(branches?.branches || []).map((branch) => branch.currentStateFile)
  ]);
}

export function isDocsOnlyPath(file) {
  if (typeof file !== "string" || !file || file.includes("\\")) return false;
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (!/\.md$/i.test(file)) return false;
  return docsOnlyPrefixes.some((prefix) => file.startsWith(prefix));
}

// --docs-only accepts the staged set only when every staged path is a planning
// document and none of those documents has further unstaged edits (a partial
// stage would commit a version the author is not looking at). Other sessions'
// unrelated unstaged or untracked files are tolerated and left untouched.
export function assertDocsOnlyStaged(entries) {
  const staged = entries.filter((entry) => entry.x !== " " && entry.x !== "?");
  if (!staged.length) throw new Error("Stage the intended planning documents before running deploy:main --docs-only.");
  const foreign = staged.filter((entry) => !isDocsOnlyPath(entry.file));
  if (foreign.length) {
    throw new Error(`--docs-only accepts only markdown under ${docsOnlyPrefixes.join(", ")}; unstage or use the full deploy:main for:\n${formatEntries(foreign)}`);
  }
  const partial = staged.filter((entry) => entry.y !== " ");
  if (partial.length) {
    throw new Error(`These staged documents also have unstaged edits; stage the final version first:\n${formatEntries(partial)}`);
  }
  return staged.map((entry) => entry.file);
}

export function assertCommitIsDocsOnly(committedFiles) {
  const foreign = committedFiles.filter((file) => !isDocsOnlyPath(file));
  if (foreign.length) {
    throw new Error(`The docs-only commit touched non-document paths; not pushing:\n${foreign.map((file) => `- ${file}`).join("\n")}`);
  }
}

// Isolated mode: the shared checkout usually carries other sessions' work in
// progress. Only the staged set is this commit's business, so the staged tree
// (HEAD plus the index) is exported to a temporary directory, built and
// validated there, and committed straight from the index. The foreign entries
// are never read, staged, stashed or rewritten. A staged file with further
// unstaged edits is refused because the author would commit a version they are
// not looking at.
export function partitionForIsolation(entries) {
  const staged = entries.filter((entry) => entry.x !== " " && entry.x !== "?");
  const partial = staged.filter((entry) => entry.y !== " ");
  const stagedFiles = new Set(staged.map((entry) => entry.file));
  const foreign = entries.filter((entry) => !stagedFiles.has(entry.file) && (entry.y !== " " || entry.x === "?"));
  return { staged: staged.map((entry) => entry.file), partial, foreign };
}

export function parseDiffTreeNameStatus(text) {
  return text.toString("utf8").split("\0").reduce((changes, token, index, tokens) => {
    if (!token || !/^[A-Z]/.test(token) || token.length !== 1) return changes;
    const file = tokens[index + 1];
    if (file) changes.push({ status: token, file });
    return changes;
  }, []);
}

export function classifyGeneratedChanges(changes, generatedPaths) {
  const generated = changes.filter((change) => generatedPaths.has(change.file));
  const unexpected = changes.filter((change) => !generatedPaths.has(change.file));
  return { generated, unexpected };
}

export function parseLsTreeLine(line) {
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(line);
  if (!match) throw new Error(`Unexpected ls-tree line: ${line}`);
  return { mode: match[1], type: match[2], object: match[3], file: match[4] };
}

export function assertPrimaryMainCheckout(checkoutRoot, branch, primary = primaryMainCheckout) {
  if (primary && path.resolve(checkoutRoot) !== primary) {
    throw new Error(`deploy:main must run from the primary checkout at ${primary}; current checkout is ${path.resolve(checkoutRoot)}.`);
  }
  if (branch !== "main") {
    throw new Error(`deploy:main only publishes main; current branch is ${branch || "detached HEAD"}.`);
  }
}

export async function waitForDeployment(sha, {
  timeoutMs = 900_000,
  intervalMs = 10_000,
  getStatus = (target) => getDeploymentStatus(target, { cwd: root }),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await getStatus(sha);
    reportDeployment(latest);
    if (latest.coverage === "covered") return latest;
    if (latest.coverage === "failed") {
      throw new Error(`Production deployment failed${latest.run?.url ? `: ${latest.run.url}` : "."}`);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`Timed out waiting for production coverage of ${sha}. Run npm run deploy:status -- --sha ${sha}.`);
}

async function main() {
  const { message, timeoutMs, docsOnly, isolated, paths, contents, records } = parseArguments(process.argv.slice(2));
  const branches = JSON.parse(fs.readFileSync(path.join(root, "evidence", "research", "branches.json"), "utf8"));
  const generatedPaths = generatedPathsFor(branches);

  requireOutput("gh", ["auth", "status"]);
  const checkoutRoot = requireOutput("git", ["rev-parse", "--show-toplevel"]).trim();
  const branch = requireOutput("git", ["branch", "--show-current"]).trim();
  assertPrimaryMainCheckout(checkoutRoot, branch);

  // One deploy at a time (tools/deploy-queue.mjs): wait for any deploy already running, so this
  // one reads the HEAD it leaves and validates once instead of being thrown away by its commit.
  const queue = await enterDeployQueue(message);
  try {
    await deployInTurn({ message, timeoutMs, docsOnly, isolated, paths, contents, records, generatedPaths }, queue);
  } finally {
    await queue.release();
  }
}

export function queueSettings(env = process.env) {
  const seconds = Number(env.DEPLOY_MAIN_QUEUE_WAIT_SECONDS);
  return {
    enabled: env.DEPLOY_MAIN_QUEUE !== "off",
    waitMs: env.DEPLOY_MAIN_QUEUE_WAIT_SECONDS && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultQueueWaitMs
  };
}

async function enterDeployQueue(message) {
  const { enabled, waitMs } = queueSettings();
  if (!enabled) {
    console.log("queue: DEPLOY_MAIN_QUEUE=off, so this deploy does not wait its turn; another session's commit may overtake it.");
    return { held: false, release: async () => {} };
  }
  const gitDirectory = path.resolve(root, requireOutput("git", ["rev-parse", "--git-common-dir"]).trim());
  const queue = await joinDeployQueue({
    lockFile: path.join(gitDirectory, "deploy-main.queue"),
    label: message.split("\n")[0].slice(0, 80),
    waitMs
  });
  if (queue.held && queue.waitedMs >= 2_000) {
    console.log(`queue: this deploy's turn after waiting ${Math.round(queue.waitedMs / 1000)} s.`);
  } else if (!queue.held) {
    console.log(queue.reason === "timeout"
      ? `queue: still not this deploy's turn after ${Math.round(queue.waitedMs / 1000)} s; going ahead without it, as deploys did before the queue.`
      : "queue: flock is not available here, so deploys are not queued; going ahead as deploys did before the queue.");
  }
  return queue;
}

// The deploy itself, run while this process holds the queue. The queue is released as soon as
// the push has landed: waiting on the hosting run needs no turn.
async function deployInTurn({ message, timeoutMs, docsOnly, isolated, paths, contents, records, generatedPaths }, queue) {
  // Another session moves the shared local main a moment before its push lands; wait (bounded)
  // for an in-flight push instead of refusing to start.
  let head = "";
  let remote = "";
  for (let wait = 0; wait < 24; wait += 1) {
    run("git", ["fetch", "origin", "main"]);
    head = requireOutput("git", ["rev-parse", "HEAD"]).trim();
    remote = requireOutput("git", ["rev-parse", "origin/main"]).trim();
    if (head === remote) break;
    spawnSync("sleep", ["5"]);
  }
  if (head !== remote) {
    throw new Error("Local main must exactly match origin/main before deploy:main starts. Reconcile existing local commits first.");
  }

  if (paths.length || contents.length || records.length) {
    // Other sessions commit every few minutes; a build-and-validate pass takes several. When one
    // lands mid-run the pass is repeated on the new HEAD; with five sessions active three tries
    // were often all overtaken, so the limit is generous (each retry needs no human).
    let sha;
    for (let attempt = 1; ; attempt += 1) {
      try {
        sha = commitFromPaths(message, paths, { docsOnly, generatedPaths, contents, records });
        break;
      } catch (error) {
        if (!error.concurrent || attempt >= maxPathAttempts) throw error;
        console.log(`paths: ${error.message.split("\n")[0]} Retrying on the new HEAD (attempt ${attempt + 1} of ${maxPathAttempts}).`);
        // The other session moves the shared local main a moment before its push lands, so give
        // an in-flight push up to two minutes to arrive before treating a mismatch as real.
        let matched = false;
        for (let wait = 0; wait < 24 && !matched; wait += 1) {
          run("git", ["fetch", "origin", "main"]);
          matched = requireOutput("git", ["rev-parse", "HEAD"]).trim() === requireOutput("git", ["rev-parse", "origin/main"]).trim();
          if (!matched) spawnSync("sleep", ["5"]);
        }
        if (!matched) throw new Error("Local main no longer matches origin/main; reconcile before retrying.");
      }
    }
    await queue.release();
    if (timeoutMs) await waitForDeployment(sha, { timeoutMs });
    return;
  }

  if (docsOnly) {
    commitDocsOnly(message);
    return;
  }

  const initial = partitionStatus(status(), generatedPaths);
  if (initial.unstaged.length) {
    console.log("hint: pass --paths <files or folders> to commit exactly your own changes without staging; the shared index then plays no part.");
  }
  if (!initial.staged.length) throw new Error("Stage the intended source changes before running deploy:main.");
  if (isolated || initial.unstaged.length) {
    const sha = commitIsolated(message, generatedPaths);
    await queue.release();
    if (timeoutMs) await waitForDeployment(sha, { timeoutMs });
    return;
  }

  run("npm", ["run", "build"]);
  run("npm", ["run", "site:stage"]);

  const generated = partitionStatus(status(), generatedPaths);
  if (generated.unexpected.length) {
    throw new Error(`A generator changed files outside the deployment allowlist; nothing was committed:\n${formatEntries(generated.unexpected)}`);
  }
  const generatedFiles = [...new Set(generated.unstaged.map((entry) => entry.file))];
  if (generatedFiles.length) run("git", ["add", "--", ...generatedFiles]);

  run("npm", ["run", "site:check"]);
  run("npm", ["run", "sync:win"]);
  assertReadyToCommit(generatedPaths);
  run("git", ["diff", "--cached", "--check"]);
  run("git", ["commit", "-m", message]);

  const sha = requireOutput("git", ["rev-parse", "HEAD"]).trim();
  run("npm", ["run", "handoff:check"]);
  const afterCommit = status();
  if (afterCommit.length) {
    throw new Error(`The committed handoff was not reproducible; refusing to push:\n${formatEntries(afterCommit)}`);
  }

  run("git", ["push", "origin", "main"]);
  await queue.release();
  if (!timeoutMs) {
    console.log(`Pushed ${sha}. Complete publication using the active deployment mode documented in VIEWER.md.`);
    return;
  }
  console.log(`Pushed ${sha}; waiting for protected production deployment coverage.`);
  await waitForDeployment(sha, { timeoutMs });
  console.log(`Deployment complete for ${sha}.`);
}

// --paths: the commit is HEAD plus exactly the named working-tree paths, assembled in a
// private index. Nothing another session has staged, modified or created can enter or block
// it, and the shared index is touched only afterwards, to mark the committed paths clean. The
// tree is built and validated in a temporary export exactly as in isolated mode and the commit
// is written with commit-tree/update-ref so no hook or index-wide operation runs.
function commitFromPaths(message, entries, { docsOnly, generatedPaths, contents: explicitContents = [], records = [] }) {
  const named = [...entries, ...explicitContents.map((override) => override.path)];
  const registryNamed = named.filter((entry) => REGISTRY_PATHS.includes(entry));
  if (records.length && registryNamed.length) {
    throw new Error(`--records commits the registry rows itself; drop these from --paths/--content: ${registryNamed.join(", ")}`);
  }
  let rowScratch = null;
  const files = expandPathEntries(entries, {
    isDirectory: (entry) => fs.existsSync(path.join(root, entry)) && fs.statSync(path.join(root, entry)).isDirectory(),
    exists: (entry) => fs.existsSync(path.join(root, entry)),
    listDirectory: (entry) => requireBuffer("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", entry]).toString("utf8").split("\0").filter(Boolean),
    isTracked: (entry) => spawnSync("git", ["cat-file", "-e", `HEAD:${entry}`], { cwd: root, stdio: "ignore" }).status === 0
  });
  if (docsOnly) {
    const foreign = files.filter((file) => !isDocsOnlyPath(file));
    if (foreign.length) throw new Error(`--docs-only accepts only markdown under ${docsOnlyPrefixes.join(", ")}:\n${foreign.map((file) => `- ${file}`).join("\n")}`);
  }
  const before = repositoryState();
  rowScratch = records.length ? scratchDirectory() : null;
  const rowOverrides = records.length ? registryOverrides(records, {
    readHead: (file) => { const shown = spawnSync("git", ["show", `${before.head}:${file}`], { cwd: root, maxBuffer: 1 << 30 }); return shown.status === 0 ? shown.stdout.toString("utf8") : null; },
    readWork: (file) => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : null,
    outDir: rowScratch,
  }) : [];
  if (records.length) console.log(`records: committing HEAD plus ${records.length} named row id(s) in ${rowOverrides.map((override) => override.path).join(", ") || "no registry file"}.`);
  const contents = [...explicitContents, ...rowOverrides];
  const overridden = new Set(contents.map((override) => override.path));
  const sharedIndexTree = requireOutput("git", ["write-tree"]).trim();
  const privateIndex = path.join(os.tmpdir(), `deploy-main-paths-${process.pid}-${Date.now()}.index`);
  const privateEnv = { ...process.env, GIT_INDEX_FILE: privateIndex };
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-paths-"));
  const exportIndex = `${exportDir}.index`;
  try {
    if (files.some((file) => overridden.has(file))) throw new Error("A path may not be named by both --paths and --content.");
    runPrivate(privateEnv, ["read-tree", before.head]);
    if (files.length) runPrivate(privateEnv, ["update-index", "--add", "--remove", "--", ...files]);
    for (const override of contents) {
      if (!fs.existsSync(override.source)) throw new Error(`--content source does not exist: ${override.source}`);
      const blob = requireOutput("git", ["hash-object", "-w", "--", override.source]).trim();
      runPrivate(privateEnv, ["update-index", "--add", "--cacheinfo", `100644,${blob},${override.path}`]);
    }
    const stagedTree = outputPrivate(privateEnv, ["write-tree"]).trim();
    const headTree = requireOutput("git", ["rev-parse", `${before.head}^{tree}`]).trim();
    if (stagedTree === headTree) throw new Error("The named paths are identical to HEAD; nothing to commit.");
    runPrivate(privateEnv, ["diff", "--cached", "--check"]);
    console.log(`paths: committing ${files.length} file(s) from HEAD plus the named paths; the shared index and other sessions' files play no part.`);

    let committedTree = stagedTree;
    let generated = [];
    if (!docsOnly) {
      runPrivate(privateEnv, ["checkout-index", "-a", "-f", `--prefix=${exportDir}/`]);
      fs.symlinkSync(path.join(root, "node_modules"), path.join(exportDir, "node_modules"), "dir");
      const exportEnv = { ...process.env, VALIDATION_STAMPS: "off", DEPLOY_MAIN_HEAD_SHA: before.head };
      delete exportEnv.GIT_DIR;
      delete exportEnv.GIT_WORK_TREE;
      delete exportEnv.GIT_INDEX_FILE;
      runIn(exportDir, "npm", ["run", "build"], exportEnv);
      runIn(exportDir, "npm", ["run", "site:stage"], exportEnv);
      const exportTree = treeOfDirectory(exportDir, exportIndex, privateIndex);
      const changes = parseDiffTreeNameStatus(requireBuffer("git", ["diff-tree", "-r", "-z", "--name-status", stagedTree, exportTree]));
      const classified = classifyGeneratedChanges(changes, generatedPaths);
      if (classified.unexpected.length) {
        throw new Error(`A generator changed files outside the deployment allowlist; nothing was committed:\n${classified.unexpected.map((change) => `- ${change.status} ${change.file}`).join("\n")}`);
      }
      generated = classified.generated;
      runIn(exportDir, "npm", ["run", "site:check:full"], exportEnv);
      committedTree = exportTree;
    }
    assertRepositoryUntouched(before, sharedIndexTree, { checkIndex: false });

    // Working-tree entries that were already dirty before this commit belong to someone else and
    // are never refreshed; the set must be taken before HEAD moves, or every regenerated file
    // would look dirty against the new HEAD and be skipped.
    const dirtyBefore = new Set(status().map((entry) => entry.file));
    const sha = requireOutput("git", ["commit-tree", committedTree, "-p", before.head, "-m", message]).trim();
    run("git", ["update-ref", "-m", "deploy:main --paths", "refs/heads/main", sha, before.head]);

    // Mark the committed paths clean in the shared index and refresh the regenerated files that
    // nobody else had modified; everything else in the working tree is left exactly as it was.
    // --content paths keep their concurrent working-tree copies: they are not marked clean.
    const present = files.filter((file) => fs.existsSync(path.join(root, file)));
    const removed = files.filter((file) => !fs.existsSync(path.join(root, file)));
    if (present.length) run("git", ["update-index", "--add", "--", ...present]);
    if (removed.length) run("git", ["update-index", "--force-remove", "--", ...removed]);
    const refresh = generated.map((change) => change.file).filter((file) => !overridden.has(file) && (!dirtyBefore.has(file) || files.includes(file)));
    if (refresh.length) run("git", ["checkout", "HEAD", "--", ...refresh]);

    if (!docsOnly) syncDesktopFromExport(exportDir);
    run("git", ["push", "--no-verify", "origin", "main"]);
    console.log(`Pushed ${sha} (paths mode: ${files.length} named file(s); tree ${committedTree.slice(0, 12)} ${docsOnly ? "committed as planning documents without regeneration" : "built and validated in a temporary export"}; the shared index and other sessions' files were not read). Complete publication using the active deployment mode documented in VIEWER.md.`);
    return sha;
  } finally {
    if (rowScratch) fs.rmSync(rowScratch, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
    fs.rmSync(exportIndex, { force: true });
    fs.rmSync(privateIndex, { force: true });
  }
}

function runPrivate(env, args) {
  console.log(`\n> git [private index] ${args.map(quoteForDisplay).join(" ")}`);
  const result = spawnSync("git", args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} exited with status ${result.status} on the private index.`);
}

function outputPrivate(env, args) {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} exited with status ${result.status} on the private index.`);
  return result.stdout;
}

// Build and validate exactly the tree that will be committed, in a temporary
// export of the index, so that another session's unstaged work can neither
// leak into the generated artifacts nor block this commit. The generated
// outputs are written back into the index as objects (never into the working
// tree), the index tree is required to equal the validated export tree, and
// the push skips the pre-push hook because that hook validates the working
// tree, which is not what is being pushed; the equivalent gate has already run
// on the exact committed content.
function commitIsolated(message, generatedPaths) {
  const { staged, partial, foreign } = partitionForIsolation(status());
  if (!staged.length) throw new Error("Stage the intended source changes before running deploy:main.");
  if (partial.length) {
    throw new Error(`These staged files also have unstaged edits; stage the final version first:\n${formatEntries(partial)}`);
  }
  console.log(`isolated: ${staged.length} staged file(s); ${foreign.length} unrelated working-tree entr${foreign.length === 1 ? "y is" : "ies are"} left untouched.`);
  run("git", ["diff", "--cached", "--check"]);
  const stagedTree = requireOutput("git", ["write-tree"]).trim();
  const before = repositoryState();

  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-isolated-"));
  const exportIndex = `${exportDir}.index`;
  try {
    run("git", ["checkout-index", "-a", "-f", `--prefix=${exportDir}/`]);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(exportDir, "node_modules"), "dir");
    // No GIT_* variable reaches the export: the test suite initialises its own temporary
    // repositories, and an inherited GIT_DIR once pointed a fixture's "git init" and "git commit"
    // at the real repository. Tools that only need HEAD read DEPLOY_MAIN_HEAD_SHA instead.
    const exportEnv = { ...process.env, VALIDATION_STAMPS: "off", DEPLOY_MAIN_HEAD_SHA: before.head };
    delete exportEnv.GIT_DIR;
    delete exportEnv.GIT_WORK_TREE;
    delete exportEnv.GIT_INDEX_FILE;

    runIn(exportDir, "npm", ["run", "build"], exportEnv);
    runIn(exportDir, "npm", ["run", "site:stage"], exportEnv);

    const exportTree = treeOfDirectory(exportDir, exportIndex);
    const changes = parseDiffTreeNameStatus(requireBuffer("git", ["diff-tree", "-r", "-z", "--name-status", stagedTree, exportTree]));
    const { generated, unexpected } = classifyGeneratedChanges(changes, generatedPaths);
    if (unexpected.length) {
      throw new Error(`A generator changed files outside the deployment allowlist; nothing was committed:\n${unexpected.map((change) => `- ${change.status} ${change.file}`).join("\n")}`);
    }

    runIn(exportDir, "npm", ["run", "site:check:full"], exportEnv);
    assertRepositoryUntouched(before, stagedTree);

    for (const change of generated) {
      if (change.status === "D") {
        run("git", ["update-index", "--force-remove", "--", change.file]);
        continue;
      }
      const entry = parseLsTreeLine(requireOutput("git", ["ls-tree", exportTree, "--", change.file]).trim());
      run("git", ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.object},${change.file}`]);
    }
    const committedTree = requireOutput("git", ["write-tree"]).trim();
    if (committedTree !== exportTree) {
      run("git", ["read-tree", stagedTree]);
      throw new Error(`The index tree ${committedTree} does not match the validated export tree ${exportTree}; the index was restored and nothing was committed.`);
    }

    run("git", ["commit", "-m", message]);
    const sha = requireOutput("git", ["rev-parse", "HEAD"]).trim();

    // The working-tree copies of regenerated files now lag HEAD. Refresh only
    // those that were not already carrying someone else's unstaged change.
    const foreignFiles = new Set(foreign.map((entry) => entry.file));
    const refresh = generated.map((change) => change.file).filter((file) => !foreignFiles.has(file));
    if (refresh.length) run("git", ["checkout", "HEAD", "--", ...refresh]);

    syncDesktopFromExport(exportDir);
    run("git", ["push", "--no-verify", "origin", "main"]);
    console.log(`Pushed ${sha} (isolated: built and validated the exact committed tree ${exportTree.slice(0, 12)} in a temporary export; ${foreign.length} unrelated working-tree entr${foreign.length === 1 ? "y was" : "ies were"} left untouched). Complete publication using the active deployment mode documented in VIEWER.md.`);
    return sha;
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
    fs.rmSync(exportIndex, { force: true });
  }
}

// The export steps must leave the real repository exactly as they found it. If anything in them
// reached it (a leaked GIT_* variable, a fixture that found the wrong .git), restore the ref,
// the config and the index, commit nothing, and say what changed.
function repositoryState() {
  const worktree = spawnSync("git", ["config", "--local", "core.worktree"], { cwd: root, encoding: "utf8" });
  return {
    head: requireOutput("git", ["rev-parse", "HEAD"]).trim(),
    worktree: worktree.status === 0 ? worktree.stdout.trim() : "",
    bare: requireOutput("git", ["rev-parse", "--is-bare-repository"]).trim()
  };
}

export function repositoryDrift(before, after) {
  const drift = [];
  if (before.head !== after.head) drift.push(`HEAD moved from ${before.head} to ${after.head}`);
  if (before.worktree !== after.worktree) drift.push(`core.worktree changed from "${before.worktree}" to "${after.worktree}"`);
  if (before.bare !== after.bare) drift.push(`bare repository flag changed to ${after.bare}`);
  return drift;
}

// checkIndex: only the staged-index modes commit the shared index, so only they care whether it
// changed. --paths never reads the shared index for the commit and never resets it: another
// session staging files during the run is legitimate and is simply left alone.
function assertRepositoryUntouched(before, stagedTree, { checkIndex = true } = {}) {
  const after = repositoryState();
  const drift = repositoryDrift(before, after);
  const indexTree = checkIndex ? requireOutput("git", ["write-tree"]).trim() : stagedTree;
  if (indexTree !== stagedTree) drift.push(`the shared index changed from ${stagedTree} to ${indexTree} (another session staged files); nothing was committed`);
  if (!drift.length) return;
  // Undo only what the export steps themselves could have done: a rewritten core.worktree. A moved
  // HEAD or a changed index is normally another session working in the meantime, which is
  // legitimate; refs and the shared index are never rewound here, the commit is simply not made.
  if (before.worktree !== after.worktree) {
    if (before.worktree) run("git", ["config", "--local", "core.worktree", before.worktree]);
    else spawnSync("git", ["config", "--local", "--unset", "core.worktree"], { cwd: root, stdio: "ignore" });
  }
  const concurrentOnly = before.worktree === after.worktree && before.bare === after.bare;
  const error = new Error(concurrentOnly
    ? `Another session changed the repository while the export was being validated; nothing was committed. Re-run deploy:main.\n${drift.map((item) => `- ${item}`).join("\n")}`
    : `The export steps reached the real repository; restored the config and committed nothing:\n${drift.map((item) => `- ${item}`).join("\n")}`);
  error.concurrent = concurrentOnly;
  throw error;
}

// Hash the export as a tree using a throwaway index against the real object
// store, honouring the repository's ignore rules.
function treeOfDirectory(directory, indexFile, seedIndex = path.join(root, ".git", "index")) {
  const env = { ...process.env, GIT_DIR: path.join(root, ".git"), GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: directory };
  // Seed the throwaway index from the index the export came from so that tracked files which
  // also match an ignore rule (for example evidence/gro/*/target-record.json) stay tracked; a
  // fresh index would treat them as ignored and report them deleted.
  fs.copyFileSync(seedIndex, indexFile);
  // The node_modules symlink is a build convenience, not content; exclude it explicitly because
  // the ignore rule "node_modules/" matches directories, not symlinks.
  const add = spawnSync("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], { cwd: directory, env, stdio: ["ignore", "ignore", "inherit"] });
  if (add.status !== 0) throw new Error("git add -A failed while hashing the export.");
  const tree = spawnSync("git", ["write-tree"], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (tree.status !== 0) throw new Error("git write-tree failed while hashing the export.");
  return tree.stdout.trim();
}

// The Desktop mirror is a convenience copy; mirror the validated export, not
// the shared working tree, and never fail the commit over it.
function syncDesktopFromExport(exportDir) {
  // The node_modules symlink is a build convenience; the mirror lists untracked files through
  // git, which does not treat a symlink as the ignored directory, so drop it first.
  fs.rmSync(path.join(exportDir, "node_modules"), { force: true });
  const env = { ...process.env, GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: exportDir };
  const result = spawnSync("node", [path.join(exportDir, "tools", "sync-desktop.mjs")], { cwd: exportDir, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.log("isolated: Desktop mirror sync did not complete; the next full deploy:main (or npm run sync:win on a clean tree) will catch it up.");
  }
}

// Planning documents only: no generator reads them, so nothing is rebuilt,
// validated or synced, and the pre-push handoff gate (which would validate the
// whole working tree, including other sessions' half-written work) is skipped
// deliberately. The commit is re-checked after the fact so that only
// allowlisted markdown can ever leave through this path.
function commitDocsOnly(message) {
  const staged = assertDocsOnlyStaged(status());
  console.log(`docs-only: committing ${staged.length} planning document(s); other sessions' unstaged work is left in place.`);
  run("git", ["diff", "--cached", "--check"]);
  run("git", ["commit", "-m", message]);
  const sha = requireOutput("git", ["rev-parse", "HEAD"]).trim();
  const committed = requireOutput("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]).split("\n").filter(Boolean);
  assertCommitIsDocsOnly(committed);
  run("git", ["push", "--no-verify", "origin", "main"]);
  console.log(`Pushed ${sha} (docs-only: build, site:stage, site:check, sync:win and the pre-push gate were skipped because every committed path is a planning document; the Desktop mirror receives these files at the next full deploy:main).`);
}

function assertReadyToCommit(generatedPaths) {
  const current = partitionStatus(status(), generatedPaths);
  if (!current.staged.length) throw new Error("No staged changes remain to commit.");
  if (current.unstaged.length) {
    throw new Error(`Validation left unstaged/untracked files; refusing to commit:\n${formatEntries(current.unstaged)}`);
  }
}

function status() {
  return parsePorcelainZ(requireBuffer("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

function run(command, args) {
  console.log(`\n> ${command} ${args.map(quoteForDisplay).join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

function runIn(cwd, command, args, env) {
  console.log(`\n> [${path.basename(cwd)}] ${command} ${args.map(quoteForDisplay).join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status} in the isolated export.`);
}

// spawnSync's default 1 MiB stdout cap is below the repository's file list
// (see tools/sync-desktop.mjs); listings and status output must never hit it.
const gitOutputMaxBuffer = 256 * 1024 * 1024;

function requireOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: gitOutputMaxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
  return result.stdout;
}

function requireBuffer(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], maxBuffer: gitOutputMaxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
  return result.stdout;
}

function reportDeployment(result) {
  const run = result.run ? ` Run ${result.run.id}: ${result.run.status}/${result.run.conclusion || "pending"}${result.run.url ? ` ${result.run.url}` : ""}` : "";
  console.log(`Deployment ${result.coverage}: ${result.detail}${run}`);
}

function formatEntries(entries) {
  return entries.map((entry) => `- ${entry.x}${entry.y} ${entry.file}`).join("\n");
}

function quoteForDisplay(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy:main: ${error.message}`);
    process.exitCode = 1;
  });
}
