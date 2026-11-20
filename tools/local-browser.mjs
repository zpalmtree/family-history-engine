#!/usr/bin/env node
// A Chrome on this machine for the research tools (macOS and Linux).
//
//   npm run browser:start [-- --headless]    start Chrome with this tree's own profile
//   npm run browser:status                    is it running?
//   npm run browser:stop                      stop it
//
// The tools connect to it over the Chrome DevTools Protocol at
// http://127.0.0.1:9226 through the "local" browser backend
// (tools/shared-browser-bridge-client.mjs). The profile keeps your provider
// sign-ins and Chrome's saved passwords and cards between runs; it lives
// outside the repository (paths.browserProfile in tree.config.json, or a
// per-tree folder under your user data directory). Chrome starts muted.
//
// On Windows and under WSL the shared Windows Chrome bridge is the route;
// this launcher refuses there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sharedChromeEndpoint } from "./shared-browser-bridge-client.mjs";
import { loadTreeConfig } from "./tree-config.mjs";

export const CDP_PORT = Number(new URL(sharedChromeEndpoint).port);

export function isWsl() {
  try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; }
}

export function stateDirectory(config = loadTreeConfig(), env = process.env) {
  const base = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "family-history", config.tree.id);
}

export function profileDirectory(config = loadTreeConfig()) {
  return config.paths?.browserProfile || path.join(stateDirectory(config), "chrome-profile");
}

export function findChrome(env = process.env, platform = process.platform, exists = fs.existsSync, which = whichCommand) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((file) => exists(file)) || null;
  }
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

function whichCommand(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function chromeArguments({ profile, headless = false }) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    ...(headless ? ["--headless=new"] : []),
    "about:blank"
  ];
}

export async function browserVersion() {
  try {
    const response = await fetch(`${sharedChromeEndpoint}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function start({ headless }) {
  if (process.platform === "win32" || isWsl()) {
    throw new Error("On Windows and WSL the research tools use the shared Windows Chrome bridge; this launcher is for macOS and Linux.");
  }
  if (await browserVersion()) {
    console.log(`Chrome is already running at ${sharedChromeEndpoint}.`);
    return;
  }
  const chrome = findChrome();
  if (!chrome) throw new Error("No Chrome or Chromium found; install one or set CHROME_PATH.");
  const config = loadTreeConfig();
  const profile = profileDirectory(config);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const child = spawn(chrome, chromeArguments({ profile, headless }), { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(stateDirectory(config), "chrome.pid"), String(child.pid));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const version = await browserVersion();
    if (version) {
      console.log(`Started ${version.Browser} at ${sharedChromeEndpoint} with profile ${profile}${headless ? " (headless)" : ""}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome did not open its DevTools port ${CDP_PORT} within 30 seconds.`);
}

async function status() {
  const version = await browserVersion();
  console.log(version ? `running: ${version.Browser} at ${sharedChromeEndpoint}` : `not running (start it with npm run browser:start)`);
  if (!version) process.exitCode = 1;
}

function stop() {
  const pidFile = path.join(stateDirectory(), "chrome.pid");
  if (!fs.existsSync(pidFile)) {
    console.log("No Chrome started by browser:start is recorded.");
    return;
  }
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  try { process.kill(pid); console.log(`Stopped Chrome (pid ${pid}).`); } catch { console.log("That Chrome had already stopped."); }
  fs.rmSync(pidFile, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command = "status", ...rest] = process.argv.slice(2);
  const actions = { start: () => start({ headless: rest.includes("--headless") }), status, stop };
  if (!actions[command]) {
    console.error("usage: node tools/local-browser.mjs start [--headless] | status | stop");
    process.exit(1);
  }
  Promise.resolve(actions[command]()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
