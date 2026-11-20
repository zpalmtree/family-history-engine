// Computes each visual-tree person's map flag with the viewer's own code, so
// data checks see exactly what index.html renders (including probable flags).
import fs from "node:fs";
import vm from "node:vm";

const viewerSlices = Object.freeze([
  ["    const parentsByChild = new Map();", "    function ancestorDepths("],
  ["    function ancestryProfile(", "    function probableOriginDetail("],
  ["    function countryFlagProfile(", "    function originBadge("]
]);

function viewerFlagCode(source) {
  return viewerSlices.map(([start, end]) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`tree-flags: index.html no longer contains ${JSON.stringify(start.trim())}`);
    return source.slice(from, to);
  }).join("\n")
    // The legend loop touches the DOM; it does not affect any person's flag.
    .replace(/\n    for \(const key of document\.querySelectorAll\("\[data-origin-key\]"\)\) \{[\s\S]*?\n    \}\n/, "\n");
}

export function treeFlags(familyData, { indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8") } = {}) {
  const context = {
    familyData,
    text: (value) => value == null ? "" : String(value),
    peopleById: new Map(familyData.people.map((person) => [person.id, person])),
    ancestryProfileCache: new Map()
  };
  vm.runInNewContext(`${viewerFlagCode(indexHtml)}
    this.flagFor = (personId) => {
      const person = peopleById.get(personId);
      const ancestry = ancestryProfile(personId);
      return countryFlagProfile({
        origins: ancestry.origins,
        originComplete: ancestry.complete,
        places: (person?.places || []).filter((place) => text(place.value).trim()),
        probableOrigins: ancestry.origins.length ? [] : probableOrigins(personId)
      });
    };`, context);
  const ids = [...new Set((familyData.visualTree?.nodes || []).map((node) => node.id))];
  // Copy out of the VM realm so callers get ordinary objects and arrays.
  return new Map(ids.map((personId) => [personId, JSON.parse(JSON.stringify(context.flagFor(personId)))]));
}

export function flaglessTreePeople(familyData, options) {
  return [...treeFlags(familyData, options)]
    .filter(([, flag]) => !flag.countries.length)
    .map(([personId]) => personId);
}
