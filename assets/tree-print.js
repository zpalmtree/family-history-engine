(function exposeFamilyLinePrint(globalObject) {
  "use strict";

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const paperSizes = { letter: [215.9, 279.4], a4: [210, 297], a3: [297, 420] };

  function ancestorSubtree({ rootId, people, links }) {
    const known = new Set(people.map((person) => person.id));
    if (!known.has(rootId)) throw new Error("Choose a person in the family tree.");
    const allParents = new Map();
    for (const link of links) {
      if (!known.has(link.from) || !known.has(link.to)) continue;
      if (!allParents.has(link.to)) allParents.set(link.to, []);
      if (!allParents.get(link.to).some((parent) => parent.from === link.from)) allParents.get(link.to).push(link);
    }
    const roleOrder = { father: 0, mother: 1 };
    for (const parents of allParents.values()) parents.sort((a, b) =>
      (roleOrder[a.role] ?? 2) - (roleOrder[b.role] ?? 2) || a.from.localeCompare(b.from));
    const heights = new Map();
    const visiting = new Set();
    function height(id) {
      if (visiting.has(id)) throw new Error("This ancestry contains a circular parent link.");
      if (heights.has(id)) return heights.get(id);
      visiting.add(id);
      const result = 1 + Math.max(0, ...(allParents.get(id) || []).map((link) => height(link.from)));
      visiting.delete(id);
      heights.set(id, result);
      return result;
    }
    const generationCount = height(rootId);
    const ids = [rootId];
    const seen = new Set(ids);
    const parents = {};
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      parents[id] = (allParents.get(id) || []).map((link) => ({ personId: link.from, status: link.status, evidence: link.evidence || "" }));
      for (const parent of parents[id]) if (!seen.has(parent.personId)) { seen.add(parent.personId); ids.push(parent.personId); }
    }
    // Ahnentafel numbers: the person is 1, a father is 2n and a mother 2n+1.
    // A repeated ancestor keeps the lowest number it reaches.
    const numbers = { [rootId]: 1 };
    const queue = [rootId];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      const ordered = parents[id] || [];
      const roles = (allParents.get(id) || []).map((link) => link.role);
      ordered.forEach((parent, order) => {
        const role = roles[order];
        const number = numbers[id] * 2 + (role === "mother" || (!role && order === 1) ? 1 : 0);
        if (!numbers[parent.personId] || number < numbers[parent.personId]) {
          numbers[parent.personId] = number;
          queue.push(parent.personId);
        }
      });
    }
    ids.sort((a, b) => numbers[a] - numbers[b]);
    return { rootId, ids, parents, generationCount, numbers };
  }

  // Lay out ancestor occurrences, keeping shared ancestors on each branch.
  // Parents sit above their child; complete branches occupy disjoint columns.
  function ancestorLayout(tree, { nodeWidth = 240, nodeHeight = 130, gap = 24, generationGap = 64 } = {}) {
    const nodes = [];
    const links = [];
    let deepest = 0;
    function branch(id, depth, incoming) {
      deepest = Math.max(deepest, depth);
      const node = { id, depth, incoming, instance: nodes.length, children: [] };
      nodes.push(node);
      node.children = (tree.parents[id] || []).map((parent) => branch(parent.personId, depth + 1, parent));
      node.width = Math.max(nodeWidth, node.children.reduce((sum, child) => sum + child.width, 0) + Math.max(0, node.children.length - 1) * gap);
      return node;
    }
    const root = branch(tree.rootId, 0, null);
    function place(node, left) {
      node.x = left + (node.width - nodeWidth) / 2;
      node.y = (deepest - node.depth) * (nodeHeight + generationGap);
      let parentLeft = left;
      for (const parent of node.children) {
        place(parent, parentLeft);
        links.push({ from: parent.instance, to: node.instance, status: parent.incoming.status });
        parentLeft += parent.width + gap;
      }
    }
    place(root, 0);
    return { nodes, links, width: root.width, height: deepest * (nodeHeight + generationGap) + nodeHeight, nodeWidth, nodeHeight };
  }

  // Only viewer-approved display fields enter the report. No record image,
  // private download URL, storage path or account state is embedded in a PDF.
  function reportBlocks(report, { stories = true, sources = true, details = true } = {}) {
    const blocks = [];
    const paragraph = (value, className = "") => `<p class="${className}">${escape(value)}</p>`;
    const add = (content, section, extra = {}) => blocks.push({ content, section, ...extra });
    if (!report.ancestorTree && !report.chartImage) {
    add(`<h1>${escape(report.title)}</h1>${paragraph(`${report.rows.length} generations · ${report.people.length} people · Prepared ${report.date}`, "muted")}
      ${paragraph("Follow the numbered generations from the earliest ancestor to the descendant. Co-parents appear alongside the direct line. Candidate, unresolved and conflicting evidence remain labelled.")}`, "The family line");
    for (const [index, row] of report.rows.entries()) {
      const person = report.people.find((item) => item.id === row.personId);
      const partners = row.coParentIds.map((id) => report.people.find((item) => item.id === id)).filter(Boolean);
      add(`<div class="line-row"><span class="generation">${index + 1}</span><div><h2>${escape(person.name)}</h2>
        ${paragraph(person.dates || "Dates not recorded", "muted")}${paragraph(`Identity: ${person.status}`, "small")}
        ${partners.map((partner) => paragraph(`Co-parent: ${partner.name}${partner.dates ? ` · ${partner.dates}` : ""} · Identity: ${partner.status}`, "small")).join("")}
        ${row.relationship ? paragraph(row.relationship, "relationship") : paragraph("End of this line", "small")}</div></div>`, "The family line");
    }
    }
    if (!details) return blocks;
    const sourceNumbers = new Map(report.sources.map((source, index) => [source.id, index + 1]));
    for (const person of report.people) {
      const facts = person.facts.filter((fact) => fact.value);
      const first = facts.shift();
      add(`<h2 class="person-heading">${person.number ? `${person.number}. ` : ""}${escape(person.name)}</h2>${paragraph(person.role, "muted")}
        ${first ? paragraph(`${first.label}: ${first.value}`, "fact") : ""}`, person.name, { newSection: true });
      for (const fact of facts) add(paragraph(`${fact.label}: ${fact.value}`, "fact"), person.name);
      for (const note of person.notes) add(paragraph(note), person.name);
      if (stories) for (const [index, story] of person.story.entries()) {
        add(`${index === 0 ? "<h3>Life story</h3>" : ""}${paragraph(story)}`, person.name);
      }
      if (sources) {
        const refs = person.sourceIds.map((id) => sourceNumbers.get(id)).filter(Boolean);
        add(paragraph(refs.length ? `Sources: ${refs.map((number) => `[${number}]`).join(", ")}` : "No linked sources are available in the viewer.", "references"), person.name);
      }
    }
    if (sources && report.sources.length) {
      for (const [index, source] of report.sources.entries()) {
        add(`${index === 0 ? "<h1>Sources & references</h1>" + paragraph("Numbers match the references in each profile. These are person-linked sources; a listing does not establish every claim. Original images remain in the protected viewer.", "muted") : ""}
          <h3>[${index + 1}] ${escape(source.title)}</h3>${paragraph([source.kind, source.source, source.date, source.status].filter(Boolean).join(" · "), "muted")}`,
        "Sources & references", { newSection: index === 0 });
        for (const value of [source.reference, source.description]) if (value) add(paragraph(value), "Sources & references");
        if (/^https:\/\//i.test(source.sourceUrl || "")) {
          add(`<p class="source-url"><a href="${escape(source.sourceUrl)}">${escape(source.sourceUrl)}</a></p>`, "Sources & references");
        }
      }
    }
    return blocks;
  }

  function documentHtml(report, paper = "letter", orientation = "auto", chart = "map") {
    let [width, height] = paperSizes[paper] || paperSizes.letter;
    const layout = chart === "fan" && report.fan ? report.fan
      : report.chartImage || (report.ancestorTree ? ancestorLayout(report.ancestorTree) : null);
    if (orientation === "landscape" || (orientation === "auto" && layout && layout.width > layout.height)) [width, height] = [height, width];
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(report.title)}</title><style>
      @page { size: ${width}mm ${height}mm; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #202922; background: #e6e4df; font: 10.5pt/1.45 Georgia, "Times New Roman", serif; }
      .sheet { width: ${width}mm; height: ${height}mm; padding: 13mm 15mm; margin: 14px auto; background: white; display: grid; grid-template-rows: 18mm minmax(0, 1fr) 8mm; break-after: page; box-shadow: 0 1px 8px #0002; }
      .preview-page:last-child .sheet { break-after: auto; }
      header { font: 9pt/1.35 Arial, sans-serif; border-bottom: 1pt solid #31594b; overflow-wrap: anywhere; }
      header strong { display: block; margin-bottom: 2mm; letter-spacing: .07em; text-transform: uppercase; font-size: 8pt; color: #31594b; }
      .page-body { padding: 4mm 0 3mm; min-height: 0; overflow-wrap: anywhere; }
      footer { padding-top: 3mm; border-top: .5pt solid #aaa; display: flex; justify-content: space-between; gap: 5mm; font: 8pt/1.2 Arial, sans-serif; }
      h1 { font: bold 24pt/1.15 Georgia, serif; margin: 0 0 4mm; }
      h2 { font: bold 14pt/1.2 Georgia, serif; margin: 0 0 1mm; }
      h3 { font: bold 11pt/1.3 Arial, sans-serif; margin: 3mm 0 2mm; }
      p { margin: 0 0 2.5mm; }
      .person-heading { border-bottom: .5pt solid #b9c8bd; padding-bottom: 2mm; margin-top: 3mm; }
      .muted, .small, .relationship, .references { font: 9pt/1.4 Arial, sans-serif; }
      .muted { color: #4b554f; }
      .fact { margin-bottom: 2mm; }
      .line-row { display: grid; grid-template-columns: 9mm minmax(0, 1fr); gap: 3mm; padding: 3mm 0; border-bottom: .5pt solid #b9c8bd; }
      .generation { font: bold 15pt/1.2 Georgia, serif; color: #31594b; }
      .relationship { margin-top: 2mm; margin-bottom: 0; }
      .source-url { font: 8.5pt/1.4 Arial, sans-serif; }
      a { color: inherit; text-decoration: underline; }
      .continued { font: italic 9pt/1.3 Georgia, serif; color: #4b554f; margin: 0 0 3mm; }
      .tree-image-print { width: 100%; height: 100%; object-fit: contain; display: block; }
      .ancestor-panel { height: 100%; display: flex; flex-direction: column; }
      .ancestor-panel > p { flex-shrink: 0; }
      .ancestor-chart { position: relative; flex: 1; min-height: 0; overflow: hidden; }
      .ancestor-canvas { position: absolute; transform-origin: top left; }
      .ancestor-chart svg { position: absolute; inset: 0; width: 100%; height: 100%; }
      .ancestor-person { position: absolute; width: 240px; padding: 10px 12px; border: 1px solid #b9c8bd; border-left: 5px solid #31594b; background: #fffdf8; font: 13px/1.35 Arial, sans-serif; overflow-wrap: anywhere; }
      .ancestor-person h3 { margin: 0 0 7px; font: bold 16px/1.2 Georgia, serif; }
      .ancestor-person p { margin-bottom: 5px; }
      .ancestor-person p:last-child { margin-bottom: 0; }
      .ancestor-person .ancestor-evidence { font-size: 12px; }
      .ancestor-person[data-root="true"] { border: 2px solid #31594b; border-left-width: 5px; background: #edf4ee; }
      .ancestor-person[data-status="Candidate"] { border-left-color: #b98a36; }
      .ancestor-person[data-status="Unresolved"] { border-left-color: #8f3430; }
      .ancestor-legend { font: 8pt/1.4 Arial, sans-serif; }
      .fan-print { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
      .fan-print svg { width: 100%; height: 100%; }
      .cover { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 6mm; }
      .cover h1 { font: 500 34pt/1.08 Georgia, serif; margin: 0; }
      .cover .cover-sub { font: 13pt/1.45 Georgia, serif; color: #4b554f; margin: 0; }
      .cover dl { display: grid; grid-template-columns: max-content 1fr; gap: 2mm 6mm; margin: 4mm 0 0; font: 10.5pt/1.4 Arial, sans-serif; }
      .cover dt { color: #4b554f; }
      .cover dd { margin: 0; }
      .cover .cover-lines { display: flex; flex-wrap: wrap; gap: 2mm 6mm; font: 9pt/1.4 Arial, sans-serif; }
      .cover .cover-lines span { display: inline-flex; align-items: center; gap: 2mm; }
      .cover .cover-lines i { width: 3.5mm; height: 3.5mm; border-radius: 0.8mm; display: inline-block; }
      @media screen {
        .preview-page { width: calc(${width}mm * var(--preview-scale, 1)); height: calc(${height}mm * var(--preview-scale, 1)); margin: 14px auto; overflow: hidden; box-shadow: 0 1px 8px #0002; }
        .sheet { margin: 0; transform: scale(var(--preview-scale, 1)); transform-origin: top left; }
      }
      @media print { body { background: white; } .preview-page { display: contents; } .sheet { margin: 0; box-shadow: none; transform: none; } }
    </style></head><body></body></html>`;
  }

  function paginate(doc, report, options) {
    doc.body.replaceChildren();
    const chartChoice = options.chart || "map";
    let body;
    let page;
    let section;
    function newPage(label) {
      section = label;
      page = doc.createElement("section");
      page.className = "sheet";
      page.innerHTML = `<header><strong>${escape(report.brand || "Family history")}</strong>${escape(report.title)}</header><div class="page-body"></div><footer><span>${escape(label)}</span><span class="page-number"></span></footer>`;
      const previewPage = doc.createElement("div");
      previewPage.className = "preview-page";
      previewPage.append(page);
      doc.body.append(previewPage);
      body = page.querySelector(".page-body");
    }
    function fits() { return body.scrollHeight <= body.clientHeight + 1; }
    function element(content) {
      const node = doc.createElement("div");
      node.className = "report-block";
      node.innerHTML = content;
      return node;
    }
    if (report.cover && options.cover !== false) {
      newPage("Cover");
      const cover = doc.createElement("section");
      cover.className = "cover";
      cover.innerHTML = `<h1>${escape(report.cover.title)}</h1>
        ${report.cover.subtitle ? `<p class="cover-sub">${escape(report.cover.subtitle)}</p>` : ""}
        <dl>${(report.cover.facts || []).map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>
        ${(report.cover.lines || []).length ? `<div class="cover-lines">${report.cover.lines.map((line) => `<span><i style="background:${escape(line.color)}"></i>${escape(line.label)}</span>`).join("")}</div>` : ""}`;
      body.append(cover);
    }
    newPage("The family line");
    if (chartChoice === "fan" && report.fan) {
      const fan = doc.createElement("div");
      fan.className = "fan-print";
      fan.innerHTML = report.fan.svg;
      body.append(fan);
    } else if (report.chartImage) {
      const image = doc.createElement("img");
      image.className = "tree-image-print";
      image.src = report.chartImage.url;
      image.alt = report.title;
      image.dataset.personIds = JSON.stringify(report.chartImage.personIds || []);
      body.append(image);
    } else if (report.ancestorTree) {
      doc.body.replaceChildren();
      ancestorCharts(doc, report, newPage, () => body);
      section = "The family line";
    }
    for (const block of reportBlocks(report, options)) {
      // Start the profiles and the reference appendix on a fresh page; pack
      // subsequent profiles where space allows without orphaning their title.
      if (block.newSection && (section === "The family line" || block.section === "Sources & references")) newPage(block.section);
      let node = element(block.content);
      body.append(node);
      if (fits()) { section = block.section; continue; }
      node.remove();
      if (body.children.length) newPage(block.section);
      body.append(node);
      if (fits()) { section = block.section; continue; }

      // A single very long note/reference must flow too. Split at word
      // boundaries, measuring real font metrics; never shrink or clip text.
      // Retain paragraph boundaries as whitespace when an oversized block is split.
      const textParts = [...node.children].map((child) => child.textContent).join("\n");
      let words = textParts.split(/\s+/).filter(Boolean);
      node.remove();
      while (words.length) {
        const part = doc.createElement("p");
        part.className = "report-block";
        body.append(part);
        let low = 1;
        let high = words.length;
        let count = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          part.textContent = words.slice(0, middle).join(" ");
          if (fits()) { count = middle; low = middle + 1; } else { high = middle - 1; }
        }
        if (!count) throw new Error("A report item cannot fit on this paper size.");
        part.textContent = words.splice(0, count).join(" ");
        if (words.length) newPage(`${block.section} (continued)`);
      }
      section = block.section;
    }
    const pages = [...doc.querySelectorAll(".sheet")];
    pages.forEach((sheet, index) => { sheet.querySelector(".page-number").textContent = `${index + 1} / ${pages.length}`; });
    return pages.length;
  }

  function ancestorCharts(doc, report, newPage, pageBody) {
    const tree = report.ancestorTree;
    const people = new Map(report.people.map((person) => [person.id, person]));
    newPage("Ancestor tree · fit to one page");
    const panel = doc.createElement("section");
    panel.className = "ancestor-panel";
    panel.innerHTML = `<p class="muted">${report.people.length - 1} ancestors · ${tree.generationCount} generations · ${escape(report.date)}</p>
      <p class="ancestor-legend">Oldest ancestors at the top; ${escape(people.get(tree.rootId).name)} at the bottom. Solid lines: established parent links. Dashed lines: unresolved. Repeated ancestors keep the same number.</p>
      <div class="ancestor-chart"><div class="ancestor-canvas"></div></div>`;
    pageBody().append(panel);
    const chart = panel.querySelector(".ancestor-chart");
    const canvas = panel.querySelector(".ancestor-canvas");
    const initial = ancestorLayout(tree);
    const cards = initial.nodes.map((node) => {
      const profile = people.get(node.id);
      const card = doc.createElement("article");
      card.className = "ancestor-person";
      card.dataset.personId = node.id;
      card.dataset.instance = node.instance;
      card.dataset.root = String(node.id === tree.rootId);
      card.dataset.status = profile.status;
      const evidence = node.incoming && (node.incoming.evidence || (node.incoming.status === "confirmed" ? "Established" : node.incoming.status || "Unclassified"));
      card.innerHTML = `<h3>${profile.number}. ${escape(profile.name)}</h3><p>${escape(profile.dates || "Dates not recorded")}</p>
        ${profile.chartPlace ? `<p>${escape(profile.chartPlace)}</p>` : ""}
        ${profile.status !== "Established" ? `<p class="ancestor-evidence">Identity: ${escape(profile.status)}</p>` : ""}
        ${evidence && evidence !== "Established" ? `<p class="ancestor-evidence">Parent link: ${escape(evidence)}</p>` : ""}`;
      canvas.append(card);
      return card;
    });
    // Measure at readable map scale first, then uniformly fit the complete
    // vector/text diagram into the printable area. Never drop distant branches.
    const height = Math.max(110, ...cards.map((card) => card.offsetHeight));
    const layout = ancestorLayout(tree, { nodeHeight: height });
    for (const node of layout.nodes) {
      const card = cards[node.instance];
      Object.assign(card.style, { left: `${node.x}px`, top: `${node.y}px`, height: `${height}px` });
    }
    const paths = layout.links.map((link) => {
      const parent = layout.nodes[link.from], child = layout.nodes[link.to];
      const x1 = parent.x + layout.nodeWidth / 2, y1 = parent.y + height;
      const x2 = child.x + layout.nodeWidth / 2, y2 = child.y;
      return `<path data-parent="${link.from}" data-child="${link.to}" d="M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2}" fill="none" stroke="${link.status === "unresolved" ? "#b98a36" : "#31594b"}" stroke-width="2"${link.status === "unresolved" ? ' stroke-dasharray="6 4"' : ""}/>`;
    });
    canvas.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${paths.join("")}</svg>`);
    const scale = Math.min(1, (chart.clientWidth - 2) / layout.width, (chart.clientHeight - 2) / layout.height);
    if (!(scale > 0)) throw new Error("The tree cannot fit in the printable area.");
    Object.assign(canvas.style, {
      width: `${layout.width}px`, height: `${layout.height}px`, transform: `scale(${scale})`,
      left: `${(chart.clientWidth - layout.width * scale) / 2}px`, top: `${(chart.clientHeight - layout.height * scale) / 2}px`
    });
    chart.dataset.scale = scale;
  }

  function open(report, ownerDocument = document) {
    const previous = ownerDocument.querySelector("#family-line-print-dialog");
    if (previous) { previous.close(); previous.remove(); }
    const dialog = ownerDocument.createElement("dialog");
    dialog.id = "family-line-print-dialog";
    dialog.className = "family-line-print-dialog";
    dialog.setAttribute("aria-labelledby", "family-line-print-title");
    dialog.innerHTML = `<div class="family-line-print-controls">
      <div class="family-line-print-heading"><h3 id="family-line-print-title">${report.ancestorTree ? "Print ancestor tree" : report.chartImage ? "Print current tree" : "Print family line"}</h3><button class="tree-control-button reset" type="button" data-print-close>Close</button></div>
      <p>${(report.ancestorTree || report.chartImage) ? "The tree fits on one page. Larger trees have smaller text; choose A3 or zoom into the saved PDF. Person details add separate pages. " : ""}Save a PDF or print on paper. Choose “Save as PDF” in the print dialog. Use 100% scale and turn off browser headers and footers.</p>
      <div class="family-line-print-options">
        ${report.fan ? '<label>Chart <select data-print-chart><option value="map">Tree as on the map</option><option value="fan">Fan chart</option></select></label>' : ""}
        <label>Paper <select data-print-paper><option value="letter">Letter</option><option value="a4">A4</option>${(report.ancestorTree || report.chartImage) ? '<option value="a3">A3</option>' : ""}</select></label>
        ${(report.ancestorTree || report.chartImage) ? '<label>Orientation <select data-print-orientation><option value="auto">Best fit</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>' : ""}
        ${report.cover ? '<label><input type="checkbox" data-print-cover checked> Cover page</label>' : ""}
        <label><input type="checkbox" data-print-details ${(report.ancestorTree || report.chartImage) ? "" : "checked"}> Person details</label>
        <label><input type="checkbox" data-print-stories checked> Life stories</label>
        <label><input type="checkbox" data-print-sources checked> Source references</label>
        <button class="tree-control-button reset" type="button" data-print-save disabled>Print / Save PDF</button>
        <span data-print-status role="status">Preparing pages…</span>
      </div></div><iframe title="${report.ancestorTree ? "Ancestor tree" : report.chartImage ? "Current tree" : "Family line"} print preview"></iframe>`;
    const opener = ownerDocument.activeElement;
    dialog.addEventListener("close", () => {
      const back = opener?.isConnected && opener.offsetParent !== null ? opener : ownerDocument.querySelector("[data-tree-more]");
      back?.focus?.({ preventScroll: true });
    });
    ownerDocument.body.append(dialog);
    const chartSelect = dialog.querySelector("[data-print-chart]");
    if (chartSelect && report.defaultChart === "fan") chartSelect.value = "fan";
    const frame = dialog.querySelector("iframe");
    const button = dialog.querySelector("[data-print-save]");
    const status = dialog.querySelector("[data-print-status]");
    function fitPreview() {
      const doc = frame.contentDocument;
      const sheet = doc?.querySelector(".sheet");
      if (sheet) doc.documentElement.style.setProperty("--preview-scale", Math.min(1, Math.max(1, frame.clientWidth - 28) / sheet.offsetWidth));
    }
    const resize = new ResizeObserver(fitPreview);
    resize.observe(frame);
    function refresh() {
      const options = Object.fromEntries(["details", "stories", "sources"].map((key) => [key, dialog.querySelector(`[data-print-${key}]`).checked]));
      options.cover = dialog.querySelector("[data-print-cover]")?.checked !== false;
      options.chart = dialog.querySelector("[data-print-chart]")?.value || "map";
      for (const key of ["stories", "sources"]) dialog.querySelector(`[data-print-${key}]`).disabled = !options.details;
      button.disabled = true;
      status.textContent = "Preparing pages…";
      frame.onload = async () => {
        try {
          const count = paginate(frame.contentDocument, report, options);
          await Promise.all([...frame.contentDocument.images].map(image => image.decode()));
          if (!dialog.isConnected) return;
          frame.contentDocument.addEventListener("keydown", event => {
            if (event.key === "Escape" || (event.altKey && event.key === "ArrowLeft")) {
              event.preventDefault(); globalObject.familyViewerNavigation?.back();
            }
          });
          fitPreview();
          status.textContent = `${count} ${count === 1 ? "page" : "pages"} · ${options.chart === "fan" && report.fan ? "fan chart" : (report.ancestorTree || report.chartImage) ? `${report.chartImage ? report.chartImage.nodeCount + " cards" : report.people.length - 1 + " ancestors"}` : `${report.rows.length} generations`}`;
          button.disabled = false;
        } catch (error) {
          status.textContent = `Unable to prepare report: ${error.message}`;
        }
      };
      frame.srcdoc = documentHtml(report, dialog.querySelector("[data-print-paper]").value, dialog.querySelector("[data-print-orientation]")?.value || "auto", options.chart);
    }
    dialog.querySelector("[data-print-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { resize.disconnect(); if (report.chartImage) URL.revokeObjectURL(report.chartImage.url); dialog.remove(); }, { once: true });
    dialog.querySelectorAll("input, select").forEach((control) => control.addEventListener("change", refresh));
    button.addEventListener("click", () => { frame.contentWindow.focus(); frame.contentWindow.print(); });
    dialog.showModal();
    globalObject.familyViewerNavigation?.registerDialog(dialog);
    refresh();
  }

  globalObject.familyLinePrint = Object.freeze({ open, reportBlocks, documentHtml, paginate, ancestorSubtree, ancestorLayout });
})(globalThis);
