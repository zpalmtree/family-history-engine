#!/usr/bin/env node
// Smoke test for the local browser backend: open one task tab in the local
// Chrome, load a page, read it back and close the tab. Run it with
//   npm run local -- tools/local-browser-smoke.mjs
// after npm run browser:start (CI uses --headless).

import { chromium } from "playwright-core";
import { openSharedChromeTask } from "./shared-chrome-task.mjs";

if (!process.argv.includes("--shared-window")) throw new Error("Run through npm run local.");
const task = await openSharedChromeTask({ chromium, taskLabel: "local-browser-smoke", affinitySlot: "smoke" });
try {
  await task.page.goto("data:text/html,<title>family-history-engine</title><p id=ok>ready</p>");
  const title = await task.page.title();
  const text = await task.page.textContent("#ok");
  if (title !== "family-history-engine" || text !== "ready") throw new Error(`Unexpected page: ${title} / ${text}`);
  console.log(`local browser ok: task tab ${task.targetId} in window ${task.windowId} loaded and read a page`);
} finally {
  await task.close();
}
