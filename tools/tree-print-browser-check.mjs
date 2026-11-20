// Runs in the task-owned Windows Chrome page, after a focused lineage is open.
// Keep self-contained so Playwright can serialize it with page.evaluate().
export async function checkFamilyLinePrint() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitReady = async () => {
    const end = Date.now() + 5000;
    while (document.querySelector("[data-print-save]")?.disabled && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(!document.querySelector("[data-print-save]")?.disabled, "Print preview did not become ready");
  };
  document.querySelector("[data-tree-lineage-print]").click();
  const deadline = Date.now() + 30000;
  while (!document.querySelector("#family-line-print-dialog") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const dialog = document.querySelector("#family-line-print-dialog");
  assert(dialog, "Print dialog did not open");
  const frame = dialog.querySelector("iframe");
  const inspect = () => {
    const pages = [...frame.contentDocument.querySelectorAll(".sheet")];
    assert(pages.length > 0, "Print preview is empty");
    for (const [index, sheet] of pages.entries()) {
      const body = sheet.querySelector(".page-body");
      assert(body.scrollHeight <= body.clientHeight + 1, `Page ${index + 1} clips vertically`);
      assert(body.scrollWidth <= body.clientWidth + 1, `Page ${index + 1} clips horizontally`);
      assert(body.textContent.trim() || body.querySelector("img")?.naturalWidth, `Page ${index + 1} is blank`);
      assert(sheet.querySelector(".page-number").textContent === `${index + 1} / ${pages.length}`, "Incorrect page numbering");
    }
    return pages.length;
  };
  try {
    await waitReady();
    const letterPages = inspect();
    dialog.querySelector("[data-print-details]").click();
    await waitReady();
    const original = frame.contentDocument.body.textContent;
    const select = dialog.querySelector("[data-print-paper]");
    select.value = "a4";
    select.dispatchEvent(new Event("change"));
    await waitReady();
    const a4Pages = inspect();
    const a4Text = frame.contentDocument.body.textContent;
    assert(a4Text.includes("Sources & references") === original.includes("Sources & references"), "A4 lost the reference section");
    dialog.querySelector("[data-print-details]").click();
    await waitReady();
    const overviewPages = inspect();
    assert(overviewPages <= a4Pages, "Compact report grew unexpectedly");
    assert(dialog.querySelector("[data-print-sources]").disabled, "Source toggle must disable for overview-only reports");
    assert(!frame.contentDocument.querySelector(".person-heading"), "Overview includes profiles");
    let printCalls = 0;
    frame.contentWindow.print = () => { printCalls += 1; };
    dialog.querySelector("[data-print-save]").click();
    assert(printCalls === 1, "Print button did not print the report frame");

    // Stress the measured splitter with a note much taller than one page.
    const longNote = Array.from({ length: 5000 }, (_, index) => `word-${index}`).join(" ");
    const person = { id: "test", name: "Print fixture", status: "Candidate", dates: "Born before 1800",
      role: "Generation 1", facts: [], notes: [longNote], story: [], sourceIds: [] };
    const fixture = { title: "Long-note pagination", date: "test", rows: [{ personId: "test", coParentIds: [] }], people: [person], sources: [] };
    const stressPages = globalThis.familyLinePrint.paginate(frame.contentDocument, fixture, {});
    inspect();
    const words = (frame.contentDocument.body.textContent.match(/word-\d+/g) || []);
    assert(words.length === 5000 && words.every((word, index) => word === `word-${index}`), "Long-note pagination lost or reordered text");
    return { letterPages, a4Pages, overviewPages, stressPages, preservedWords: words.length, printCalls };
  } finally {
    dialog.close();
  }
}

// Run with a person-detail dialog open. The optional expected IDs come from an
// independent traversal of the data, so a plausible-looking partial tree fails.
export async function checkAncestorTreePrint(expectedIds) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  document.querySelector("[data-tree-person-print]").click();
  const deadline = Date.now() + 30000;
  while (!document.querySelector("#family-line-print-dialog") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const dialog = document.querySelector("#family-line-print-dialog");
  assert(dialog, "Print dialog did not open");
  const frame = dialog.querySelector("iframe");
  const ready = async () => {
    const deadline = Date.now() + 10000;
    while (dialog.querySelector("[data-print-save]").disabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!dialog.querySelector("[data-print-save]").disabled, dialog.querySelector("[data-print-status]").textContent);
  };
  function inspect() {
    const doc = frame.contentDocument;
    const pages = [...doc.querySelectorAll(".sheet")];
    const image = doc.querySelector(".tree-image-print");
    if (image) assert(image.complete && image.naturalWidth > 0, "Tree image did not decode");
    const ids = new Set(image ? JSON.parse(image.dataset.personIds) : [...doc.querySelectorAll(".ancestor-person")].map((node) => node.dataset.personId));
    assert(pages.length > 0, "Ancestor tree has no pages");
    if (expectedIds) assert(ids.size === expectedIds.length && expectedIds.every((id) => ids.has(id)), "Ancestor tree omitted a branch or included an unrelated person");
    for (const [index, page] of pages.entries()) {
      const body = page.querySelector(".page-body");
      assert(body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1, `Ancestor page ${index + 1} overflows`);
      assert(page.querySelector(".page-number").textContent === `${index + 1} / ${pages.length}`, "Wrong ancestor page number");
    }
    for (const chart of doc.querySelectorAll(".ancestor-chart")) {
      const canvas = chart.querySelector(".ancestor-canvas");
      const area = chart.getBoundingClientRect(), bounds = canvas.getBoundingClientRect();
      assert(bounds.left >= area.left - 1 && bounds.right <= area.right + 1
        && bounds.top >= area.top - 1 && bounds.bottom <= area.bottom + 1, "Scaled tree is clipped");
      for (const link of chart.querySelectorAll("path[data-parent]")) {
        const parent = chart.querySelector(`[data-instance="${link.dataset.parent}"]`);
        const child = chart.querySelector(`[data-instance="${link.dataset.child}"]`);
        assert(parent.offsetTop + parent.offsetHeight < child.offsetTop, "Parents must appear above their child");
      }
      const cards = [...chart.querySelectorAll(".ancestor-person")];
      for (let first = 0; first < cards.length; first += 1) for (let second = first + 1; second < cards.length; second += 1) {
        const a = cards[first], b = cards[second];
        assert(a.offsetLeft + a.offsetWidth <= b.offsetLeft + 1 || b.offsetLeft + b.offsetWidth <= a.offsetLeft + 1
          || a.offsetTop + a.offsetHeight <= b.offsetTop + 1 || b.offsetTop + b.offsetHeight <= a.offsetTop + 1, "Ancestor cards overlap");
      }
    }
    return { pages: pages.length, people: ids.size };
  }
  try {
    await ready();
    // A cover page leads by default; the geometry checks below use the tree
    // page alone.
    assert(frame.contentDocument.querySelector(".cover h1"), "Cover page is missing");
    assert(frame.contentDocument.querySelectorAll(".sheet").length === 2, "Cover plus one tree page expected");
    dialog.querySelector("[data-print-cover]").click();
    await ready();
    const letter = inspect();
    assert(letter.pages === 1, "The complete tree must fit on one page by default");
    let printableHtml = frame.contentDocument.documentElement.outerHTML;
    const chartImage = frame.contentDocument.querySelector(".tree-image-print");
    if (chartImage) {
      const blob = await (await fetch(chartImage.src)).blob();
      const embedded = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
      printableHtml = printableHtml.replace(chartImage.src, embedded);
    }
    assert(!dialog.querySelector("[data-print-details]").checked, "Ancestor export should start with the tree diagram");
    const paper = dialog.querySelector("[data-print-paper]");
    paper.value = "a4";
    paper.dispatchEvent(new Event("change"));
    await ready();
    const a4 = inspect();
    assert(a4.pages === 1, "A4 must fit the complete tree on one page");
    const orientation = dialog.querySelector("[data-print-orientation]");
    orientation.value = "portrait";
    orientation.dispatchEvent(new Event("change"));
    await ready();
    assert(inspect().pages === 1, "Portrait must fit the complete tree on one page");
    paper.value = "a3";
    paper.dispatchEvent(new Event("change"));
    await ready();
    assert(inspect().pages === 1, "A3 must fit the complete tree on one page");
    const chartChoice = dialog.querySelector("[data-print-chart]");
    assert(chartChoice, "Fan chart option is missing");
    chartChoice.value = "fan";
    chartChoice.dispatchEvent(new Event("change"));
    await ready();
    const fanDoc = frame.contentDocument;
    const fanBody = fanDoc.querySelector(".fan-print")?.closest(".page-body");
    assert(fanDoc.querySelector(".fan-print svg") && fanBody, "Fan chart page is missing");
    assert(fanBody.scrollHeight <= fanBody.clientHeight + 1 && fanBody.scrollWidth <= fanBody.clientWidth + 1, "Fan chart page overflows");
    const fanArea = fanBody.getBoundingClientRect();
    assert([...fanDoc.querySelectorAll(".fan-print text")].every((text) => {
      const box = text.getBoundingClientRect();
      return !box.width || (box.left >= fanArea.left - 1 && box.right <= fanArea.right + 1 && box.top >= fanArea.top - 1 && box.bottom <= fanArea.bottom + 1);
    }), "Fan chart labels leave the page");
    chartChoice.value = "map";
    chartChoice.dispatchEvent(new Event("change"));
    dialog.querySelector("[data-print-details]").click();
    await ready();
    const details = inspect();
    assert(frame.contentDocument.querySelectorAll(".person-heading").length === letter.people, "Person appendix must contain each ancestor once");
    return { letter, a4, details, printableHtml };
  } finally { dialog.close(); }
}
