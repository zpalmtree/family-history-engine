import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const atomicJsonUrl = new URL("./atomic-json.mjs", import.meta.url).href;

test("file lock serializes independent JSON writers without losing updates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "family-history-json-lock-"));
  const file = path.join(directory, "queue.json");
  fs.writeFileSync(file, '{"count":0}\n');
  const worker = `
    import fs from "node:fs";
    import { withFileLockSync, writeJsonAtomic } from ${JSON.stringify(atomicJsonUrl)};
    const file = process.env.ATOMIC_JSON_LOCK_TEST_FILE;
    withFileLockSync(file, () => {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      value.count += 1;
      writeJsonAtomic(file, value);
    });
  `;

  try {
    await Promise.all(Array.from({ length: 4 }, () => runWorker(worker, file)));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { count: 4 });
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runWorker(worker, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", worker], {
      env: { ...process.env, ATOMIC_JSON_LOCK_TEST_FILE: file },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock-test worker exited ${code}: ${stderr.trim()}`));
    });
  });
}
