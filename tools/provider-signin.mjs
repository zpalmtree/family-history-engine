#!/usr/bin/env node

// Windows-side runner for the guarded saved-credential sign-in. Invoke only
// through tools/provider-signin-windows.ps1, which holds the shared-window
// mutex. Each provider uses its own bridge-leased background task tab: a tab
// whose sign-in completes is closed; a tab that needs a human step (MFA,
// CAPTCHA, account choice, no saved password) is revealed and left open on
// exactly that step. One JSON line per provider is written to stdout.

import { chromium } from "playwright-core";

import { probeSavedSignIn, savedSignInProviderIds, trySavedSignIn } from "./saved-signin.mjs";
import { openSharedChromeTask } from "./shared-chrome-task.mjs";

const args = process.argv.slice(2);
const probe = args.includes("--probe");
const requested = (valueAfter("--providers") || savedSignInProviderIds.join(","))
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
for (const providerId of requested) {
  if (!savedSignInProviderIds.includes(providerId)) {
    console.error(`Unsupported provider for saved sign-in: ${providerId}. Supported: ${savedSignInProviderIds.join(", ")}.`);
    process.exit(2);
  }
}
if (process.platform !== "win32") {
  console.error("Saved sign-in must run in Windows Chrome. Use npm run providers:signin.");
  process.exit(1);
}

let failed = false;
for (const providerId of requested) {
  let task;
  let keepOpen = false;
  try {
    task = await openSharedChromeTask({ chromium, taskLabel: `signin-${providerId}`, affinitySlot: `signin-${providerId}` });
    const log = (message) => console.error(message);
    const outcome = probe
      ? await probeSavedSignIn(task.page, providerId, { log })
      : await trySavedSignIn(task.page, providerId, { log });
    if (!probe && outcome.status === "needs-user") {
      keepOpen = true;
      await task.showForManualStep(`${providerId} sign-in (${outcome.reason})`).catch(() => {});
    }
    console.log(JSON.stringify({ type: "signin-result", ...outcome }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ type: "signin-result", provider: providerId, status: "error", reason: String(error?.message || error).slice(0, 300) }));
  } finally {
    if (task) {
      if (keepOpen) await task.leaveOpen().catch(() => {});
      else await task.close().catch(() => {});
    }
  }
}
process.exitCode = failed ? 1 : 0;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
