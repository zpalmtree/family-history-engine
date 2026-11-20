import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(new URL("../assets/tree-print.js", import.meta.url), "utf8"), context);
const { reportBlocks, documentHtml, ancestorSubtree, ancestorLayout } = context.globalThis.familyLinePrint;
const person = (id, name) => ({ id, name, status: "Candidate", dates: "Born about 1800",
  role: "Direct line", facts: [{ label: "Born", value: "about 1800 — Conflicting evidence" }],
  notes: ["A bounded note"], story: ["A life story"], sourceIds: ["record"] });
const report = {
  title: "Ancestor <script> to Descendant", date: "14 October 2026",
  rows: [{ personId: "a", coParentIds: ["b"], relationship: "A → C: Candidate parent link" }, { personId: "c", coParentIds: [] }],
  people: [person("a", "Ancestor <script>"), person("b", "Co-parent"), person("c", "Descendant")],
  sources: [{ id: "record", title: "Parish register", reference: "Page 12", kind: "Citation", sourceUrl: "https://example.org/record?a=1&b=2", fileUrl: "PRIVATE-ORIGINAL", blobPath: "PRIVATE-STORAGE" }]
};

test("report preserves uncertain dates, co-parents, relationship evidence and deduplicated source references", () => {
  const html = reportBlocks(report).map((block) => block.content).join("\n");
  assert.match(html, /Co-parent/);
  assert.match(html, /Candidate parent link/);
  assert.match(html, /about 1800 — Conflicting evidence/);
  assert.equal((html.match(/Sources: \[1\]/g) || []).length, 3);
  assert.equal((html.match(/\[1\] Parish register/g) || []).length, 1);
  assert.match(html, /Page 12/);
  assert.match(html, /https:\/\/example.org\/record\?a=1&amp;b=2/);
  assert.doesNotMatch(html, /PRIVATE-|<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("overview-only and optional stories/references exclude the corresponding report sections", () => {
  const overview = reportBlocks(report, { details: false }).map((block) => block.content).join("");
  assert.match(overview, /Candidate parent link/);
  assert.doesNotMatch(overview, /A life story|A bounded note|Parish register/);
  const facts = reportBlocks(report, { stories: false, sources: false }).map((block) => block.content).join("");
  assert.match(facts, /A bounded note/);
  assert.doesNotMatch(facts, /A life story|Parish register|Sources: \[1\]/);
});

test("source links reject active protocols and paper sizes cannot inject HTML", () => {
  const unsafe = { ...report, sources: [{ ...report.sources[0], sourceUrl: 'javascript:alert("x")' }] };
  assert.doesNotMatch(reportBlocks(unsafe).map((block) => block.content).join(""), /javascript:/);
  assert.match(documentHtml(report, "letter"), /size: 215.9mm 279.4mm/);
  assert.match(documentHtml(report, "a4"), /size: 210mm 297mm/);
  assert.match(documentHtml(report, "invalid"), /size: 215.9mm 279.4mm/);
  assert.doesNotMatch(documentHtml(report), /<script>/);
});

test("a person's subtree includes every paternal and maternal branch, not spouses, children or siblings", () => {
  const people = ["root", "father", "mother", "paternal", "maternal", "shared", "spouse", "sibling", "child"].map((id) => ({ id }));
  const links = [
    ["father", "root"], ["mother", "root"], ["paternal", "father"], ["maternal", "mother"],
    ["shared", "paternal"], ["shared", "maternal"], ["root", "child"], ["spouse", "child"], ["father", "sibling"]
  ].map(([from, to]) => ({ from, to, status: "candidate", evidence: "Candidate — Family information" }));
  const result = ancestorSubtree({ rootId: "root", people, links });
  assert.deepEqual([...result.ids].sort(), ["father", "maternal", "mother", "paternal", "root", "shared"]);
  assert.equal(result.generationCount, 4);
  assert.equal(result.parents.root.length, 2);
  assert.equal(result.parents.maternal[0].personId, "shared");
  assert.equal(result.parents.paternal[0].personId, "shared");
  assert.match(result.parents.root[0].evidence, /Candidate/);
});

test("subtrees handle a person with no known parents, reject cycles and ignore unavailable people", () => {
  const people = [{ id: "root" }, { id: "parent" }];
  const empty = ancestorSubtree({ rootId: "root", people, links: [{ from: "unavailable", to: "root" }] });
  assert.deepEqual([...empty.ids], ["root"]);
  assert.equal(empty.generationCount, 1);
  assert.throws(() => ancestorSubtree({ rootId: "root", people, links: [{ from: "parent", to: "root" }, { from: "root", to: "parent" }] }), /circular/);
  assert.throws(() => ancestorSubtree({ rootId: "unknown", people, links: [] }), /Choose a person/);
});


test("top-down ancestor layout preserves both branches and shared occurrences without overlap", () => {
  const tree = { rootId: "child", parents: {
    child: [{ personId: "father" }, { personId: "mother" }],
    father: [{ personId: "shared" }], mother: [{ personId: "shared" }], shared: []
  }};
  const layout = ancestorLayout(tree);
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.nodes.filter((node) => node.id === "shared").length, 2);
  assert.equal(layout.links.length, 4);
  for (const link of layout.links) {
    const parent = layout.nodes[link.from], child = layout.nodes[link.to];
    assert.ok(parent.y + layout.nodeHeight < child.y, "parents must be above children");
  }
  for (const a of layout.nodes) for (const b of layout.nodes) {
    if (a.instance >= b.instance) continue;
    assert.ok(a.x + layout.nodeWidth <= b.x || b.x + layout.nodeWidth <= a.x
      || a.y + layout.nodeHeight <= b.y || b.y + layout.nodeHeight <= a.y);
  }
  const single = ancestorLayout({ rootId: "alone", parents: {} });
  assert.equal(single.nodes.length, 1);
  assert.equal(single.height, single.nodeHeight);
});

test("tree paper orientation uses the diagram aspect ratio with explicit overrides", () => {
  const wide = { ...report, ancestorTree: { rootId: "a", parents: { a: [{ personId: "b" }, { personId: "c" }] } } };
  assert.match(documentHtml(wide), /size: 279.4mm 215.9mm/);
  assert.match(documentHtml(wide, "a3"), /size: 420mm 297mm/);
  assert.match(documentHtml(wide, "a4", "portrait"), /size: 210mm 297mm/);
  const tall = { ...wide, ancestorTree: { rootId: "a", parents: { a: [{ personId: "b" }], b: [{ personId: "c" }] } } };
  assert.match(documentHtml(tall), /size: 215.9mm 279.4mm/);
  assert.match(documentHtml(tall, "letter", "landscape"), /size: 279.4mm 215.9mm/);
});
