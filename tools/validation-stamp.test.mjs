import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { contentKey, readStamp, runWithStamp, stampsDisabled } from "./validation-stamp.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-stamp-"));
  git(root, ["init", "--quiet"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(root, "a.json"), "{}\n");
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init"]);
  return root;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function recorder(status = 0, effect = () => {}) {
  const calls = [];
  return {
    calls,
    spawn: (command, args) => {
      calls.push([command, ...args]);
      effect();
      return { status };
    }
  };
}

const quiet = { env: {}, log: () => {} };

test("the content key covers staged, unstaged and untracked files but not ignored ones", () => {
  const root = repo();
  const clean = contentKey(root);
  assert.equal(clean.tree, git(root, ["rev-parse", "HEAD^{tree}"]).trim(), "a clean tree keys to HEAD's tree");
  fs.writeFileSync(path.join(root, "ignored.txt"), "x");
  assert.equal(contentKey(root).key, clean.key);
  fs.writeFileSync(path.join(root, "new.json"), "{}");
  const untracked = contentKey(root);
  assert.notEqual(untracked.key, clean.key);
  fs.writeFileSync(path.join(root, "a.json"), "{\"a\":1}\n");
  assert.notEqual(contentKey(root).key, untracked.key);
  assert.equal(git(root, ["status", "--porcelain"]).includes("?? new.json"), true, "the real index is untouched");
});

test("a passing check is skipped on identical content and rerun after any change", () => {
  const root = repo();
  const first = recorder();
  assert.equal(runWithStamp(root, "site:check", "npm", ["run", "site:check:full"], { ...quiet, spawn: first.spawn }), 0);
  assert.equal(first.calls.length, 1);
  assert.equal(readStamp(root, "site:check").tree, contentKey(root).tree);

  const second = recorder();
  assert.equal(runWithStamp(root, "site:check", "npm", ["run", "site:check:full"], { ...quiet, spawn: second.spawn }), 0);
  assert.equal(second.calls.length, 0, "identical content is not revalidated");

  fs.writeFileSync(path.join(root, "a.json"), "{\"changed\":true}\n");
  const third = recorder();
  runWithStamp(root, "site:check", "npm", ["run", "site:check:full"], { ...quiet, spawn: third.spawn });
  assert.equal(third.calls.length, 1);
});

test("committing validated content keeps the stamp valid", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "a.json"), "{\"staged\":true}\n");
  git(root, ["add", "a.json"]);
  runWithStamp(root, "site:check", "true", [], { ...quiet, spawn: recorder().spawn });
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "change"]);
  const after = recorder();
  runWithStamp(root, "site:check", "true", [], { ...quiet, spawn: after.spawn });
  assert.equal(after.calls.length, 0);
});

test("failures, self-modifying runs and disabled stamps never record a stamp", () => {
  const root = repo();
  assert.equal(runWithStamp(root, "tree:check", "false", [], { ...quiet, spawn: recorder(2).spawn }), 2);
  assert.equal(readStamp(root, "tree:check"), null);

  const mutating = recorder(0, () => fs.writeFileSync(path.join(root, "generated.json"), String(Math.random())));
  assert.equal(runWithStamp(root, "tree:check", "true", [], { ...quiet, spawn: mutating.spawn }), 0);
  assert.equal(readStamp(root, "tree:check"), null);

  const disabled = recorder();
  runWithStamp(root, "site:check", "true", [], { ...quiet, env: { VALIDATION_STAMPS: "off" }, spawn: disabled.spawn });
  runWithStamp(root, "site:check", "true", [], { ...quiet, env: { VALIDATION_STAMPS: "off" }, spawn: disabled.spawn });
  assert.equal(disabled.calls.length, 2);
  assert.equal(readStamp(root, "site:check"), null);
});

test("CI and explicit opt-outs disable stamps", () => {
  assert.equal(stampsDisabled({ CI: "true" }), true);
  assert.equal(stampsDisabled({ VALIDATION_STAMPS: "off" }), true);
  assert.equal(stampsDisabled({ VALIDATION_STAMPS: "0" }), true);
  assert.equal(stampsDisabled({}), false);
});
