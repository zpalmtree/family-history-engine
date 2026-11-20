#!/usr/bin/env node

import fs from "node:fs";
import { writeJsonAtomic } from "./atomic-json.mjs";

const queuePath = new URL("../evidence/subscription-records-queue.json", import.meta.url);
const targetId = valueAfter("--target");
const outcome = valueAfter("--outcome");
const note = valueAfter("--note");
const allowed = new Set(["acquired", "failed", "not-found", "duplicate", "inaccessible", "index-only"]);
if (!targetId || !allowed.has(outcome)) throw new Error("usage: --target <id> --outcome acquired|failed|not-found|duplicate|inaccessible|index-only [--note <safe summary>]");
if (note && (note.length > 500 || /password|token|secret|card number|contact details/i.test(note))) throw new Error("unsafe subscription attempt note");

const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
const target = queue.targets.find((item) => item.id === targetId);
if (!target) throw new Error(`unknown subscription target: ${targetId}`);
const attemptedAt = new Date().toISOString();
target.lastAttemptAt = attemptedAt;
target.attempts ||= [];
target.attempts.push({ attemptedAt, outcome, ...(note ? { note } : {}) });
target.attempts = target.attempts.slice(-20);
if (["not-found", "duplicate"].includes(outcome)) target.status = outcome;
if (outcome === "index-only") target.status = "index-only-no-image";
writeJsonAtomic(queuePath, queue);
console.log(`recorded subscription attempt for ${targetId}: ${outcome}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}
