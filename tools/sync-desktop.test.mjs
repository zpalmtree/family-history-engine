import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { fullVerifyIntervalMs, listProjectFiles, readManifest, syncDesktop } from "./sync-desktop.mjs";

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sync-desktop-"));
  const projectRoot = path.join(base, "project");
  const targetRoot = path.join(base, "desktop");
  const manifestPath = path.join(base, "manifest.json");
  fs.mkdirSync(path.join(projectRoot, "evidence"), { recursive: true });
  git(projectRoot, ["init", "--quiet"]);
  write(projectRoot, "index.html", "<p>tree</p>");
  write(projectRoot, "evidence/a.json", "{\"a\":1}");
  write(projectRoot, "evidence/b.json", "{\"b\":2}");
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init"]);
  return { base, projectRoot, targetRoot, manifestPath };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function write(root, relativePath, content) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("first sync hash-verifies the copy and records a manifest", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  write(targetRoot, "evidence/a.json", "{\"a\":1}");
  const result = await syncDesktop({ projectRoot, targetRoot, manifestPath });
  assert.equal(result.verifiedAll, true);
  assert.equal(result.copied, 2, "only the two files that differ are copied");
  assert.equal(result.unchanged, 1);
  assert.equal(read(targetRoot, "index.html"), "<p>tree</p>");
  const manifest = readManifest(manifestPath, path.resolve(targetRoot));
  assert.deepEqual(Object.keys(manifest.files).sort(), ["evidence/a.json", "evidence/b.json", "index.html"]);
});

test("routine sync copies only changed or new files", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  const now = Date.parse("2026-10-07T12:00:00Z");
  await syncDesktop({ projectRoot, targetRoot, manifestPath, now });
  write(projectRoot, "evidence/a.json", "{\"a\":10}");
  write(projectRoot, "evidence/new.json", "{}");
  const result = await syncDesktop({ projectRoot, targetRoot, manifestPath, now: now + 60_000 });
  assert.equal(result.verifiedAll, false);
  assert.equal(result.copied, 2);
  assert.equal(result.unchanged, 2);
  assert.equal(read(targetRoot, "evidence/a.json"), "{\"a\":10}");
  assert.equal(read(targetRoot, "evidence/new.json"), "{}");
});

test("routine sync repairs a Desktop file that went missing or changed size", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  const now = Date.parse("2026-10-07T12:00:00Z");
  await syncDesktop({ projectRoot, targetRoot, manifestPath, now });
  fs.rmSync(path.join(targetRoot, "evidence/b.json"));
  write(targetRoot, "index.html", "<p>edited on the desktop</p>");
  const result = await syncDesktop({ projectRoot, targetRoot, manifestPath, now: now + 60_000 });
  assert.equal(result.copied, 2);
  assert.equal(read(targetRoot, "evidence/b.json"), "{\"b\":2}");
  assert.equal(read(targetRoot, "index.html"), "<p>tree</p>");
});

test("files that leave the project are removed from the copy", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  const now = Date.parse("2026-10-07T12:00:00Z");
  await syncDesktop({ projectRoot, targetRoot, manifestPath, now });
  git(projectRoot, ["rm", "--quiet", "evidence/b.json"]);
  git(projectRoot, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "drop b"]);
  fs.rmSync(path.join(projectRoot, "evidence/a.json"));
  write(targetRoot, "user-notes.txt", "never mirrored, never removed");
  const result = await syncDesktop({ projectRoot, targetRoot, manifestPath, now: now + 60_000 });
  assert.equal(result.removed, 2);
  assert.equal(fs.existsSync(path.join(targetRoot, "evidence/b.json")), false, "committed deletion is mirrored");
  assert.equal(fs.existsSync(path.join(targetRoot, "evidence/a.json")), false, "working-tree deletion is mirrored");
  assert.equal(read(targetRoot, "user-notes.txt"), "never mirrored, never removed");
});

test("a stale manifest or a new target falls back to full hash verification", async () => {
  const { base, projectRoot, targetRoot, manifestPath } = fixture();
  const now = Date.parse("2026-10-07T12:00:00Z");
  await syncDesktop({ projectRoot, targetRoot, manifestPath, now });
  // Same size, different bytes: invisible to the size check, caught by the daily re-verify.
  write(targetRoot, "evidence/a.json", "{\"a\":9}");
  const routine = await syncDesktop({ projectRoot, targetRoot, manifestPath, now: now + 60_000 });
  assert.equal(routine.copied, 0);
  const daily = await syncDesktop({ projectRoot, targetRoot, manifestPath, now: now + fullVerifyIntervalMs + 1 });
  assert.equal(daily.verifiedAll, true);
  assert.equal(daily.copied, 1);
  assert.equal(read(targetRoot, "evidence/a.json"), "{\"a\":1}");

  const otherTarget = path.join(base, "other-desktop");
  const moved = await syncDesktop({ projectRoot, targetRoot: otherTarget, manifestPath, now: now + fullVerifyIntervalMs + 2 });
  assert.equal(moved.verifiedAll, true);
  assert.equal(moved.copied, 3);
});

test("check mode is read-only and reports every mismatch", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  await syncDesktop({ projectRoot, targetRoot, manifestPath });
  const before = fs.readFileSync(manifestPath, "utf8");
  write(targetRoot, "evidence/a.json", "{\"a\":9}");
  await assert.rejects(
    syncDesktop({ projectRoot, targetRoot, manifestPath, mode: "check" }),
    /differs from the worktree for 1 tracked file\(s\):\n- evidence\/a.json/
  );
  assert.equal(read(targetRoot, "evidence/a.json"), "{\"a\":9}");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
});

test("full mode recopies everything", async () => {
  const { projectRoot, targetRoot, manifestPath } = fixture();
  await syncDesktop({ projectRoot, targetRoot, manifestPath });
  const result = await syncDesktop({ projectRoot, targetRoot, manifestPath, mode: "full" });
  assert.equal(result.copied, 3);
  assert.equal(result.verifiedAll, true);
});

test("the target may not be the project itself", async () => {
  const { projectRoot, manifestPath } = fixture();
  await assert.rejects(syncDesktop({ projectRoot, targetRoot: projectRoot, manifestPath }), /must be different/);
});

test("the project file list is read whole even when it exceeds spawnSync's 1 MiB default", () => {
  const { projectRoot } = fixture();
  // About 1.3 MB of NUL-separated paths, like the real project on 8 Nov 2026.
  const directory = path.join(projectRoot, "evidence", "many");
  fs.mkdirSync(directory, { recursive: true });
  const stem = "x".repeat(110);
  for (let index = 0; index < 10_000; index += 1) {
    fs.writeFileSync(path.join(directory, `${stem}-${String(index).padStart(5, "0")}.json`), "");
  }
  const { projectFiles } = listProjectFiles(projectRoot);
  assert.equal(projectFiles.length, 10_003);
  assert.ok(projectFiles.join("\0").length > 1024 * 1024);
});
