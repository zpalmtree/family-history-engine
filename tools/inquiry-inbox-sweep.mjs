#!/usr/bin/env node
// Inbox sweep: reads the bound Gmail thread of every open email or form request
// (read-only, in the shared Windows Chrome window), records each provider
// message that no event cites yet as an informational provider-reply-received
// event, and leaves classification to the research loop, which receives each
// untriaged reply as a `reply-triage` acquisition item. Message bodies never
// enter canonical files: only the Gmail id, sender name and attachment names.
//
// usage: node tools/inquiry-inbox-sweep.mjs [--scope main] [--request <id>]... [--dry-run] [--no-tidy]
// After recording new replies it runs tools/inbox-tidy.mjs, which archives
// research mail that is fully on record (not with --request, --dry-run or --no-tidy).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appendExternalRequestEvent, deriveExternalRequest } from "./external-request-store.mjs";
import { newReplies, replyReceivedEvent, sweepEligible } from "./inquiry-inbox-sweep-lib.mjs";
import { projectRoot, readJson, serializeJson } from "./research-store.mjs";
import { hasConsent } from "./consents.mjs";

if (!hasConsent("mailbox-read")) {
  console.log("inbox sweep: mailbox reading is off for this tree (consents.json); nothing read");
  process.exit(0);
}
const scope = valueAfter("--scope") || "main";
const dryRun = process.argv.includes("--dry-run");
const onlyRequests = valuesAfter("--request");
const requestsDir = path.join(projectRoot, "evidence", "acquisition", "requests");
export const sweepStatePath = path.join(projectRoot, ".inbox-sweep", "state.json");

const requests = fs.readdirSync(requestsDir).filter((name) => name.endsWith(".json"))
  .map((name) => ({ file: path.join(requestsDir, name), request: readJson(path.join(requestsDir, name)) }))
  .filter(({ request }) => onlyRequests.length ? onlyRequests.includes(request.id) : sweepEligible(request, { scope }));

if (!requests.length) {
  console.log("inbox sweep: no open email or form request to read");
  writeState({ requestCount: 0, newReplyCount: 0, failures: [] });
  process.exit(0);
}

const wrapper = execFileSync("wslpath", ["-w", path.join(projectRoot, "tools", "inquiry-inbox-sweep-windows.ps1")], { encoding: "utf8" }).trim();
let raw = "";
try {
  raw = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    "-Requests", requests.map(({ request }) => request.id).join(","), "-SkipInstall"
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  // Keep the results the reader emitted before it stopped; report the stop
  // briefly instead of echoing every captured thread.
  raw = String(error.stdout || "");
  console.log(`inbox sweep: the Windows reader stopped early (${firstErrorLine(error.stderr)})`);
}

const results = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
const failures = [];
const detected = [];
let wrote = false;
let signInRequired = false;
const now = new Date().toISOString();

for (const { file, request } of requests) {
  const result = results.find((candidate) => candidate.requestId === request.id);
  if (!result) {
    failures.push({ requestId: request.id, reason: "no result from the Windows reader" });
    continue;
  }
  const inspection = parseInspection(result.output);
  if (inspection?.state === "manual-signin-required") {
    signInRequired = true;
    failures.push({ requestId: request.id, reason: "Gmail sign-in required" });
    continue;
  }
  if (result.exitCode !== 0 || inspection?.state !== "response-inspected") {
    // An absent thread only means the provider has not written yet.
    const absent = /bound response thread is absent/i.test(result.output || "");
    if (!absent) failures.push({ requestId: request.id, reason: firstErrorLine(result.output) });
    continue;
  }
  const replies = newReplies(request, inspection);
  if (!replies.length) continue;
  let updated = request;
  for (const reply of replies) {
    updated = appendExternalRequestEvent(updated, replyReceivedEvent(reply, now));
    detected.push({ requestId: request.id, messageId: reply.messageId, senderName: reply.senderName, attachmentLabels: reply.attachmentLabels || [] });
  }
  if (!dryRun) {
    atomicWrite(file, serializeJson(updated));
    wrote = true;
  }
}

if (wrote) execFileSync(process.execPath, ["tools/sync-external-request-projections.mjs"], { cwd: projectRoot, stdio: "inherit" });

for (const item of detected) {
  const attachments = item.attachmentLabels.length ? ` [${item.attachmentLabels.join("; ")}]` : "";
  console.log(`NEW REPLY ${item.requestId} gmail-message-${item.messageId} from ${item.senderName || "provider"}${attachments}`);
}
for (const failure of failures) console.log(`SWEEP FAILED ${failure.requestId}: ${failure.reason}`);
if (signInRequired) console.log("NEEDS USER sign-in-gmail — sign the shared Chrome profile into Gmail, then rerun the sweep.");
console.log(`inbox sweep: ${requests.length} request thread(s) read; ${detected.length} new provider message(s)${dryRun ? " (dry run, nothing written)" : ""}; ${failures.length} failure(s)`);
if (!dryRun) writeState({ requestCount: requests.length, newReplyCount: detected.length, failures });
if (signInRequired) process.exitCode = 2;
// Then archive the research mail that is fully on record (user request, 18 Nov
// 2026), now that every new reply above is flagged untriaged and so kept.
if (!dryRun && !signInRequired && !process.argv.includes("--no-tidy") && !onlyRequests.length) {
  try {
    execFileSync(process.execPath, ["tools/inbox-tidy.mjs"], { cwd: projectRoot, stdio: "inherit", timeout: 40 * 60 * 1000 });
  } catch {
    console.log("inbox sweep: the inbox tidy stopped early; replies were still recorded (rerun npm run inbox:tidy)");
  }
}

function parseInspection(output) {
  const text = String(output || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function firstErrorLine(output) {
  const line = String(output || "").split(/\r?\n/).find((candidate) => /Error:|throw|failed/i.test(candidate));
  return (line || "unknown error").trim().slice(0, 200);
}

function writeState(summary) {
  fs.mkdirSync(path.dirname(sweepStatePath), { recursive: true });
  atomicWrite(sweepStatePath, `${JSON.stringify({ lastSweptAt: new Date().toISOString(), scope, ...summary }, null, 2)}\n`);
}

function atomicWrite(fileName, contents) {
  const temporary = `${fileName}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "wx" });
  fs.renameSync(temporary, fileName);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

function valuesAfter(flag) {
  return process.argv.flatMap((value, index) => process.argv[index - 1] === flag ? [value] : []);
}
