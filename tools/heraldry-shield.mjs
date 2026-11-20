// Draws a shield from a structured reading of a printed blazon.
//
// A drawn shield is an illustration of what a source blazons, never a source itself,
// so the exhibit that carries it names the printed page and says it is drawn. Only
// what the renderer can draw faithfully is accepted: a coat it cannot draw is shown
// as its printed blazon instead, never approximated.

import { chargeArt } from "./heraldry-charges.mjs";

export const tinctures = Object.freeze({
  or: "#efc12f",
  argent: "#ffffff",
  gules: "#c4122f",
  azure: "#1f4f9e",
  sable: "#141414",
  vert: "#1c7a3c",
  purpure: "#6a2d87"
});

const WIDTH = 400;
const HEIGHT = 480;
const OUTLINE = "M20,20 H380 V250 C380,370 290,440 200,470 C110,440 20,370 20,250 Z";
const ORDINARIES = new Set(["chevron", "bend", "fess", "pale", "two-bars", "cross-patonce"]);
const CHARGES = new Set(["buckle", "mullet", "mascle", "crescent", "lozenge", "roundel", ...Object.keys(chargeArt)]);
const ARRANGEMENTS = new Set(["two-and-one", "on-ordinary", "centre", "in-chief", "in-cross", "three-three-one", "four-three-two-one"]);
// Arrangements that set out a fixed number of charges in rows: the count each takes.
const ROW_COUNTS = Object.freeze({ "three-three-one": 7, "four-three-two-one": 10 });
const FIXED_COUNTS = Object.freeze({ "in-cross": 5 });

const number = (value) => Math.round(value * 100) / 100;

