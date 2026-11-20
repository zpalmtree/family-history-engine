// Planning briefs live in evidence/research/briefs/<person-id>.md (a couple's
// brief joins the two ids with "--"). They are hand-off documents for a research
// agent, not canonical state: the question, target and attempt files always win.
// This module only makes them discoverable from the status tools by matching the
// file name against a question's person ids.

import fs from "node:fs";
import path from "node:path";

import { projectRoot } from "./research-store.mjs";

export const briefsRelativeDirectory = path.posix.join("evidence", "research", "briefs");
export const briefsDirectory = path.join(projectRoot, "evidence", "research", "briefs");

const nonPersonFiles = new Set(["readme.md"]);

export function briefPersonIds(fileName) {
  if (!/\.md$/i.test(fileName) || nonPersonFiles.has(fileName.toLowerCase())) return [];
  return fileName.replace(/\.md$/i, "").split("--").map((part) => part.trim()).filter(Boolean);
}

export function listBriefFiles(directory = briefsDirectory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function findBriefsForPersonIds(personIds, { directory = briefsDirectory } = {}) {
  const wanted = new Set((personIds || []).filter(Boolean));
  if (!wanted.size) return [];
  return listBriefFiles(directory)
    .filter((fileName) => briefPersonIds(fileName).some((id) => wanted.has(id)))
    .map((fileName) => path.posix.join(briefsRelativeDirectory, fileName));
}

export function findBriefsForQuestion(question, options = {}) {
  if (!question) return [];
  return findBriefsForPersonIds([...(question.personIds || []), question.frontierPersonId], options);
}
