#!/usr/bin/env node

// Notable people (evidence/notable-people.json): the curated highlights the
// viewer marks on the map and lists under "Notable people".
//
//   npm run notable                    what is shown, by category, and anything withheld
//   npm run notable -- --candidates    people on the tree whose established facts hint at
//                                      distinction and who are neither listed nor declined
//   npm run notable:check              fail on a malformed curation file
//
// To add someone, give an entry with a category, a short reason (no full stop) and
// the established assertion ids it rests on; to dismiss a candidate, add it to
// "declined" with why. An entry whose basis is later weakened is withheld, not
// shown, and listed here until it is mended.

import path from "node:path";
import { loadResearchStore, projectRoot, readJson } from "./research-store.mjs";
import {
  notableCategories,
  projectNotablePeople,
  uncuratedCandidates,
  validateNotableFile
} from "./notable-people-core.mjs";

const args = process.argv.slice(2);
const store = loadResearchStore();
const file = store.notablePeople;
if (!file) {
  console.error("evidence/notable-people.json is missing");
  process.exit(1);
}
const issues = validateNotableFile(file);
if (issues.length) {
  console.error(issues.map((issue) => `- ${issue}`).join("\n"));
  process.exit(1);
}
const { byPerson, withheld } = projectNotablePeople(file, store);
const generated = readJson(path.join(projectRoot, "data", "family", "tree.json"));
const onTree = new Set((generated.visualTree?.nodes || []).map((node) => node.id));

if (args.includes("--check")) {
  console.log(`notable people are valid: ${byPerson.size} shown, ${withheld.length} withheld, ${file.declined.length} declined`);
} else if (args.includes("--candidates")) {
  const candidates = uncuratedCandidates(file, store, { onTree });
  for (const { personId, signs } of candidates) {
    console.log(personId);
    for (const sign of signs) console.log(`    [${sign.categories.join(",")}] ${sign.assertionId}: ${sign.text.slice(0, 140)}`);
  }
  console.log(`${candidates.length} uncurated candidate(s) on the tree`);
} else {
  for (const category of notableCategories) {
    const entries = [...byPerson].filter(([, item]) => item.category === category.id)
      .sort((a, b) => (a[1].rank || 5) - (b[1].rank || 5));
    if (!entries.length) continue;
    console.log(`\n${category.label} (${entries.length})`);
    for (const [personId, item] of entries) {
      console.log(`  ${item.rank || 5} ${personId}${onTree.has(personId) ? "" : " (not on the tree)"}: ${item.reason}${item.today ? ` (${item.today})` : ""}`);
    }
  }
  for (const { entry, why } of withheld) console.log(`WITHHELD ${entry.personId}: ${why}`);
  console.log(`\n${byPerson.size} shown, ${withheld.length} withheld, ${file.declined.length} declined`);
}