export function validateShield(coat, label = "shield") {
  const issues = [];
  if (!coat || typeof coat !== "object" || Array.isArray(coat)) return [`${label}: must be an object`];
  const tincture = (value, where) => {
    if (!Object.hasOwn(tinctures, value)) issues.push(`${label}: unknown tincture ${value} in ${where}`);
  };
  if (coat.quarterly) {
    if (!Array.isArray(coat.quarterly) || coat.quarterly.length !== 4) issues.push(`${label}: quarterly takes four coats`);
    else coat.quarterly.forEach((item, index) => issues.push(...validateShield(item, `${label} quarter ${index + 1}`)));
  } else if (coat.impaled) {
    if (!Array.isArray(coat.impaled) || coat.impaled.length !== 2) issues.push(`${label}: impaled takes two coats`);
    else coat.impaled.forEach((item, index) => issues.push(...validateShield(item, `${label} ${index ? "sinister" : "dexter"}`)));
  } else {
    const field = coat.field;
    if (!field || typeof field !== "object") issues.push(`${label}: requires a field`);
    else if (field.fur) {
      if (field.fur !== "ermine") issues.push(`${label}: only ermine can be drawn as a fur`);
    } else if (field.paly) {
      if (!Number.isInteger(field.paly) || field.paly < 2 || field.paly > 12) issues.push(`${label}: paly takes 2 to 12 pieces`);
      if (!Array.isArray(field.tinctures) || field.tinctures.length !== 2) issues.push(`${label}: paly takes two tinctures`);
      else field.tinctures.forEach((value) => tincture(value, "paly"));
    } else if (field.gyronny) {
      if (field.gyronny !== 8) issues.push(`${label}: gyronny is drawn of eight pieces only`);
      if (!Array.isArray(field.tinctures) || field.tinctures.length !== 2) issues.push(`${label}: gyronny takes two tinctures`);
      else field.tinctures.forEach((value) => tincture(value, "gyronny"));
    } else if (field.tincture) tincture(field.tincture, "field");
    else issues.push(`${label}: field needs a tincture, a fur or paly`);
    if (coat.ordinary) {
      if (!ORDINARIES.has(coat.ordinary.type)) issues.push(`${label}: cannot draw ordinary ${coat.ordinary.type}`);
      tincture(coat.ordinary.tincture, "ordinary");
    }
    for (const charge of coat.charges || []) {
      for (const key of Object.keys(charge.charged || {})) if (!["type", "tincture", "at"].includes(key)) issues.push(`${label}: unknown key ${key} on a carried charge`);
      if (!CHARGES.has(charge.type)) issues.push(`${label}: cannot draw charge ${charge.type}`);
      tincture(charge.tincture, `charge ${charge.type}`);
      if (charge.charged) {
        if (charge.arrangement !== "centre") issues.push(`${label}: only a charge in the centre can carry another`);
        if (!CHARGES.has(charge.charged.type)) issues.push(`${label}: cannot draw charge ${charge.charged.type}`);
        tincture(charge.charged.tincture, `charge on the ${charge.type}`);
      }
      if (!ARRANGEMENTS.has(charge.arrangement)) issues.push(`${label}: unknown arrangement ${charge.arrangement}`);
      if (charge.arrangement === "on-ordinary" && !coat.ordinary) issues.push(`${label}: charges on an ordinary need the ordinary`);
      const wanted = ROW_COUNTS[charge.arrangement] ?? FIXED_COUNTS[charge.arrangement] ?? (charge.arrangement === "centre" ? null : 3);
      const single = charge.arrangement === "on-ordinary" && charge.count === 1;
      if (wanted !== null && !single && charge.count !== wanted) issues.push(`${label}: ${charge.arrangement} takes ${wanted === 3 ? "three" : wanted} charges`);
    }
  }
  if (coat.bordure) tincture(coat.bordure.tincture, "bordure");
  if (coat.label) tincture(coat.label.tincture, "label");
  if (coat.chief) {
    if (coat.chief.vair) {
      if (!Array.isArray(coat.chief.vair) || coat.chief.vair.length !== 2) issues.push(`${label}: a vair chief takes two tinctures`);
      else coat.chief.vair.forEach((value) => tincture(value, "chief vair"));
    } else tincture(coat.chief.tincture, "chief");
  }
  if (coat.canton) {
    if (coat.canton.fur) { if (coat.canton.fur !== "ermine") issues.push(`${label}: only an ermine canton can be drawn as a fur`); }
    else tincture(coat.canton.tincture, "canton");
  }
  if (coat.overall) {
    if (coat.overall.type !== "bendlet") issues.push(`${label}: cannot draw ${coat.overall.type} over all`);
    tincture(coat.overall.tincture, "over all");
  }
  if (coat.difference) {
    if (coat.difference.type !== "crescent") issues.push(`${label}: cannot draw difference ${coat.difference.type}`);
    tincture(coat.difference.tincture, "difference");
  }
  for (const key of Object.keys(coat)) {
    if (!["quarterly", "impaled", "field", "chief", "ordinary", "charges", "canton", "overall", "bordure", "label", "difference"].includes(key)) {
      issues.push(`${label}: unknown key ${key}`);
    }
  }
  return issues;
}

/** An SVG document for the coat. Throws on a coat validateShield rejects. */
export function renderShield(coat, { title } = {}) {
  const issues = validateShield(coat);
  if (issues.length) throw new Error(issues.join("; "));
  const label = title ? `<title>${escapeXml(title)}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT + 10}" role="img">${label}`
    + `<defs><clipPath id="shield"><path d="${OUTLINE}"/></clipPath></defs>`
    + `<g clip-path="url(#shield)">${drawCoat(coat, { x: 0, y: 0, width: WIDTH, height: HEIGHT }, "c")}</g>`
    + `<path d="${OUTLINE}" fill="none" stroke="#141414" stroke-width="5" stroke-linejoin="round"/></svg>`;
}

