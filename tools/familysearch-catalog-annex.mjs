// Self-contained functions are serialized into the owned Windows browser tab.
export function classifyAnnexYear(note, year) {
  if (!Number.isInteger(year) || year < 1000 || year > 2099) throw new Error("Invalid catalogue year");
  if (!/\ballegati\b/i.test(note)) return "unrelated";
  const clauses = note.match(/\b(?:1\d{3}|20\d{2})\b(?:\s*[-–—]\s*\d+)?/g) || [];
  if (!clauses.length || /\?|circa|\bca\.|\bc\./i.test(note)) return "ambiguous";
  let matched = false;
  for (const clause of clauses) {
    const years = clause.match(/\d+/g).map(Number);
    if (years.length === 2 && (years[1] < 1000 || years[1] > 2099 || years[1] < years[0])) return "ambiguous";
    if (years.length === 1 ? years[0] === year : years[0] <= year && year <= years[1]) matched = true;
  }
  // Unparsed range punctuation/text must never silently become separate years.
  const remainder = note.replace(/\b(?:1\d{3}|20\d{2})\b(?:\s*[-–—]\s*\d+)?/g, "");
  if (/\d|[-–—/]|\.{2}|\b(?:to|through|al|a)\b/i.test(remainder)) return "ambiguous";
  return matched ? "match" : "outside";
}

export function readCatalogAnnexPage(year, classify) {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const matches = [];
  let rowsExamined = 0;
  let ambiguousRows = 0;
  for (const row of document.querySelectorAll("table tr")) {
    const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.textContent));
    if (!cells.length) continue;
    rowsExamined += 1;
    // Only the literal note cell supplies year coverage, never film/DGS columns.
    const classification = classify(cells[0], year);
    if (classification === "ambiguous") ambiguousRows += 1;
    if (classification !== "match") continue;
    matches.push({ cells, links: [...row.querySelectorAll("a[href]")].map((a) => ({ text: clean(a.textContent), href: a.href })) });
  }
  const controls = [...document.querySelectorAll("button, select, [role='combobox'], [role='navigation'], nav")]
    .map((node) => ({ label: clean(node.getAttribute("aria-label") || node.textContent), disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true", value: node.tagName === "SELECT" ? node.value : node.getAttribute("aria-valuetext") || undefined }))
    .filter((item) => /page|next|previous|\bof\s+\d|rows|results per/i.test(item.label));
  return {
    url: location.href, title: document.title,
    headings: [...document.querySelectorAll("main h1, main h2")].map((node) => clean(node.textContent)),
    year, countScope: "loaded DOM only; catalogue-wide completeness unverified",
    rowsExamined, matchingCount: matches.length, distinctMatchingCount: new Set(matches.map((row) => JSON.stringify(row))).size, ambiguousRows,
    rowLimit: 20, overflow: matches.length > 20, rows: matches.slice(0, 20),
    paginationControls: controls.slice(0, 30), paginationControlsOverflow: controls.length > 30,
    accessInspections: 0,
  };
}
