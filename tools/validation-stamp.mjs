#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Content-keyed memo for read-only validation suites.
//
// `deploy:main` used to run the full `site:check` suite three times on the
// same bytes: before committing, again through `handoff:check` after the
// commit, and once more from the pre-push hook. Each pass took about a minute.
// A validation that already passed on byte-identical content cannot fail
// differently on a rerun, because no validator reads the commit SHA or the
// clock. This wrapper keys a stamp by the tree hash of the working copy
// (tracked plus untracked, non-ignored files) and the Node version, and skips
// a rerun when the stamp matches.
//
// The stamp is written only when the content key is identical before and
// after a successful run, so a check that rewrote files, or a concurrent edit
// made during the run, never produces a stamp. Stamps live under .git and are
// never shared; CI starts from a clean clone, so it always runs the full
// suite. Set VALIDATION_STAMPS=off to force every run.

export const stampVersion = 1;

export function contentKey(projectRoot) {
  const indexPath = gitPath(projectRoot, "index");
  const temporaryIndex = path.join(os.tmpdir(), `validation-stamp-index-${process.pid}-${crypto.randomUUID()}`);
  try {
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, temporaryIndex);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    git(projectRoot, ["add", "-A"], env);
    const tree = git(projectRoot, ["write-tree"], env).trim();
    const key = crypto.createHash("sha256").update(`${stampVersion}\0${tree}\0${process.version}`).digest("hex");
    return { key, tree };
  } finally {
    fs.rmSync(temporaryIndex, { force: true });
  }
}

export function stampPath(projectRoot, name) {
  if (!/^[a-z0-9][a-z0-9:._-]*$/i.test(name)) throw new Error(`Invalid validation stamp name: ${name}`);
  return path.join(gitPath(projectRoot, "validation-stamps"), `${name.replace(/:/g, "-")}.json`);
}

export function readStamp(projectRoot, name) {
  try {
    return JSON.parse(fs.readFileSync(stampPath(projectRoot, name), "utf8"));
  } catch {
    return null;
  }
}

export function stampsDisabled(env = process.env) {
  return Boolean(env.CI) || /^(off|0|false|no)$/i.test(env.VALIDATION_STAMPS || "");
}

export function runWithStamp(projectRoot, name, command, args, {
  env = process.env,
  spawn = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { cwd: projectRoot, stdio: "inherit", env }),
  log = (message) => console.error(message),
  now = () => new Date()
} = {}) {
  if (stampsDisabled(env)) return exitStatus(spawn(command, args));

  const before = contentKey(projectRoot);
  const stamp = readStamp(projectRoot, name);
  if (stamp?.key === before.key) {
    log(`${name}: already passed for this exact content (tree ${before.tree.slice(0, 12)}, ${stamp.passedAt}); skipped. Set VALIDATION_STAMPS=off to force a rerun.`);
    return 0;
  }

  const status = exitStatus(spawn(command, args));
  if (status !== 0) return status;
  const after = contentKey(projectRoot);
  if (after.key !== before.key) {
    log(`${name}: passed, but the content changed while it ran; no stamp recorded.`);
    return 0;
  }
  const file = stampPath(projectRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: stampVersion, name, key: before.key, tree: before.tree, passedAt: now().toISOString() })}\n`);
  fs.renameSync(temporary, file);
  return 0;
}

function exitStatus(result) {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function gitPath(projectRoot, name) {
  return path.resolve(projectRoot, git(projectRoot, ["rev-parse", "--git-path", name]).trim());
}

function git(cwd, args, env = process.env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || "unknown error"}`);
  return result.stdout;
}

function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator !== 1 || args.length < 3) {
    throw new Error("Usage: node tools/validation-stamp.mjs <name> -- <command> [args...]");
  }
  process.exitCode = runWithStamp(projectRoot, args[0], args[2], args.slice(3));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
