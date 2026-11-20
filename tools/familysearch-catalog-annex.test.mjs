import test from "node:test";
import assert from "node:assert/strict";
import { classifyAnnexYear, readCatalogAnnexPage } from "./familysearch-catalog-annex.mjs";

test("annex years use literal note clauses without filling gaps or abbreviations", () => {
  for (const note of ["Allegati 1848", "Allegati di nati, matrimoni, morti 1847–1849", "Allegati 1840, 1848"]) assert.equal(classifyAnnexYear(note, 1848), "match");
  for (const note of ["Allegati 1846, 1849", "Allegati 1846-1847"]) assert.equal(classifyAnnexYear(note, 1848), "outside");
  for (const note of ["Allegati 1847-49", "Allegati 1849-1847", "Allegati 1848?", "Allegati 1847 to 1849", "Allegati 1847-", "Allegati"]) assert.equal(classifyAnnexYear(note, 1848), "ambiguous");
  assert.equal(classifyAnnexYear("Nati 1848", 1848), "unrelated");
  for (const note of ["Allegati 1847/1849", "Allegati 1848/1849", "Allegati 1847..1849", "Allegati 1847 a 1849", "Allegati 1847-18490"]) assert.equal(classifyAnnexYear(note, 1848), "ambiguous");
  assert.throws(() => classifyAnnexYear("Allegati 1848", NaN));
});

test("browser reader filters before returning rows and reports cap and ambiguity", () => {
  const row = (note, film = "1848") => ({ querySelectorAll: (selector) => selector === "td" ? [note, film].map((textContent) => ({ textContent })) : [] });
  const rows = [row("Nati 1848"), row("Allegati 1846, 1849"), row("Allegati 1847-49"), ...Array.from({ length: 21 }, () => row("Allegati 1848"))];
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const controls = [
    { tagName: "BUTTON", textContent: "", disabled: true, getAttribute: (name) => name === "aria-label" ? "Go to next Page. Currently on Page 1 of 1" : null },
    { tagName: "DIV", textContent: "", getAttribute: (name) => ({ "aria-label": "Rows per page", "aria-valuetext": "100" })[name] || null },
  ];
  globalThis.document = { title: "Catalogue", querySelectorAll: (selector) => selector === "table tr" ? rows : selector.includes("combobox") ? controls : [] };
  globalThis.location = { href: "https://www.familysearch.org/en/search/catalog/koha:488050" };
  try {
    const snapshot = readCatalogAnnexPage(1848, classifyAnnexYear);
    assert.equal(snapshot.rowsExamined, 24);
    assert.equal(snapshot.matchingCount, 21);
    assert.equal(snapshot.distinctMatchingCount, 1);
    assert.equal(snapshot.rows.length, 20);
    assert.equal(snapshot.overflow, true);
    assert.equal(snapshot.ambiguousRows, 1);
    assert(snapshot.rows.every((item) => item.cells[0] === "Allegati 1848"));
    assert.match(snapshot.countScope, /loaded DOM only/);
    assert.equal(snapshot.accessInspections, 0);
    assert.equal(snapshot.paginationControls[0].disabled, true);
    assert.equal(snapshot.paginationControls[1].value, "100");
    assert.equal(snapshot.paginationControlsOverflow, false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  }
});
