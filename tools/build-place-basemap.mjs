#!/usr/bin/env node
// Builds assets/place-basemap.js, the outline map the viewer's Places chart
// draws its ancestors' places on. The outlines come from Natural Earth
// (public domain) through the world-atlas 2.0.2 and us-atlas 3.0.1 TopoJSON
// packages (ISC): countries at 1:50m and United States state borders at 1:10m.
// The map carries no family data, so it ships as a static asset.
//
//   npm pack world-atlas@2.0.2 us-atlas@3.0.1   (in an empty scratch folder)
//   node tools/build-place-basemap.mjs --world <countries-50m.json> --states <states-10m.json>
//
// Coordinates are Web Mercator in a square world WORLD units wide, rounded to
// whole units (about 0.4 km at the equator, 0.25 km in England), and simplified
// with Douglas-Peucker at TOLERANCE units (COARSE_TOLERANCE away from the
// family's countries).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORLD = 100000;
const TOLERANCE = 1.2;
// Countries the family lived in keep fine outlines; the rest are context.
const COARSE_TOLERANCE = 5;
const FINE_COUNTRIES = new Set(["United Kingdom", "Ireland", "Germany", "Italy", "United States of America", "France", "Switzerland", "Austria", "Netherlands", "Belgium"]);
// The part of the world the family's places fall in, with room to pan:
// the American Midwest to Sicily, North Africa to Scandinavia.
export const REGION = { west: -128, east: 46, south: 14, north: 71 };

export function project(lon, lat) {
  const clamped = Math.max(-85, Math.min(85, lat));
  const x = ((lon + 180) / 360) * WORLD;
  const y = ((1 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / Math.PI) / 2) * WORLD;
  return [x, y];
}

function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

function arcPoints(arcs, index) {
  return index >= 0 ? arcs[index] : [...arcs[~index]].reverse();
}

function ring(arcs, indexes) {
  const points = [];
  for (const index of indexes) {
    const part = arcPoints(arcs, index);
    points.push(...(points.length ? part.slice(1) : part));
  }
  return points;
}

function polygons(geometry) {
  if (geometry.type === "Polygon") return [geometry.arcs];
  if (geometry.type === "MultiPolygon") return geometry.arcs;
  return [];
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let worst = -1;
    let worstDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const [px, py] = points[index];
      // A closed ring starts and ends on one point: measure from that point.
      const distance = length ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / length : Math.hypot(px - ax, py - ay);
      if (distance > worstDistance) { worstDistance = distance; worst = index; }
    }
    if (worst > 0 && worstDistance > tolerance) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

// Polygons are clipped (Sutherland-Hodgman) to the region plus a sliver, so
// the far parts of Canada, Russia and Greenland are not carried at all. The
// viewer never pans past the region, and the cut edges are left out of the
// outlines, so only real coasts and borders are drawn.
const CLIP = { west: REGION.west - 0.5, east: REGION.east + 0.5, south: REGION.south - 0.5, north: REGION.north + 0.5 };

function onClipEdge(a, b) {
  const near = (value, edge) => Math.abs(value - edge) < 1e-7;
  return (near(a[0], CLIP.west) && near(b[0], CLIP.west)) || (near(a[0], CLIP.east) && near(b[0], CLIP.east))
    || (near(a[1], CLIP.south) && near(b[1], CLIP.south)) || (near(a[1], CLIP.north) && near(b[1], CLIP.north));
}

// The clipped rings as open lines, broken wherever they run along the cut.
function outlineLines(rings) {
  const lines = [];
  for (const ring of rings) {
    let current = [];
    for (let index = 1; index < ring.length; index += 1) {
      if (onClipEdge(ring[index - 1], ring[index])) {
        if (current.length > 1) lines.push(current);
        current = [];
        continue;
      }
      if (!current.length) current.push(ring[index - 1]);
      current.push(ring[index]);
    }
    if (current.length > 1) lines.push(current);
  }
  return lines;
}

// A ring that crosses the date line (Russia's) jumps 360 degrees between
// neighbouring points; moving its western-hemisphere points east by 360 makes
// it continuous, and the clip then drops that far-eastern part.
function unwrap(lonLats) {
  const crosses = lonLats.some((point, index) => index && Math.abs(point[0] - lonLats[index - 1][0]) > 180);
  return crosses ? lonLats.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]) : lonLats;
}