// Each coat is drawn in a 400 x 480 space and placed into its region, so a quarter
// or an impaled half is the whole coat in small, as an engraver would cut it.
function drawCoat(coat, region, id) {
  const sx = region.width / WIDTH;
  const sy = region.height / HEIGHT;
  const open = `<g transform="translate(${number(region.x)},${number(region.y)}) scale(${number(sx)},${number(sy)})">`;
  let body = "";
  if (coat.quarterly) {
    const half = { width: WIDTH / 2, height: 230 };
    const cells = [
      { x: 0, y: 0, ...half }, { x: WIDTH / 2, y: 0, ...half },
      { x: 0, y: 230, width: WIDTH / 2, height: HEIGHT - 230 }, { x: WIDTH / 2, y: 230, width: WIDTH / 2, height: HEIGHT - 230 }
    ];
    body = coat.quarterly.map((quarter, index) => clipped(drawCoat(quarter, cells[index], `${id}q${index}`), cells[index], `${id}q${index}`)).join("")
      + `<path d="M200,0 V${HEIGHT} M0,230 H${WIDTH}" stroke="#141414" stroke-width="2.5" fill="none"/>`;
  } else if (coat.impaled) {
    const cells = [{ x: 0, y: 0, width: WIDTH / 2, height: HEIGHT }, { x: WIDTH / 2, y: 0, width: WIDTH / 2, height: HEIGHT }];
    body = coat.impaled.map((half, index) => clipped(drawCoat(half, cells[index], `${id}i${index}`), cells[index], `${id}i${index}`)).join("")
      + `<path d="M200,0 V${HEIGHT}" stroke="#141414" stroke-width="2.5" fill="none"/>`;
  } else {
    // An impaled half is squeezed to half its width; its charges are drawn at an even
    // smaller size and their rows drawn together, so a roundel stays round.
    const squeeze = Math.abs(sx / sy - 1) > 0.1 ? sx / sy : 1;
    body = drawField(coat.field) + drawChief(coat.chief) + drawOrdinary(coat.ordinary)
      + (coat.charges || []).map((charge) => drawCharges(charge, coat, squeeze)).join("")
      + drawCanton(coat.canton) + drawOverall(coat.overall);
  }
  if (coat.bordure) {
    body += `<path d="${OUTLINE}" fill="none" stroke="${tinctures[coat.bordure.tincture]}" stroke-width="56"/>`
      + `<path d="M48,48 H352 V250 C352,352 276,414 200,440 C124,414 48,352 48,250 Z" fill="none" stroke="#141414" stroke-width="2"/>`;
  }
  if (coat.label) body += label(coat.label.tincture);
  if (coat.difference) body += `<g transform="translate(200,${coat.quarterly ? 230 : 96})">${crescent(coat.difference.tincture, 1.5)}</g>`;
  return `${open}${body}</g>`;
}

function clipped(markup, cell, id) {
  return `<clipPath id="${id}"><rect x="${cell.x}" y="${cell.y}" width="${cell.width}" height="${cell.height}"/></clipPath>`
    + `<g clip-path="url(#${id})">${markup}</g>`;
}

