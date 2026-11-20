import fs from "node:fs";
import vm from "node:vm";

export const dataPath = new URL("../data/family-data.js", import.meta.url);

export function loadFamilyData() {
  const source = fs.readFileSync(dataPath, "utf8");
  const sandbox = { globalThis: {} };
  vm.runInNewContext(source, sandbox, { filename: dataPath.pathname });
  const familyData = sandbox.globalThis.familyData;
  if (!familyData || typeof familyData !== "object" || Array.isArray(familyData)) {
    throw new Error("data/family-data.js did not assign a familyData object");
  }
  return familyData;
}

export function serializeFamilyData(familyData) {
  return "/* Generated browser bundle. Edit data/family/*.json, then run npm run build. */\n"
    + `globalThis.familyData = ${JSON.stringify(familyData, null, 2)};\n`;
}

export function writeFamilyData(familyData) {
  fs.writeFileSync(dataPath, serializeFamilyData(familyData));
}
