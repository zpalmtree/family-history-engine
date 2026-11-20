(function exposeFamilyTreeCharts(globalObject) {
  "use strict";

  // Pedigree and fan charts. Both are drawn from accessor functions supplied
  // by the viewer, so they share its family-line colours, flags, dates and
  // evidence statuses without knowing the data model.
  //
  // ctx = {
  //   person(id) -> { id, name, surname, years, place, lineColor, flags: [{ label, src }], status, living }
  //   parents(id) -> [{ id, role, status }]   (father first when known)
  //   children(id) -> [id]
  //   measure(text, font) -> width in px
  // }

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  let measureContext = null;
  function defaultMeasure(value, font) {
    measureContext ||= (globalObject.document?.createElement("canvas")?.getContext("2d") || null);
    if (!measureContext) return String(value).length * parseFloat(font) * 0.56;
    measureContext.font = font;
    return measureContext.measureText(String(value)).width;
  }

  // Ahnentafel slots: 1 is the root, 2n the father and 2n+1 the mother of n.
  // When roles are unknown the first recorded parent takes the even slot.
  function ancestorSlots(ctx, rootId, generations) {
    const slots = new Map([[1, { id: rootId, status: "confirmed" }]]);
    const last = 2 ** generations - 1;
    for (let slot = 1; slot <= last; slot += 1) {
      const entry = slots.get(slot);
      if (!entry || 2 * slot > last) continue;
      const parents = ctx.parents(entry.id) || [];
      const father = parents.find((parent) => parent.role === "father");
      const mother = parents.find((parent) => parent.role === "mother");
      const others = parents.filter((parent) => parent.role !== "father" && parent.role !== "mother");
      const left = father || others.shift();
      const right = mother || others.shift();
      if (left) slots.set(2 * slot, left);
      if (right) slots.set(2 * slot + 1, right);
    }
    return slots;
  }

  // Wrap text into at most maxLines lines of maxWidth, shrinking the font
  // (never below minSize) before giving up a word; never clips mid-word.
  function fitLines(ctx, value, { maxWidth, maxLines, size, minSize, weight = 600, family }) {
    const words = String(value).split(/\s+/).filter(Boolean);
    for (let current = size; current >= minSize; current -= 0.5) {
      const font = `${weight} ${current}px ${family}`;
      const lines = [];
      let line = "";
      let fits = true;
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measure(candidate, font) <= maxWidth) { line = candidate; continue; }
        if (!line || ctx.measure(word, font) > maxWidth) { fits = false; break; }
        lines.push(line);
        line = word;
      }
      if (line) lines.push(line);
      if (fits && lines.length <= maxLines) return { lines, size: current };
    }
    return null;
  }

  /* ---------------- Pedigree ---------------- */

  function renderPedigree(container, ctx, { rootId, generations = 4, onOpen, onReroot, onBack, canGoBack = false, cameFrom = null }) {
    const narrow = container.clientWidth < 620;
    // Screens narrower than about 980px show three generations that fit
    // without sideways scrolling; tapping a person steps further back.
    if (container.clientWidth < 980) generations = Math.min(generations, 3);
    const columnGap = narrow ? 14 : 40;
    const available = container.clientWidth - (narrow ? 20 : 36);
    const cardWidth = Math.floor(Math.max(narrow ? 90 : 150, Math.min(280, (available - (generations - 1) * columnGap) / generations)));
    const cardHeight = narrow ? 76 : 66;
    const rowGap = 8;
    const leaves = 2 ** (generations - 1);
    const slots = ancestorSlots(ctx, rootId, generations);
    const height = leaves * cardHeight + (leaves - 1) * rowGap;
    const width = generations * cardWidth + (generations - 1) * columnGap;
    const position = (slot) => {
      const generation = Math.floor(Math.log2(slot));
      const index = slot - 2 ** generation;
      const span = height / 2 ** generation;
      return {
        x: generation * (cardWidth + columnGap),
        y: index * span + span / 2 - cardHeight / 2,
        generation
      };
    };
    const nameFamily = getComputedStyle(container).getPropertyValue("--display") || "Newsreader, Georgia, serif";
    const root = ctx.person(rootId);
    // The child you stepped up from is listed first.
    const children = (ctx.children(rootId) || []).map((id) => ctx.person(id)).filter(Boolean)
      .sort((a, b) => Number(b.id === cameFrom) - Number(a.id === cameFrom));
    const cards = [];
    const paths = [];
    for (let slot = 1; slot < 2 ** generations; slot += 1) {
      const entry = slots.get(slot);
      const { x, y, generation } = position(slot);
      const childSlot = Math.floor(slot / 2);
      if (slot > 1 && slots.has(childSlot)) {
        const child = position(childSlot);
        const startX = child.x + cardWidth;
        const startY = child.y + cardHeight / 2;
        const midX = startX + columnGap / 2;
        const endY = y + cardHeight / 2;
        const status = entry?.status || "missing";
        paths.push(`<path class="pedigree-link ${escape(status)}" d="M ${startX} ${startY} H ${midX} V ${endY} H ${x}"></path>`);
      }
      if (!entry) {
        if (slot > 1 && slots.has(childSlot) && generation < generations) {
          cards.push(`<div class="pedigree-card missing" style="left:${x}px;top:${y}px;width:${cardWidth}px;height:${cardHeight}px">
            <span>${slot % 2 ? "Mother" : "Father"} not yet found</span></div>`);
        }
        continue;
      }
      const person = ctx.person(entry.id);
      if (!person) continue;
      const fitted = fitLines(ctx, person.name, {
        maxWidth: cardWidth - (narrow ? 20 : 27) - (slot === 1 ? 3 : 0) - (generation === generations - 1 && (ctx.parents(entry.id) || []).length ? 12 : 0),
        maxLines: narrow ? 3 : 2,
        size: narrow ? 13 : 14.5,
        minSize: narrow ? 10 : 11,
        weight: 600,
        family: nameFamily
      });
      const nameHtml = fitted
        ? `<strong style="font-size:${fitted.size}px">${fitted.lines.map(escape).join("<br>")}</strong>`
        : `<strong style="font-size:11px">${escape(person.surname || person.name)}</strong>`;
      const more = generation === generations - 1 && (ctx.parents(entry.id) || []).length;
      const isRoot = slot === 1;
      cards.push(`<button type="button" class="pedigree-card ${escape(person.status)}${isRoot ? " root" : ""}" data-chart-person="${escape(person.id)}"
        style="left:${x}px;top:${y}px;width:${cardWidth}px;height:${cardHeight}px;--line:${escape(person.lineColor)};--flags-w:${person.flags.length ? 15 + (person.flags.length - 1) * 11 + 8 : 0}px"
        aria-label="${escape(person.name)}${person.years ? `, ${escape(person.years)}` : ""}${isRoot ? ". Open details" : ". Show this person's ancestors"}"
        title="${escape(person.name)}${person.place ? ` · ${escape(person.place)}` : ""}">
        ${nameHtml}
        <span class="pedigree-years">${escape(person.years || "")}</span>
        ${person.flags.length ? `<span class="pedigree-flags" title="${escape(person.flags.map((flag) => flag.label).join(", "))}">${person.flags.map((flag) => `<img class="flag-icon" src="${escape(flag.src)}" alt="${escape(flag.label)}">`).join("")}</span>` : ""}
        ${more ? '<span class="pedigree-more" aria-hidden="true">›</span>' : ""}
      </button>`);
    }
    container.innerHTML = `
      <div class="pedigree-head">
        ${canGoBack ? '<button type="button" class="tree-control-button" data-chart-back>Back</button>' : ""}
        <p><strong>${escape(root?.name || "")}</strong> and ${generations - 1} generations of ancestors. Tap a person to see their ancestors.</p>
        <button type="button" class="tree-control-button" data-chart-open="${escape(rootId)}">Details</button>
        ${children.length ? `<span class="pedigree-down">Down to ${children.slice(0, 4).map((child) => `<button type="button" class="person-link" data-chart-person="${escape(child.id)}">${escape(child.name)}</button>`).join(", ")}${children.length > 4 ? ` and <button type="button" class="person-link" data-chart-open="${escape(rootId)}">${children.length - 4} more</button>` : ""}</span>` : ""}
      </div>
      <div class="pedigree-canvas" style="width:${width}px;height:${height}px">
        <svg class="pedigree-links" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${paths.join("")}</svg>
        ${cards.join("")}
      </div>`;
    container.onkeydown = null;
    container.onclick = (event) => {
      if (event.target.closest("[data-chart-back]")) { onBack?.(); return; }
      const open = event.target.closest("[data-chart-open]");
      if (open) { onOpen?.(open.dataset.chartOpen); return; }
      const card = event.target.closest("[data-chart-person]");
      if (!card) return;
      if (card.dataset.chartPerson === rootId) onOpen?.(rootId);
      else onReroot?.(card.dataset.chartPerson);
    };
  }

  /* ---------------- Fan ---------------- */

  // A half-disc fan: the root in the centre, the father's side on the left
  // and the mother's on the right, one ring per generation.
  function fanGeometry(generations, { radius = 70, ring = 72, outerRing = 92 } = {}) {
    const rings = [];
    let inner = radius;
    for (let generation = 1; generation < generations; generation += 1) {
      const width = generation >= 4 ? outerRing : ring;
      rings.push({ generation, inner, outer: inner + width });
      inner += width;
    }
    return { radius, rings, outer: inner };
  }

  function mixWithWhite(hex, amount) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!match) return { css: hex, rgb: null };
    const value = parseInt(match[1], 16);
    const rgb = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => Math.round(channel + (255 - channel) * amount));
    return { css: `rgb(${rgb.join(",")})`, rgb };
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // White or near-black text, whichever contrasts more with the wedge.
  function labelInkFor(rgb) {
    if (!rgb) return "light";
    const l = luminance(rgb);
    const onWhite = 1.05 / (l + 0.05);
    const onInk = (l + 0.05) / (0.0179 + 0.05);
    return onInk > onWhite ? "dark" : "light";
  }

  function contrastWith(rgb, ink) {
    const l = luminance(rgb);
    return ink === "dark" ? (l + 0.05) / (0.0179 + 0.05) : 1.05 / (l + 0.05);
  }

  // The wedge colour and ink, with the fill nudged lighter (dark ink) or
  // darker (white ink) until the label reaches 4.5:1.
  function readableFill(fill) {
    if (!fill.rgb) return { ...fill, ink: "light" };
    const ink = labelInkFor(fill.rgb);
    let rgb = fill.rgb;
    for (let step = 0; step < 24 && contrastWith(rgb, ink) < 4.6; step += 1) {
      rgb = rgb.map((channel) => Math.round(ink === "dark" ? channel + (255 - channel) * 0.08 : channel * 0.93));
    }
    return { css: `rgb(${rgb.join(",")})`, rgb, ink };
  }

  function polar(cx, cy, r, angle) {
    return [cx + r * Math.cos(angle), cy - r * Math.sin(angle)];
  }

  function wedgePath(cx, cy, inner, outer, start, end) {
    const [x1, y1] = polar(cx, cy, outer, start);
    const [x2, y2] = polar(cx, cy, outer, end);
    const [x3, y3] = polar(cx, cy, inner, end);
    const [x4, y4] = polar(cx, cy, inner, start);
    const large = Math.abs(end - start) > Math.PI ? 1 : 0;
    // Angles fall from start to end, which is clockwise on screen.
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${outer} ${outer} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${inner} ${inner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  }

  // Returns a self-contained SVG string (used on screen and in print).
  function fanSvg(ctx, { rootId, generations = 6, interactive = true, title = "" } = {}) {
    const geometry = fanGeometry(generations);
    const pad = 16;
    const width = (geometry.outer + pad) * 2;
    const height = geometry.outer + pad * 2 + 46;
    const cx = width / 2;
    const cy = geometry.outer + pad;
    const slots = ancestorSlots(ctx, rootId, generations);
    const family = "Public Sans, system-ui, sans-serif";
    // A three-generation fan is drawn for narrow phones and shown small, so
    // its labels are drawn larger.
    const textScale = generations <= 3 ? 1.3 : 1;
    const parts = [];
    const labels = [];
    for (const ring of geometry.rings) {
      const count = 2 ** ring.generation;
      for (let index = 0; index < count; index += 1) {
        const slot = count + index;
        // Slot 2^g is the far left (father's father's ... line).
        const start = Math.PI - (index * Math.PI) / count;
        const end = Math.PI - ((index + 1) * Math.PI) / count;
        const entry = slots.get(slot);
        const childKnown = slots.has(Math.floor(slot / 2));
        if (!entry) {
          if (childKnown) parts.push(`<path class="fan-wedge missing" d="${wedgePath(cx, cy, ring.inner, ring.outer, start, end)}"><title>Not yet found</title></path>`);
          continue;
        }
        const person = ctx.person(entry.id);
        if (!person) continue;
        const shade = Math.min(0.5, 0.12 * (ring.generation - 1));
        const fill = readableFill(mixWithWhite(person.lineColor, shade));
        parts.push(`<path class="fan-wedge ${escape(person.status)}${entry.status !== "confirmed" ? " link-" + escape(entry.status) : ""}" data-chart-person="${escape(person.id)}" d="${wedgePath(cx, cy, ring.inner, ring.outer, start, end)}" style="fill:${escape(fill.css)}"${interactive ? ` tabindex="0" role="button" aria-label="${escape(person.name)}${person.years ? `, ${escape(person.years)}` : ""}"` : ""}><title>${escape(person.name)}${person.years ? ` · ${escape(person.years)}` : ""}</title></path>`);
        labels.push(fanLabel(ctx, person, ring, start, end, cx, cy, family, textScale).replace('class="fan-label"', `class="fan-label${fill.ink === "dark" ? " on-light" : ""}"`));
      }
    }
    const root = ctx.person(rootId);
    const rootFit = root ? fitLines(ctx, root.name, { maxWidth: geometry.radius * 1.4, maxLines: 2, size: 15, minSize: 10, weight: 700, family }) : null;
    const rootLines = rootFit?.lines || [root?.surname || ""];
    const rootSize = rootFit?.size || 10;
    // Last name line sits a line above the years (baseline cy - 8).
    const rootFirstBaseline = cy - 8 - 15 - (rootLines.length - 1) * rootSize * 1.15;
    parts.push(`<path class="fan-root" data-chart-person="${escape(rootId)}" d="M ${cx - geometry.radius} ${cy} A ${geometry.radius} ${geometry.radius} 0 0 1 ${cx + geometry.radius} ${cy} Z"${interactive ? ' tabindex="0" role="button" aria-label="Open details"' : ""}></path>`);
    labels.push(`<text class="fan-root-text" x="${cx}" y="${rootFirstBaseline.toFixed(1)}" text-anchor="middle" font-size="${rootSize}" font-family="${family}" font-weight="700">${rootLines.map((line, lineIndex) => `<tspan x="${cx}" dy="${lineIndex ? rootSize * 1.15 : 0}">${escape(line)}</tspan>`).join("")}</text>`);
    if (root?.years) labels.push(`<text class="fan-root-years" x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="11" font-family="${family}">${escape(root.years)}</text>`);
    if (title) labels.push(`<text x="${cx}" y="${height - 14}" text-anchor="middle" font-size="13" font-family="${family}" fill="#5c625d">${escape(title)}</text>`);
    return `<svg class="fan-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="Fan chart of ${escape(root?.name || "")}'s ancestors">
      <style>
        .fan-wedge { stroke: #fffdf8; stroke-width: 1.5; cursor: pointer; }
        .fan-wedge.missing { fill: #f4efe4; stroke: #c4b69e; stroke-dasharray: 3 3; cursor: default; }
        .fan-wedge.link-unresolved { stroke: #933a32; stroke-dasharray: 5 3; stroke-width: 2; }
        .fan-wedge:hover, .fan-wedge:focus-visible { outline: none; stroke: #1f2622; stroke-width: 3; }
        .fan-root { fill: #1f2622; cursor: pointer; }
        .fan-root-text, .fan-root-years { fill: #ffffff; pointer-events: none; }
        .fan-label { fill: #ffffff; pointer-events: none; }
        .fan-label.on-light { fill: #1f2622; }
      </style>
      ${parts.join("")}
      ${labels.join("")}
    </svg>`;
  }

  function fanLabel(ctx, person, ring, start, end, cx, cy, family, textScale = 1) {
    const mid = (start + end) / 2;
    const span = Math.abs(start - end);
    const depth = ring.outer - ring.inner;
    const midRadius = (ring.inner + ring.outer) / 2;
    const arc = span * midRadius;
    const nameParts = String(person.name).split(/\s+/).filter(Boolean);
    const surname = person.surname || nameParts.at(-1) || person.name;
    const initialled = nameParts.length > 1 ? `${nameParts[0][0]}. ${surname}` : "";
    const words = [...new Set([person.name, initialled, surname].filter(Boolean))];
    // Each ring has one label size: a label is shortened before it shrinks.
    const atRingSize = (options) => {
      for (const label of words) {
        const fitted = fitLines(ctx, label, { ...options, minSize: options.size });
        if (fitted) return fitted;
      }
      return fitLines(ctx, surname, { ...options, maxLines: 1 });
    };
    if (arc >= 120) {
      // Wide wedge: text runs across the wedge (rotated tangentially).
      const fitted = atRingSize({ maxWidth: arc * 0.82, maxLines: 2, size: 13 * textScale, minSize: 8, weight: 700, family });
      if (!fitted) return "";
      const [x, y] = polar(cx, cy, midRadius, mid);
      const rotation = 90 - (mid * 180) / Math.PI;
      const lineHeight = fitted.size * 1.12;
      const years = person.years && depth - fitted.lines.length * lineHeight > 16 ? person.years : "";
      const total = fitted.lines.length + (years ? 1 : 0);
      const first = -((total - 1) * lineHeight) / 2;
      return `<text class="fan-label" transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotation.toFixed(2)})" text-anchor="middle" dominant-baseline="middle" font-family="${family}">${fitted.lines.map((line, index) => `<tspan x="0" y="${(first + index * lineHeight).toFixed(1)}" font-size="${fitted.size}" font-weight="700">${escape(line)}</tspan>`).join("")}${years ? `<tspan x="0" y="${(first + fitted.lines.length * lineHeight).toFixed(1)}" font-size="${Math.max(8, fitted.size - 2)}">${escape(years)}</tspan>` : ""}</text>`;
    }
    // Narrow wedge: text runs along the radius, reading outward.
    const across = arc * 0.9;
    const size = Math.min(12 * textScale, across * 0.72);
    const lineHeight = size * 1.1;
    const maxLines = Math.max(1, Math.min(2, Math.floor(across / lineHeight)));
    const fitted = atRingSize({ maxWidth: depth - 10, maxLines, size, minSize: 7, weight: 700, family });
    if (!fitted) return "";
    const height = fitted.size * 1.1;
    const lines = fitted.lines.slice(0, Math.max(1, Math.floor(across / height)));
    const yearsSize = Math.max(7, fitted.size - 2);
    const years = person.years && (lines.length * height + yearsSize * 1.1) <= across
      && ctx.measure(person.years, `400 ${yearsSize}px ${family}`) <= depth - 10 ? person.years : "";
    const total = lines.length + (years ? 1 : 0);
    const [x, y] = polar(cx, cy, midRadius, mid);
    let rotation = -(mid * 180) / Math.PI;
    if (mid > Math.PI / 2) rotation += 180;
    const first = -((total - 1) * height) / 2;
    return `<text class="fan-label" transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotation.toFixed(2)})" text-anchor="middle" dominant-baseline="middle" font-family="${family}" font-weight="700">${lines.map((line, index) => `<tspan x="0" y="${(first + index * height).toFixed(1)}" font-size="${fitted.size}">${escape(line)}</tspan>`).join("")}${years ? `<tspan x="0" y="${(first + lines.length * height).toFixed(1)}" font-size="${yearsSize}" font-weight="400">${escape(years)}</tspan>` : ""}</text>`;
  }

  function renderFan(container, ctx, { rootId, generations = 6, onOpen, onReroot, onBack, canGoBack = false }) {
    const root = ctx.person(rootId);
    container.innerHTML = `
      <div class="pedigree-head">
        ${canGoBack ? '<button type="button" class="tree-control-button" data-chart-back>Back</button>' : ""}
        <p><strong>${escape(root?.name || "")}</strong> at the centre; father's side on the left, mother's on the right. Select a person to re-centre.</p>
        <button type="button" class="tree-control-button" data-chart-open="${escape(rootId)}">Details</button>
      </div>
      <div class="fan-canvas">${fanSvg(ctx, { rootId, generations })}</div>`;
    const canvas = container.querySelector(".fan-canvas");
    if (canvas.scrollWidth > canvas.clientWidth) canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    const activate = (target) => {
      if (target.closest("[data-chart-back]")) { onBack?.(); return; }
      const open = target.closest("[data-chart-open]");
      if (open) { onOpen?.(open.dataset.chartOpen); return; }
      const wedge = target.closest("[data-chart-person]");
      if (!wedge) return;
      if (wedge.dataset.chartPerson === rootId) onOpen?.(rootId);
      else onReroot?.(wedge.dataset.chartPerson);
    };
    container.onclick = (event) => activate(event.target);
    container.onkeydown = (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.closest?.("[data-chart-person]")) {
        event.preventDefault();
        activate(event.target);
      }
    };
  }

  globalObject.familyTreeCharts = Object.freeze({
    ancestorSlots,
    fitLines,
    fanGeometry,
    fanSvg,
    renderFan,
    renderPedigree,
    defaultMeasure
  });
})(globalThis);
