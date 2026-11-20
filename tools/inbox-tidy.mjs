#!/usr/bin/env node
// Archives processed research mail from the shared Gmail inbox and the
// personal mailbox's INBOX (user request, 18 Nov 2026). The rules are in
// inbox-tidy-lib.mjs: only mail matched to a main-scope canonical request (or
// a receipt for a recorded payment) that is fully on record and not waiting on
// the user is moved, and only to Gmail's archive or the personal INBOX.Archive.
// Non-research mail is never touched, and no message body is read.
//
// usage: node tools/inbox-tidy.mjs [--dry-run] [--skip-gmail] [--skip-personal]
// Runs at the end of `npm run requests:inbox:sweep` unless --no-tidy is passed there.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planInboxTidy, senderAddress } from "./inbox-tidy-lib.mjs";
import { parseHeaderBlock } from "./personal-mailbox.mjs";
import { hasConsent } from "./consents.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const stateDir = path.join(projectRoot, ".inbox-sweep");

function loadRequests() {
  const dir = path.join(projectRoot, "evidence", "acquisition", "requests");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

function runPowerShell(script, args, { hidden = false } = {}) {
  const file = execFileSync("wslpath", ["-w", path.join(projectRoot, "tools", script)], { encoding: "utf8" }).trim();
  const output = execFileSync("powershell.exe", [...(hidden ? ["-WindowStyle", "Hidden"] : []), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"],
  });
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).at(-1);
  if (!line) throw new Error(`${script} returned no result`);
  return JSON.parse(line);
}

function report(label, plan, moved) {
  console.log(`inbox tidy (${label}): ${dryRun ? "would archive" : "archived"} ${moved} processed research message(s); ${plan.keep.length} research message(s) kept`);
  for (const item of plan.archive) console.log(`  ${dryRun ? "WOULD ARCHIVE" : "ARCHIVED"} ${item.requestId || item.rule}: ${String(item.subject).slice(0, 90)}`);
  for (const item of plan.keep) console.log(`  KEPT ${item.requestId || item.rule}: ${String(item.subject).slice(0, 70)} (${item.reason})`);
}

if (!hasConsent("inbox-tidy")) {
  console.log("inbox tidy: switched off for this tree (consents.json); nothing moved");
  process.exit(0);
}
const requests = loadRequests();
let failed = false;

if (!process.argv.includes("--skip-gmail")) {
  try {
    const listed = runPowerShell("gmail-inbox-tidy-windows.ps1", ["-Mode", "list"], { hidden: true });
    const messages = (listed.rows || []).filter((row) => row.threadId)
      .map((row) => ({ id: row.threadId, subject: row.subject, senderEmail: row.senderEmail, dateMs: row.dateMs }));
    const plan = planInboxTidy({ messages, requests });
    let moved = 0;
    if (!dryRun && plan.archive.length) {
      fs.mkdirSync(stateDir, { recursive: true });
      const expectFile = path.join(stateDir, "gmail-tidy-expect.json");
      fs.writeFileSync(expectFile, JSON.stringify(Object.fromEntries(plan.archive.map((item) => [item.id, item.subject]))));
      const winExpect = execFileSync("wslpath", ["-w", expectFile], { encoding: "utf8" }).trim();
      const acted = runPowerShell("gmail-inbox-tidy-windows.ps1", ["-Mode", "act", "-Archive", plan.archive.map((item) => item.id).join(","), "-Expect", winExpect], { hidden: true });
      moved = (acted.done || []).length;
      for (const skip of acted.skipped || []) console.log(`  SKIPPED gmail ${skip.threadId}: ${skip.reason}`);
      for (const item of (acted.done || []).filter((entry) => entry.markedRead === false)) {
        console.log(`  NOT MARKED READ gmail ${item.threadId}: archived, but Gmail's Mark as read control did not take`);
      }
    }
    report("shared Gmail", plan, dryRun ? plan.archive.length : moved);
  } catch (error) {
    failed = true;
    console.log(`inbox tidy (shared Gmail) stopped: ${String(error.message).split("\n")[0]}`);
  }
}

if (!process.argv.includes("--skip-personal")) {
  try {
    const listed = runPowerShell("personal-mailbox-tidy-windows.ps1", ["-Mode", "list", "-SinceDays", "180"]);
    const messages = (listed.messages || []).map((message) => {
      const header = parseHeaderBlock(message.header);
      return {
        id: message.uid,
        messageId: String(header["message-id"] || "").replace(/[<>\s]/g, ""),
        subject: header.subject || "",
        senderEmail: senderAddress(header.from),
        dateMs: Date.parse(header.date || "") || null,
      };
    });
    const plan = planInboxTidy({ messages, requests });
    const movable = plan.archive.filter((item) => /^[A-Za-z0-9@._+=$%-]+$/.test(item.messageId || ""));
    let moved = 0;
    if (!dryRun && movable.length) {
      const result = runPowerShell("personal-mailbox-tidy-windows.ps1", ["-Mode", "move", "-To", "INBOX.Archive", "-Items", movable.map((item) => `${item.id}=${item.messageId}`).join(",")]);
      moved = (result.moved || []).length;
      for (const skip of result.skipped || []) console.log(`  SKIPPED personal ${skip.uid}: ${skip.reason}`);
    }
    report("personal mailbox", plan, dryRun ? movable.length : moved);
  } catch (error) {
    failed = true;
    console.log(`inbox tidy (personal mailbox) stopped: ${String(error.message).split("\n")[0]}`);
  }
}

if (failed) process.exitCode = 1;
