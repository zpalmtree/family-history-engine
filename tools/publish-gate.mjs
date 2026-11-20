#!/usr/bin/env node
// Validation gate inside the records:publish:* chains.
//
// An unscoped publish runs the full `npm run data:check`, as before. A scoped publish
// (PUBLISH_TARGET_IDS set) validates only the records it will upload: their canonical target,
// source and manifest row must exist, agree on the archived master and carry verified people.
// The whole tree is validated where it belongs, in deploy:main's isolated export of the commit,
// so another session's half-written canonical files no longer stop this session's upload.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestedPublishIds } from "./publish-selection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function scopedIssues(ids, { readJson, exists, sourceDirs = [] }) {
  const issues = [];
  const manifest = readJson("evidence/records-manifest.json");
  const rows = new Map((manifest.records || []).map((row) => [row.id, row]));
  for (const id of ids) {
    const targetPath = `evidence/acquisition/targets/${id}.json`;
    if (!exists(targetPath)) { issues.push(`${id}: no canonical target`); continue; }
    const target = readJson(targetPath);
    const row = rows.get(id);
    if (!row) issues.push(`${id}: no records-manifest row`);
    // FamilySearch canonical targets carry no hash: registration writes it to the
    // recovery queue and the manifest row, so the row's hash stands for them.
    if (!target.sha256 && !row?.sha256) issues.push(`${id}: target has no archived sha256`);
    if (row && target.sha256 && row.sha256 !== target.sha256) issues.push(`${id}: manifest sha256 disagrees with the target`);
    if (!target.peopleVerifiedAt) issues.push(`${id}: people not verified on the target`);
    const sourceId = target.sourceId || id;
    const found = sourceDirs.some((dir) => exists(`evidence/sources/${dir}/${sourceId}.json`)) || exists(`evidence/sources/${sourceId}.json`);
    if (!found) issues.push(`${id}: no canonical source ${sourceId}`);
  }
  return issues;
}

function main() {
  const ids = [...requestedPublishIds()];
  if (!ids.length) {
    const result = spawnSync("npm", ["run", "data:check"], { cwd: root, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  const issues = scopedIssues(ids, {
    readJson: (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")),
    exists: (file) => fs.existsSync(path.join(root, file)),
    sourceDirs: fs.readdirSync(path.join(root, "evidence", "sources"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  });
  if (issues.length) {
    console.error(`scoped publish gate failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`scoped publish gate ok for ${ids.length} record(s); whole-tree validation runs in deploy:main's isolated export.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