function drawField(field) {
  if (field.fur === "ermine") {
    let spots = "";
    for (let row = 0; row < 8; row += 1) {
      const offset = row % 2 ? 100 : 50;
      for (let x = offset; x < WIDTH; x += 100) spots += `<g transform="translate(${x},${48 + row * 58}) scale(1.9)">${ermineSpot()}</g>`;
    }
    return `<rect width="${WIDTH}" height="${HEIGHT}" fill="${tinctures.argent}"/><g fill="${tinctures.sable}">${spots}</g>`;
  }
  if (field.gyronny) {
    // Eight wedges meeting at the fess point, the first in the dexter chief.
    const centre = [200, 215];
    const corners = [[200, -10], [410, -10], [410, 215], [410, 490], [200, 490], [-10, 490], [-10, 215], [-10, -10]];
    return corners.map((point, index) => {
      const next = corners[(index + 1) % 8];
      return `<path d="M${centre} L${point} L${next} Z" fill="${tinctures[field.tinctures[(index + 1) % 2]]}"/>`;
    }).join("");
  }
  if (field.paly) {
    const stripe = WIDTH / field.paly;
    return Array.from({ length: field.paly }, (_, index) =>
      `<rect x="${number(index * stripe)}" y="0" width="${number(stripe + 0.5)}" height="${HEIGHT}" fill="${tinctures[field.tinctures[index % 2]]}"/>`).join("");
  }
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="${tinctures[field.tincture]}"/>`;
}

function drawOrdinary(ordinary) {
  if (!ordinary) return "";
  const fill = `fill="${tinctures[ordinary.tincture]}" stroke="#141414" stroke-width="2"`;
  if (ordinary.type === "chevron") return `<path d="M-10,330 L200,150 L410,330 L410,400 L200,222 L-10,400 Z" ${fill}/>`;
  if (ordinary.type === "bend") return `<path d="M-20,30 L50,-30 L420,410 L350,470 Z" ${fill}/>`;
  if (ordinary.type === "fess") return `<rect x="-10" y="170" width="420" height="96" ${fill}/>`;
  if (ordinary.type === "two-bars") return `<rect x="-10" y="150" width="420" height="58" ${fill}/><rect x="-10" y="274" width="420" height="58" ${fill}/>`;
  if (ordinary.type === "cross-patonce") return crossPatonce(ordinary.tincture);
  return `<rect x="152" y="-10" width="96" height="500" ${fill}/>`;
}

// Rows of charges, centred: for mascles the rows touch point to point (conjoined).
function rowPositions(rows, charge) {
  const mascled = ["mascle", "lozenge"].includes(charge.type);
  const across = mascled ? 64 : 76;
  const down = mascled ? 87 : 80;
  const top = 230 - ((rows.length - 1) * down) / 2;
  return rows.flatMap((count, row) => Array.from({ length: count }, (_, index) =>
    [200 + (index - (count - 1) / 2) * across, top + row * down]));
}

// The upper third of the shield, plain or vair (rows of bells of the two tinctures).
function drawChief(chief) {
  if (!chief) return "";
  const edge = `<path d="M-10,150 H410" stroke="#141414" stroke-width="2"/>`;
  if (!chief.vair) return `<rect x="-10" y="-10" width="420" height="160" fill="${tinctures[chief.tincture]}"/>${edge}`;
  const [ground, bells] = chief.vair.map((value) => tinctures[value]);
  let cells = "";
  for (let row = 0; row < 3; row += 1) {
    const y = row * 50;
    for (let x = row % 2 ? -25 : 0; x < WIDTH; x += 50) {
      cells += `<path d="M${x},${y + 50} V${y + 36} L${x + 12},${y + 26} V${y + 10} L${x + 25},${y} L${x + 38},${y + 10} V${y + 26} L${x + 50},${y + 36} V${y + 50} Z" fill="${bells}" stroke="#141414" stroke-width="0.8"/>`;
    }
  }
  return `<rect x="-10" y="-10" width="420" height="160" fill="${ground}"/><g>${cells}</g>${edge}`;
}

// A square in the dexter chief, plain or ermine, drawn over what lies beneath it.
function drawCanton(canton) {
  if (!canton) return "";
  const box = `<rect x="0" y="0" width="150" height="150" fill="${canton.fur ? tinctures.argent : tinctures[canton.tincture]}" stroke="#141414" stroke-width="2"/>`;
  if (!canton.fur) return box;
  let spots = "";
  for (const [x, y] of [[38, 36], [112, 36], [75, 90], [38, 126], [112, 126]]) spots += `<g transform="translate(${x},${y - 10}) scale(1.6)">${ermineSpot()}</g>`;
  return `${box}<g fill="${tinctures.sable}">${spots}</g>`;
}

function drawOverall(overall) {
  if (!overall) return "";
  return `<path d="M-20,8 L18,-24 L420,428 L382,460 Z" fill="${tinctures[overall.tincture]}" stroke="#141414" stroke-width="2"/>`;
}

// A cross whose arms widen to ends of three points, as patonce is drawn.
function crossPatonce(tincture) {
  const arm = [[-24, -24], [-50, -112], [-62, -146], [-28, -128], [0, -158], [28, -128], [62, -146], [50, -112], [24, -24]];
  const points = [0, 90, 180, 270].flatMap((angle) => {
    const radians = (angle * Math.PI) / 180;
    return arm.map(([x, y]) => [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)]);
  });
  const d = points.map(([x, y], index) => `${index ? "L" : "M"}${number(200 + x)},${number(205 + y)}`).join(" ");
  return `<path d="${d} Z" fill="${tinctures[tincture]}" stroke="#141414" stroke-width="2" stroke-linejoin="round"/>`;
}

function drawCharges(charge, coat, squeeze = 1) {
  const draw = chargeArt[charge.type] ? (value, scale) => artCharge(charge.type, value, scale)
    : { buckle, mullet, mascle, crescent, lozenge, roundel }[charge.type];
  const size = charge.arrangement === "centre" ? 2.2 : 1.5;
  if (charge.arrangement === "centre" && charge.charged) {
    const carried = chargeArt[charge.charged.type] ? (value, scale) => artCharge(charge.charged.type, value, scale)
      : { buckle, mullet, mascle, crescent, lozenge, roundel }[charge.charged.type];
    return `<g transform="translate(200,215)">${draw(charge.tincture, size)}<g transform="translate(${charge.charged.at?.[0] ?? 0},${charge.charged.at?.[1] ?? 0})">${carried(charge.charged.tincture, 0.6)}</g></g>`;
  }
  let positions = [[200, 215]];
  if (ROW_COUNTS[charge.arrangement]) {
    const rows = charge.arrangement === "three-three-one" ? [3, 3, 1] : [4, 3, 2, 1];
    const scale = ["mascle", "lozenge"].includes(charge.type) ? 1.45 : 1.5;
    // In a squeezed half the rows close up by the same factor, keeping conjoined charges touching.
    return rowPositions(rows, charge).map(([x, y]) =>
      `<g transform="translate(${number(x)},${number(230 + (y - 230) * squeeze)}) scale(1,${number(squeeze)})">${draw(charge.tincture, scale)}</g>`).join("");
  }
  if (charge.arrangement === "in-cross") {
    return [[200, 92], [92, 212], [200, 212], [308, 212], [200, 332]].map(([x, y]) =>
      `<g transform="translate(${x},${y})">${draw(charge.tincture, 0.9)}</g>`).join("");
  }
  if (charge.arrangement === "in-chief") {
    return [100, 200, 300].map((x) => `<g transform="translate(${x},78)">${draw(charge.tincture, 1.2)}</g>`).join("");
  }
  if (charge.arrangement === "on-ordinary" && charge.count === 1) {
    const [x, y] = coat.ordinary.type === "fess" ? [200, 218] : coat.ordinary.type === "pale" ? [200, 218] : [200, 215];
    return `<g transform="translate(${x},${y})">${draw(charge.tincture, 1.05)}</g>`;
  }
  if (charge.arrangement === "two-and-one") {
    positions = coat.ordinary?.type === "chevron" ? [[92, 110], [308, 110], [200, 350]] : [[100, 110], [300, 110], [200, 320]];
  } else if (charge.arrangement === "on-ordinary") {
    positions = coat.ordinary.type === "bend" ? [[92, 96], [200, 220], [308, 344]]
      : coat.ordinary.type === "fess" ? [[90, 218], [200, 218], [310, 218]]
        : coat.ordinary.type === "pale" ? [[200, 90], [200, 218], [200, 346]]
          : [[112, 290], [200, 208], [288, 290]];
  }
  const scale = charge.arrangement === "on-ordinary" ? 1.05 : size;
  // Charges on a bend lie along it.
  const turn = charge.arrangement === "on-ordinary" && coat.ordinary.type === "bend" ? " rotate(-40)" : "";
  return positions.map(([x, y]) => `<g transform="translate(${x},${y})${turn}">${draw(charge.tincture, scale)}</g>`).join("");
}

// A drawn charge (see heraldry-charges.mjs), its body in the tincture. Its lines are dark,
// or white on a sable charge so that they still show.
function artCharge(type, tincture, scale) {
  const line = tincture === "sable" ? "#ffffff" : "#141414";
  const fills = { body: tinctures[tincture], outline: line, light: "#ffffff", none: "none" };
  const factor = number(scale * 1.15);
  return `<g transform="scale(${factor})">${chargeArt[type].paths.map((path) =>
    `<path d="${path.d}" fill="${fills[path.fill]}"${path.stroke ? ` stroke="${line}" stroke-width="${number(Math.max(path.sw, 0.6))}"` : ""}/>`).join("")}</g>`;
}

// A label of three points across the chief, the mark of an eldest son.
function label(tincture) {
  const fill = `fill="${tinctures[tincture]}" stroke="#141414" stroke-width="2"`;
  const points = [120, 200, 280].map((x) => `<path d="M${x - 14},62 H${x + 14} L${x + 20},104 H${x - 20} Z" ${fill}/>`).join("");
  return `<rect x="70" y="48" width="260" height="16" ${fill}/>${points}`;
}

function ermineSpot() {
  return '<circle cx="0" cy="-4" r="2.6"/><circle cx="-5" cy="1" r="2.6"/><circle cx="5" cy="1" r="2.6"/>'
    + '<path d="M0,1 C-2,10 -7,18 -10,25 L-3.5,21 L0,29 L3.5,21 L10,25 C7,18 2,10 0,1 Z"/>';
}

function buckle(tincture, scale) {
  const colour = tinctures[tincture];
  return `<g transform="scale(${scale})"><path fill-rule="evenodd" fill="${colour}" d="M-24,-24 H24 V24 H-24 Z M-15,-15 V15 H15 V-15 Z"/>`
    + `<path d="M-19,0 H21" stroke="${colour}" stroke-width="5" stroke-linecap="round"/></g>`;
}

function mullet(tincture, scale) {
  const points = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 ? 11 : 28;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    return `${number(Math.cos(angle) * radius)},${number(Math.sin(angle) * radius)}`;
  }).join(" ");
  return `<polygon transform="scale(${scale})" points="${points}" fill="${tinctures[tincture]}" stroke="#141414" stroke-width="1"/>`;
}

function mascle(tincture, scale) {
  return `<path transform="scale(${scale})" fill-rule="evenodd" fill="${tinctures[tincture]}" stroke="#141414" stroke-width="1" d="M0,-30 L22,0 L0,30 L-22,0 Z M0,-17 L-12,0 L0,17 L12,0 Z"/>`;
}

function lozenge(tincture, scale) {
  return `<path transform="scale(${scale})" fill="${tinctures[tincture]}" stroke="#141414" stroke-width="1" d="M0,-30 L22,0 L0,30 L-22,0 Z"/>`;
}

function roundel(tincture, scale) {
  return `<circle r="${number(22 * scale)}" fill="${tinctures[tincture]}" stroke="#141414" stroke-width="1"/>`;
}

function crescent(tincture, scale) {
  const stroke = tincture === "sable" ? "#ffffff" : "#141414";
  return `<path transform="scale(${scale})" fill="${tinctures[tincture]}" stroke="${stroke}" stroke-width="1.4" d="M-24,-14 A25,25 0 1 0 24,-14 A27,27 0 0 1 -24,-14 Z"/>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
