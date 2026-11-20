(function exposeFamilyTreePlaces(globalObject) {
  "use strict";

  // The Places chart: where the people in the current view come from, drawn
  // on an outline map (assets/place-basemap.js). Like the pedigree and fan
  // charts it is given accessor-free plain data by the viewer:
  //
  // ctx = {
  //   basemap: globalThis.familyPlaceBasemap,
  //   people: [{ id, name, years, lineColor, lineLabel,
  //              places: [{ value, role, lat, lon, precision, label }] }]
  //   unmapped: number of people in the view with no mapped place
  // }
  // options = { focusId, viewKey, mode: "origin" | "all", onOpen(id), onMode(mode), onClearFocus() }
  //
  // Moving the map writes transforms only; markers are regrouped only when the
  // zoom crosses a step, so panning and zooming stay smooth.

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const SVG = "http://www.w3.org/2000/svg";

  const roleWords = {
    birthplace: "born",
    "baptism-place": "baptised",
    residence: "lived",
    "marriage-place": "married",
    "death-place": "died",
    "burial-place": "buried",
    associated: "recorded"
  };
  const roleOrder = ["birthplace", "baptism-place", "residence", "marriage-place", "associated", "death-place", "burial-place"];
  const preciseKinds = new Set(["locality"]);

  function project(world, lon, lat) {
    const clamped = Math.max(-85, Math.min(85, lat));
    return [
      ((lon + 180) / 360) * world,
      ((1 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / Math.PI) / 2) * world
    ];
  }

  // The one place a person is shown at when the map shows where people were
  // from: where they were born or baptised, otherwise the first recorded
  // locality, otherwise the first recorded place of any precision.
  function originPlace(person) {
    const places = (person.places || []).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon));
    return places.find((place) => place.role === "birthplace")
      || places.find((place) => place.role === "baptism-place")
      || places.find((place) => preciseKinds.has(place.precision))
      || places[0]
      || null;
  }

  // Places with the people shown at each. "origin" puts each person at one
  // place; "all" puts them at every mapped place they were recorded at.
  function collectPlaces(people, mode, world) {
    const byValue = new Map();
    for (const person of people) {
      const chosen = mode === "all"
        ? (person.places || []).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
        : [originPlace(person)].filter(Boolean);
      const seen = new Map();
      for (const place of chosen) {
        if (seen.has(place.value)) {
          const roles = seen.get(place.value).roles;
          if (!roles.includes(place.role)) roles.push(place.role);
          continue;
        }
        if (!byValue.has(place.value)) {
          const [x, y] = project(world, place.lon, place.lat);
          byValue.set(place.value, { value: place.value, label: place.label || place.value.split(",")[0], precision: place.precision || "locality", x, y, entries: [] });
        }
        const entry = { person, roles: [place.role] };
        seen.set(place.value, entry);
        byValue.get(place.value).entries.push(entry);
      }
    }
    return [...byValue.values()].sort((first, second) => second.entries.length - first.entries.length || first.value.localeCompare(second.value));
  }

  // Greedy grouping: the busiest place keeps its spot and takes in any place
  // whose marker would overlap its own by more than a fifth of their radii at
  // scale k (`gap` screen pixels widens that); groups that still overlap that
  // much after growing are merged. Markers may touch, so places separate
  // early as you zoom in. Deterministic for a given k.
  function clusterPlaces(places, k, gap) {
    const count = (cluster) => cluster.size;
    const touching = (first, second) => Math.hypot(first.x - second.x, first.y - second.y) * k
      < (markerRadius(count(first)) + markerRadius(count(second))) * MERGE_OVERLAP + gap;
    let clusters = [];
    for (const place of places) {
      const candidate = { x: place.x, y: place.y, places: [place], size: place.entries.length };
      const near = clusters.find((cluster) => touching(cluster, candidate));
      if (near) { near.places.push(place); near.size += place.entries.length; }
      else clusters.push(candidate);
    }
    for (let merged = true; merged;) {
      merged = false;
      for (let first = 0; first < clusters.length && !merged; first += 1) {
        for (let second = first + 1; second < clusters.length; second += 1) {
          if (!touching(clusters[first], clusters[second])) continue;
          clusters[first].places.push(...clusters[second].places);
          clusters[first].size += clusters[second].size;
          clusters.splice(second, 1);
          merged = true;
          break;
        }
      }
    }
    clusters = clusters.map((cluster) => {
      const people = new Map();
      for (const place of cluster.places) for (const entry of place.entries) people.set(entry.person.id, entry.person);
      return { x: cluster.x, y: cluster.y, places: cluster.places, people: [...people.values()], key: cluster.places.map((place) => place.value).sort().join(" | ") };
    });
    return clusters;
  }

  // Share of each family line among a group's people, largest first.
  function lineShares(people) {
    const counts = new Map();
    for (const person of people) {
      const key = person.lineColor || "var(--line-core)";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort((first, second) => second[1] - first[1] || String(first[0]).localeCompare(String(second[0])));
  }

  const MERGE_OVERLAP = 0.8;
  function markerRadius(count) {
    return Math.min(17, 4 + 1.6 * Math.sqrt(count));
  }

  function pieSvg(people, radius) {
    const shares = lineShares(people);
    if (shares.length === 1) return `<circle r="${radius}" style="fill:${shares[0][0]}"></circle>`;
    const total = people.length;
    let angle = -Math.PI / 2;
    return shares.map(([color, count]) => {
      const sweep = (count / total) * Math.PI * 2;
      const start = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      angle += sweep;
      const end = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      const large = sweep > Math.PI ? 1 : 0;
      return `<path d="M0 0L${start[0].toFixed(2)} ${start[1].toFixed(2)}A${radius} ${radius} 0 ${large} 1 ${end[0].toFixed(2)} ${end[1].toFixed(2)}z" style="fill:${color}"></path>`;
    }).join("");
  }

  // The first year in a person's dates ("b. c. 1691", "1610–c. 1676"), for
  // listing people oldest first; undated people go last.
  function firstYear(person) {
    const match = String(person.years || "").match(/\d{3,4}/);
    return match ? Number(match[0]) : 9999;
  }

  function fitPoints(points, width, height, padding, kMin, kMax) {
    if (!points.length) return null;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const usableW = Math.max(40, width - padding * 2);
    const usableH = Math.max(40, height - padding * 2);
    const k = Math.max(kMin, Math.min(kMax, Math.min(usableW / Math.max(1, maxX - minX), usableH / Math.max(1, maxY - minY))));
    return { k, tx: width / 2 - ((minX + maxX) / 2) * k, ty: height / 2 - ((minY + maxY) / 2) * k };
  }

  // View state survives re-renders (resizes, a drawer opening) per view.
  const memory = new Map();

  function renderPlaces(host, ctx, options = {}) {
    const basemap = ctx.basemap;
    host.querySelector(".places-chart")?._placesTeardown?.();
    if (!basemap) {
      host.innerHTML = `<div class="places-chart"><p class="places-empty">The outline map did not load.</p></div>`;
      return;
    }
    const world = basemap.world;
    const region = basemap.region;
    const mode = options.mode === "all" ? "all" : "origin";
    const focus = options.focusId ? ctx.people.find((person) => person.id === options.focusId) : null;
    const people = focus ? [focus] : ctx.people;
    const places = collectPlaces(people, focus ? "all" : mode, world);
    const personCount = new Set(places.flatMap((place) => place.entries.map((entry) => entry.person.id))).size;
    const countries = new Set(places.map((place) => place.value.split(",").at(-1).trim()));

    const headline = focus
      ? `<p><strong>${escape(focus.name)}</strong>: ${places.length ? `${places.length} recorded ${places.length === 1 ? "place" : "places"}` : "no place on record yet"}.</p>
         <button type="button" class="places-head-button" data-places-clear>Show everyone</button>`
      : `<p><strong>${personCount}</strong> ${personCount === 1 ? "person" : "people"} at <strong>${places.length}</strong> ${places.length === 1 ? "place" : "places"} in ${countries.size} ${countries.size === 1 ? "country" : "countries"}${ctx.unmapped ? `; ${ctx.unmapped} with no place on record yet` : ""}.</p>
         <div class="places-mode" role="group" aria-label="Which places">
           <button type="button" data-places-mode="origin" aria-pressed="${mode === "origin"}" title="Each person once, where they were born or baptised (otherwise the first place they are recorded)">Where born</button>
           <button type="button" data-places-mode="all" aria-pressed="${mode === "all"}" title="Every place each person is recorded at">All places</button>
         </div>`;

    host.innerHTML = `<div class="places-chart">
      <div class="places-head">${headline}</div>
      <div class="places-stage" tabindex="0" role="application" aria-label="Map of places. Drag or use the arrow keys to move, scroll or press + and − to zoom.">
        <svg class="places-svg" xmlns="${SVG}" aria-hidden="true">
          <g class="places-base">
            <rect class="places-sea" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}"></rect>
            ${basemap.countries.map((country) => `<path class="places-land${country.outline ? "" : " coast"}" d="${country.d}"></path>${country.outline ? `<path class="places-coast" d="${country.outline}"></path>` : ""}`).join("")}
            <path class="places-states" d="${basemap.stateBorders}"></path>
          </g>
          <g class="places-markers"></g>
        </svg>
        <div class="places-labels" aria-hidden="true"></div>
        <div class="places-zoom" role="group" aria-label="Map zoom">
          <button type="button" data-places-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-places-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-places-zoom="fit" title="Show every place">All</button>
        </div>
        <p class="places-note">Outlines: Natural Earth. Dashed rings are places known only to a county, state or country.</p>
        <section class="places-panel" hidden aria-live="polite"></section>
      </div>
      <ul class="visually-hidden places-list" aria-label="Places on the map">
        ${places.map((place) => `<li><button type="button" data-places-open="${escape(place.value)}">${escape(place.value)}: ${place.entries.length} ${place.entries.length === 1 ? "person" : "people"}</button></li>`).join("")}
      </ul>
    </div>`;

    const chart = host.querySelector(".places-chart");
    const stage = chart.querySelector(".places-stage");
    const svg = chart.querySelector(".places-svg");
    const base = chart.querySelector(".places-base");
    const markerLayer = chart.querySelector(".places-markers");
    const labelLayer = chart.querySelector(".places-labels");
    const panel = chart.querySelector(".places-panel");
    const reduceMotion = globalObject.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    let width = stage.clientWidth || 800;
    let height = stage.clientHeight || 500;
    // At the widest the whole region fits on screen (a framed rectangle on a
    // tall phone); the view never pans away from it.
    const kMinFor = () => Math.min(width / region.width, height / region.height);
    const kMax = 16;
    const memoryKey = `${options.viewKey || ""}|${focus ? `focus:${focus.id}` : mode}`;
    let view = memory.get(memoryKey) || null;
    const fitAll = () => fitPoints(places, width, height, Math.min(70, Math.max(28, width * 0.08)), kMinFor(), focus ? (places.length > 1 ? 2 : 0.45) : 1.6)
      || fitPoints([{ x: region.x, y: region.y }, { x: region.x + region.width, y: region.y + region.height }], width, height, 10, kMinFor(), kMax);
    if (!view) view = fitAll();
    else if (view.width && view.height) {
      // Keep the same centre after a resize.
      const cx = (view.width / 2 - view.tx) / view.k;
      const cy = (view.height / 2 - view.ty) / view.k;
      view = { k: view.k, tx: width / 2 - cx * view.k, ty: height / 2 - cy * view.k };
    }

    let clusters = [];
    let clusterStep = null;
    let selectedKey = null;
    let markerNodes = new Map();
    let countNodes = new Map();

    function clamp() {
      view.k = Math.max(kMinFor(), Math.min(kMax, view.k));
      // Along an axis where the region is smaller than the screen it is
      // centred; otherwise its edges may not come inside the screen's.
      const fit = (offset, start, size, screen) => size * view.k <= screen
        ? (screen - size * view.k) / 2 - start * view.k
        : Math.min(-start * view.k, Math.max(screen - (start + size) * view.k, offset));
      view.tx = fit(view.tx, region.x, region.width, width);
      view.ty = fit(view.ty, region.y, region.height, height);
    }

    function rebuildMarkers() {
      const step = Math.round(Math.log(view.k) / Math.log(1.3));
      if (step === clusterStep) return false;
      clusterStep = step;
      const k = Math.pow(1.3, step);
      clusters = clusterPlaces(places, k, 0);
      markerNodes = new Map();
      countNodes = new Map();
      markerLayer.textContent = "";
      const fragment = [];
      // Counts go in a layer above every marker, so a touching marker never
      // covers another's number.
      const counts = [];
      // Bigger markers first, so a touching smaller one stays on top.
      for (const cluster of [...clusters].sort((first, second) => second.people.length - first.people.length)) {
        const count = cluster.people.length;
        const radius = markerRadius(count);
        const vague = cluster.places.every((place) => !preciseKinds.has(place.precision));
        const label = cluster.places.length === 1 ? cluster.places[0].value : `${cluster.places[0].label} and ${cluster.places.length - 1} more ${cluster.places.length === 2 ? "place" : "places"}`;
        fragment.push(`<g class="places-marker${vague ? " vague" : ""}${focus ? " focused" : ""}" data-places-key="${escape(cluster.key)}">
          <title>${escape(label)}: ${count} ${count === 1 ? "person" : "people"}</title>
          <circle class="places-halo" r="${radius + 2.5}"></circle>
          ${pieSvg(cluster.people, radius)}
        </g>`);
        if (count > 1 && radius >= 8.5) counts.push(`<text class="places-count" dy="0.35em" data-places-count="${escape(cluster.key)}">${count}</text>`);
      }
      markerLayer.innerHTML = `${fragment.join("")}<g class="places-counts">${counts.join("")}</g>`;
      for (const node of markerLayer.querySelectorAll(".places-marker")) markerNodes.set(node.dataset.placesKey, node);
      for (const node of markerLayer.querySelectorAll("[data-places-count]")) countNodes.set(node.dataset.placesCount, node);
      if (selectedKey && !markerNodes.has(selectedKey)) {
        // The selected group was merged or split by the zoom: keep the panel
        // and mark whichever group now holds its first place.
        const first = selectedKey.split(" | ")[0];
        selectedKey = clusters.find((cluster) => cluster.places.some((place) => place.value === first))?.key || null;
      }
      markerNodes.get(selectedKey)?.classList.add("selected");
      return true;
    }

    function placeMarkers() {
      markerK = view.k;
      for (const cluster of clusters) {
        const node = markerNodes.get(cluster.key);
        const transform = `translate(${(cluster.x * view.k).toFixed(1)} ${(cluster.y * view.k).toFixed(1)})`;
        if (node) node.setAttribute("transform", transform);
        countNodes.get(cluster.key)?.setAttribute("transform", transform);
      }
    }

    // Labels: busiest groups first, each placed only where it overlaps no
    // earlier label or marker. Done when the map comes to rest.
    function placeLabels() {
      const taken = clusters.map((cluster) => {
        const r = markerRadius(cluster.people.length);
        const x = cluster.x * view.k + view.tx; const y = cluster.y * view.k + view.ty;
        return { left: x - r, right: x + r, top: y - r, bottom: y + r };
      });
      const parts = [];
      const ordered = [...clusters].sort((first, second) => second.people.length - first.people.length);
      const limit = width < 520 ? 10 : 24;
      for (const cluster of ordered) {
        if (parts.length >= limit) break;
        const x = cluster.x * view.k + view.tx; const y = cluster.y * view.k + view.ty;
        if (x < 0 || y < 0 || x > width || y > height) continue;
        const r = markerRadius(cluster.people.length);
        const text = cluster.places.length === 1 ? cluster.places[0].label : `${cluster.places[0].label} +${cluster.places.length - 1}`;
        const textWidth = text.length * 6.6 + 8;
        const box = { left: x + r + 3, right: x + r + 3 + textWidth, top: y - 9, bottom: y + 9 };
        if (box.right > width - 4) { box.right = x - r - 3; box.left = box.right - textWidth; }
        if (box.left < 4 || box.bottom > height - 4 || box.top < 4) continue;
        if (taken.some((other) => other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top)) continue;
        taken.push(box);
        parts.push(`<span class="places-label" style="transform:translate(${Math.round(box.left)}px,${Math.round(box.top)}px)">${escape(text)}</span>`);
      }
      labelLayer.innerHTML = parts.join("");
    }

    let restTimer = 0;
    let moving = false;
    let labelView = { k: 0, tx: 0, ty: 0 };
    let markerK = 0;
    function apply({ rest = true } = {}) {
      clamp();
      base.setAttribute("transform", `translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)}) scale(${view.k})`);
      markerLayer.setAttribute("transform", `translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)})`);
      memory.set(memoryKey, { ...view, width, height });
      if (!rest) {
        // Labels were placed for the last resting view: a pan carries them
        // along; a zoom hides them until the map comes to rest.
        if (Math.abs(view.k - labelView.k) < 1e-9) {
          labelLayer.style.transform = `translate(${(view.tx - labelView.tx).toFixed(1)}px,${(view.ty - labelView.ty).toFixed(1)}px)`;
        } else if (!moving) {
          moving = true;
          labelLayer.classList.add("moving");
        }
        if (rebuildMarkers()) placeMarkers();
        else if (Math.abs(view.k - markerK) > 1e-9) placeMarkers();
        clearTimeout(restTimer);
        restTimer = setTimeout(() => apply(), 140);
        return;
      }
      moving = false;
      labelLayer.classList.remove("moving");
      labelLayer.style.transform = "";
      rebuildMarkers();
      placeMarkers();
      placeLabels();
      labelView = { ...view };
      updateZoomButtons();
    }

    function zoomAbout(factor, px, py, opts) {
      const next = Math.max(kMinFor(), Math.min(kMax, view.k * factor));
      const ratio = next / view.k;
      view.tx = px - (px - view.tx) * ratio;
      view.ty = py - (py - view.ty) * ratio;
      view.k = next;
      apply(opts);
    }

    let glide = 0;
    function glideTo(target) {
      cancelAnimationFrame(glide);
      if (reduceMotion || !target) { if (target) Object.assign(view, target); apply(); return; }
      const from = { ...view };
      const start = performance.now();
      const duration = 320;
      const frame = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        // Interpolate the scale geometrically and the screen centre linearly.
        const k = from.k * Math.pow(target.k / from.k, ease);
        const fromCx = (width / 2 - from.tx) / from.k; const fromCy = (height / 2 - from.ty) / from.k;
        const toCx = (width / 2 - target.tx) / target.k; const toCy = (height / 2 - target.ty) / target.k;
        const cx = fromCx + (toCx - fromCx) * ease; const cy = fromCy + (toCy - fromCy) * ease;
        view.k = k; view.tx = width / 2 - cx * k; view.ty = height / 2 - cy * k;
        if (t < 1) { apply({ rest: false }); glide = requestAnimationFrame(frame); } else apply();
      };
      glide = requestAnimationFrame(frame);
    }

    function updateZoomButtons() {
      chart.querySelector('[data-places-zoom="in"]').disabled = view.k >= kMax * 0.999;
      chart.querySelector('[data-places-zoom="out"]').disabled = view.k <= kMinFor() * 1.001;
    }

    function roleText(roles) {
      return [...roles].sort((first, second) => roleOrder.indexOf(first) - roleOrder.indexOf(second)).map((role) => roleWords[role] || "recorded").join(", ");
    }

    function showPanel(cluster) {
      selectedKey = cluster.key;
      markerLayer.querySelectorAll(".places-marker.selected").forEach((node) => node.classList.remove("selected"));
      markerNodes.get(cluster.key)?.classList.add("selected");
      const sections = cluster.places.map((place) => {
        const entries = [...place.entries].sort((first, second) => firstYear(first.person) - firstYear(second.person) || first.person.name.localeCompare(second.person.name));
        return `<h3>${escape(place.value)}${place.precision !== "locality" ? ` <span class="places-vague">somewhere in this ${escape(place.precision)}</span>` : ""}</h3>
          <ul>${entries.map((entry) => `<li><button type="button" class="places-person" data-places-person="${escape(entry.person.id)}">
            <span class="places-swatch" style="background:${entry.person.lineColor || "var(--line-core)"}"></span>
            <span class="places-person-name">${escape(entry.person.name)}</span>
            <span class="places-person-meta">${escape([entry.person.years, roleText(entry.roles)].filter(Boolean).join(" · "))}</span>
          </button></li>`).join("")}</ul>`;
      }).join("");
      panel.innerHTML = `<header><h2>${cluster.places.length === 1 ? escape(cluster.places[0].label) : `${cluster.places.length} places`}</h2>
        <span>${cluster.people.length} ${cluster.people.length === 1 ? "person" : "people"}</span>
        <button type="button" class="places-panel-close" data-places-close aria-label="Close">×</button></header>
        <div class="places-panel-body">${sections}</div>`;
      panel.hidden = false;
    }

    function closePanel() {
      panel.hidden = true;
      selectedKey = null;
      markerLayer.querySelectorAll(".places-marker.selected").forEach((node) => node.classList.remove("selected"));
    }

    function activateCluster(cluster) {
      if (cluster.places.length > 1 && view.k < kMax * 0.98) {
        // A group of nearby places opens out by zooming in on it; once it
        // can open no further, a tap lists who was there.
        const target = fitPoints(cluster.places, width, height, Math.min(90, width * 0.18), kMinFor(), kMax);
        if (target && target.k > view.k * 1.2) { closePanel(); glideTo(target); return; }
      }
      showPanel(cluster);
    }

    // ----- pointer, wheel and keys -----
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let stageBox = stage.getBoundingClientRect();
    const local = (event) => [event.clientX - stageBox.left, event.clientY - stageBox.top];

    function onPointerDown(event) {
      if (event.target.closest(".places-panel, .places-zoom, .places-note")) return;
      if (event.button !== undefined && event.button !== 0 && event.pointerType === "mouse") return;
      stageBox = stage.getBoundingClientRect();
      cancelAnimationFrame(glide);
      pointers.set(event.pointerId, local(event));
      try { stage.setPointerCapture?.(event.pointerId); } catch {}
      if (pointers.size === 1) {
        const [x, y] = local(event);
        drag = { x, y, tx: view.tx, ty: view.ty, moved: false, target: event.target.closest(".places-marker") };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k: view.k, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, tx: view.tx, ty: view.ty };
        drag = null;
      }
    }
    function onPointerMove(event) {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, local(event));
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
        const cx = (a[0] + b[0]) / 2; const cy = (a[1] + b[1]) / 2;
        const k = Math.max(kMinFor(), Math.min(kMax, pinch.k * (distance / pinch.distance)));
        const wx = (pinch.cx - pinch.tx) / pinch.k; const wy = (pinch.cy - pinch.ty) / pinch.k;
        view.k = k; view.tx = cx - wx * k; view.ty = cy - wy * k;
        apply({ rest: false });
        return;
      }
      if (!drag) return;
      const [x, y] = local(event);
      if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 6) return;
      drag.moved = true;
      stage.classList.add("dragging");
      view.tx = drag.tx + (x - drag.x);
      view.ty = drag.ty + (y - drag.y);
      apply({ rest: false });
    }
    function onPointerUp(event) {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      stage.classList.remove("dragging");
      if (pinch) { if (pointers.size < 2) pinch = null; apply(); drag = null; return; }
      if (drag && !drag.moved && drag.target) {
        const cluster = clusters.find((item) => item.key === drag.target.dataset.placesKey);
        if (cluster) activateCluster(cluster);
      } else if (drag?.moved) apply();
      drag = null;
    }
    function onWheel(event) {
      event.preventDefault();
      cancelAnimationFrame(glide);
      stageBox = stage.getBoundingClientRect();
      const [x, y] = local(event);
      if (event.shiftKey && !event.ctrlKey) {
        view.tx -= event.deltaY || event.deltaX;
        apply({ rest: false });
        return;
      }
      const pixels = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * height : event.deltaY;
      // About x1.09 for a wheel notch (100px); a trackpad pinch at its own pace.
      const rate = event.ctrlKey ? 0.01 : 0.00086;
      const factor = Math.exp(Math.max(-0.13, Math.min(0.13, -pixels * rate)));
      zoomAbout(factor, x, y, { rest: false });
    }
    function onDoubleClick(event) {
      if (event.target.closest(".places-marker, .places-panel, .places-zoom")) return;
      stageBox = stage.getBoundingClientRect();
      const [x, y] = local(event);
      const factor = event.shiftKey ? 0.5 : 2;
      const k = Math.max(kMinFor(), Math.min(kMax, view.k * factor));
      glideTo({ k, tx: x - (x - view.tx) * (k / view.k), ty: y - (y - view.ty) * (k / view.k) });
    }
    function onKey(event) {
      if (event.target !== stage) return;
      const step = event.shiftKey ? Math.round(width / 2) : 80;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) {
        event.preventDefault();
        view.tx += moves[event.key][0]; view.ty += moves[event.key][1];
        apply();
      } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomButton("in"); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomButton("out"); }
      else if (event.key === "0") { event.preventDefault(); glideTo(fitAll()); }
      else if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); closePanel(); }
    }
    function zoomButton(direction) {
      if (direction === "fit") { glideTo(fitAll()); return; }
      const factor = direction === "in" ? 1.6 : 1 / 1.6;
      const k = Math.max(kMinFor(), Math.min(kMax, view.k * factor));
      glideTo({ k, tx: width / 2 - (width / 2 - view.tx) * (k / view.k), ty: height / 2 - (height / 2 - view.ty) * (k / view.k) });
    }
    function onClick(event) {
      const zoom = event.target.closest("[data-places-zoom]");
      if (zoom) { zoomButton(zoom.dataset.placesZoom); return; }
      const modeButton = event.target.closest("[data-places-mode]");
      if (modeButton) { if (modeButton.dataset.placesMode !== mode) options.onMode?.(modeButton.dataset.placesMode); return; }
      if (event.target.closest("[data-places-clear]")) { options.onClearFocus?.(); return; }
      if (event.target.closest("[data-places-close]")) { closePanel(); stage.focus({ preventScroll: true }); return; }
      const personButton = event.target.closest("[data-places-person]");
      if (personButton) { options.onOpen?.(personButton.dataset.placesPerson); return; }
      const listButton = event.target.closest("[data-places-open]");
      if (listButton) {
        const cluster = clusters.find((item) => item.places.some((place) => place.value === listButton.dataset.placesOpen));
        if (cluster) {
          const place = cluster.places.find((item) => item.value === listButton.dataset.placesOpen);
          glideTo({ k: Math.max(view.k, 1.5), tx: width / 2 - place.x * Math.max(view.k, 1.5), ty: height / 2 - place.y * Math.max(view.k, 1.5) });
          showPanel(cluster);
        }
      }
    }

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("dblclick", onDoubleClick);
    stage.addEventListener("keydown", onKey);
    chart.addEventListener("click", onClick);
    const resize = new (globalObject.ResizeObserver || class { observe() {} disconnect() {} })(() => {
      const nextWidth = stage.clientWidth; const nextHeight = stage.clientHeight;
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return;
      const cx = (width / 2 - view.tx) / view.k; const cy = (height / 2 - view.ty) / view.k;
      width = nextWidth; height = nextHeight;
      view.tx = width / 2 - cx * view.k; view.ty = height / 2 - cy * view.k;
      stageBox = stage.getBoundingClientRect();
      apply();
    });
    resize.observe(stage);
    chart._placesTeardown = () => { resize.disconnect(); cancelAnimationFrame(glide); clearTimeout(restTimer); };

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    apply();
    if (focus && clusters.length === 1) showPanel(clusters[0]);
  }

  globalObject.familyTreePlaces = { renderPlaces, collectPlaces, clusterPlaces, markerRadius, originPlace, lineShares, fitPoints, firstYear, project };
})(globalThis);
