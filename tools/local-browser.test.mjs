import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeArguments, findChrome } from "./local-browser.mjs";
import { acquireBrowserLock, resolveTool } from "./local-run.mjs";

test("Chrome is found by CHROME_PATH, then the platform's usual places", () => {
  assert.equal(findChrome({ CHROME_PATH: "/opt/chrome" }), "/opt/chrome");
  assert.equal(findChrome({}, "darwin", (file) => file.includes("Chromium.app")), "/Applications/Chromium.app/Contents/MacOS/Chromium");
  assert.equal(findChrome({}, "linux", () => false, (name) => name === "chromium" ? "/usr/bin/chromium" : null), "/usr/bin/chromium");
  assert.equal(findChrome({}, "linux", () => false, () => null), null);
});

test("Chrome starts with this tree's profile, localhost debugging and no sound", () => {
  const args = chromeArguments({ profile: "/data/profile", headless: true });
  assert.ok(args.includes("--user-data-dir=/data/profile"));
  assert.ok(args.includes("--remote-debugging-port=9226"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--mute-audio"));
  assert.ok(args.includes("--headless=new"));
  assert.ok(!chromeArguments({ profile: "/p" }).includes("--headless=new"));
});

test("one task holds the browser at a time; a dead owner's lock is taken over", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "browser-lock-")), "browser.lock");
  const release = await acquireBrowserLock({ file });
  await assert.rejects(acquireBrowserLock({ file, waitMs: 0 }), /still holds the browser/);
  release();
  fs.writeFileSync(file, "999999999");
  const again = await acquireBrowserLock({ file, waitMs: 0 });
  again();
});

test("only tools under tools/ can be run", () => {
  assert.match(resolveTool("local-browser-smoke"), /tools\/local-browser-smoke\.mjs$/);
  assert.throws(() => resolveTool("../package.json"), /No research tool/);
});
