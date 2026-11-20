// Draws a shield from a structured reading of a printed blazon.
//
// A drawn shield is an illustration of what a source blazons, never a source itself,
// so the exhibit that carries it names the printed page and says it is drawn. Only
// what the renderer can draw faithfully is accepted: a coat it cannot draw is shown
// as its printed blazon instead, never approximated.

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
const ORDINARIES = new Set(["chevron", "bend", "fess", "pale"]);
const CHARGES = new Set(["buckle", "mullet", "mascle", "crescent", "lozenge", "roundel"]);
const ARRANGEMENTS = new Set(["two-and-one", "on-ordinary", "centre"]);

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
    } else if (field.tincture) tincture(field.tincture, "field");
    else issues.push(`${label}: field needs a tincture, a fur or paly`);
    if (coat.ordinary) {
      if (!ORDINARIES.has(coat.ordinary.type)) issues.push(`${label}: cannot draw ordinary ${coat.ordinary.type}`);
      tincture(coat.ordinary.tincture, "ordinary");
    }
    for (const charge of coat.charges || []) {
      if (!CHARGES.has(charge.type)) issues.push(`${label}: cannot draw charge ${charge.type}`);
      tincture(charge.tincture, `charge ${charge.type}`);
      if (!ARRANGEMENTS.has(charge.arrangement)) issues.push(`${label}: unknown arrangement ${charge.arrangement}`);
      if (charge.arrangement === "on-ordinary" && !coat.ordinary) issues.push(`${label}: charges on an ordinary need the ordinary`);
      if (charge.arrangement !== "centre" && charge.count !== 3) issues.push(`${label}: ${charge.arrangement} takes three charges`);
    }
  }
  if (coat.bordure) tincture(coat.bordure.tincture, "bordure");
  if (coat.difference) {
    if (coat.difference.type !== "crescent") issues.push(`${label}: cannot draw difference ${coat.difference.type}`);
    tincture(coat.difference.tincture, "difference");
  }
  for (const key of Object.keys(coat)) {
    if (!["quarterly", "impaled", "field", "ordinary", "charges", "bordure", "difference"].includes(key)) {
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
    body = drawField(coat.field) + drawOrdinary(coat.ordinary) + (coat.charges || []).map((charge) => drawCharges(charge, coat)).join("");
  }
  if (coat.bordure) {
    body += `<path d="${OUTLINE}" fill="none" stroke="${tinctures[coat.bordure.tincture]}" stroke-width="56"/>`
      + `<path d="M48,48 H352 V250 C352,352 276,414 200,440 C124,414 48,352 48,250 Z" fill="none" stroke="#141414" stroke-width="2"/>`;
  }
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
  return `<rect x="152" y="-10" width="96" height="500" ${fill}/>`;
}

function drawCharges(charge, coat) {
  const draw = { buckle, mullet, mascle, crescent, lozenge, roundel }[charge.type];
  const size = charge.arrangement === "centre" ? 2.2 : 1.5;
  let positions = [[200, 215]];
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