function clipRing(ring) {
  const lonLats = unwrap(ring);
  const edges = [
    [(p) => p[0] >= CLIP.west, (a, b) => cross(a, b, 0, CLIP.west)],
    [(p) => p[0] <= CLIP.east, (a, b) => cross(a, b, 0, CLIP.east)],
    [(p) => p[1] >= CLIP.south, (a, b) => cross(a, b, 1, CLIP.south)],
    [(p) => p[1] <= CLIP.north, (a, b) => cross(a, b, 1, CLIP.north)]
  ];
  let output = lonLats;
  for (const [inside, intersect] of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(intersect(previous, current));
      }
    }
    if (!output.length) return [];
  }
  return output.length >= 3 ? [...output, output[0]] : [];
}

function cross(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return axis === 0 ? [value, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), value];
}

function insideClip([lon, lat]) {
  return lon >= CLIP.west && lon <= CLIP.east && lat >= CLIP.south && lat <= CLIP.north;
}

function pathData(lonLatRings, closed, tolerance = TOLERANCE) {
  const parts = [];
  for (const lonLats of lonLatRings) {
    const projected = simplify(lonLats.map(([lon, lat]) => project(lon, lat)), tolerance)
      .map(([x, y]) => [Math.round(x), Math.round(y)]);
    const deduped = projected.filter((point, index) => !index || point[0] !== projected[index - 1][0] || point[1] !== projected[index - 1][1]);
    if (deduped.length < (closed ? 4 : 2)) continue;
    let d = `M${deduped[0][0]} ${deduped[0][1]}`;
    for (let index = 1; index < deduped.length; index += 1) {
      d += `l${deduped[index][0] - deduped[index - 1][0]} ${deduped[index][1] - deduped[index - 1][1]}`;
    }
    parts.push(closed ? `${d}z` : d);
  }
  return parts.join("");
}

export function buildBasemap(world, states) {
  const worldArcs = decodeArcs(world);
  const countries = [];
  for (const geometry of world.objects.countries.geometries) {
    const rings = polygons(geometry).flatMap((polygon) => polygon.map((indexes) => clipRing(ring(worldArcs, indexes))))
      .filter((points) => points.length);
    if (!rings.length) continue;
    const tolerance = FINE_COUNTRIES.has(geometry.properties?.name) ? TOLERANCE : COARSE_TOLERANCE;
    const d = pathData(rings, true, tolerance);
    if (d) countries.push({ id: String(geometry.id ?? geometry.properties?.name), name: geometry.properties?.name || "", d,
      // Only a country cut by the region's edge needs separate coast lines.
      ...(rings.some((points) => points.some((point, index) => index && onClipEdge(points[index - 1], point)))
        ? { outline: pathData(outlineLines(rings), false, tolerance) } : {}) });
  }
  countries.sort((first, second) => first.name.localeCompare(second.name));

  // State borders: only the arcs two states share, so the coast is drawn once,
  // by the country outline.
  const stateArcs = decodeArcs(states);
  const uses = new Map();
  for (const geometry of states.objects.states.geometries) {
    for (const polygon of polygons(geometry)) {
      for (const indexes of polygon) {
        for (const index of indexes) {
          const arc = index >= 0 ? index : ~index;
          uses.set(arc, (uses.get(arc) || 0) + 1);
        }
      }
    }
  }
  const borderRings = [...uses].filter(([, count]) => count > 1).map(([arc]) => stateArcs[arc])
    .filter((points) => points.some(insideClip));
  const [west, north] = project(REGION.west, REGION.north);
  const [east, south] = project(REGION.east, REGION.south);
  return {
    schemaVersion: 1,
    projection: "web-mercator",
    world: WORLD,
    region: { ...REGION, x: Math.round(west), y: Math.round(north), width: Math.round(east - west), height: Math.round(south - north) },
    countries,
    stateBorders: pathData(borderRings, false)
  };
}

export function serializeBasemap(basemap) {
  return "/* Generated by tools/build-place-basemap.mjs from Natural Earth (public domain) via world-atlas and us-atlas (ISC). */\n"
    + `globalThis.familyPlaceBasemap = ${JSON.stringify(basemap)};\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name} <path>`);
    return process.argv[index + 1];
  };
  const world = JSON.parse(fs.readFileSync(option("--world"), "utf8"));
  const states = JSON.parse(fs.readFileSync(option("--states"), "utf8"));
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "place-basemap.js");
  const rendered = serializeBasemap(buildBasemap(world, states));
  fs.writeFileSync(target, rendered);
  console.log(`wrote ${path.relative(process.cwd(), target)} (${Math.round(rendered.length / 1024)} KB)`);
}
