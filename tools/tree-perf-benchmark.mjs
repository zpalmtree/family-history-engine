#!/usr/bin/env node

// Measures map interaction cost in Windows Chrome: wheel zoom, settle, and
// drag pan on the default and full views. Prints per-view frame-time
// percentiles plus Chrome's layout, style and script durations for each
// gesture so a performance change can be compared before and after.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

if (process.platform !== "win32") {
  console.error("tree-perf-benchmark must run with Windows Node/Chrome. Use tools/tree-perf-windows.ps1.");
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageRoot = process.env.TREE_PAGE_ROOT ? path.resolve(process.env.TREE_PAGE_ROOT) : projectRoot;
const chromePath = process.env.CHROME_PATH
  || path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
const views = process.argv.slice(2).length ? process.argv.slice(2) : ["default", "full"];
const pageUrl = pathToFileURL(path.join(pageRoot, "index.html")).href;

const browser = await chromium.launch({
  executablePath: chromePath,
  args: ["--mute-audio", ...(process.env.TREE_PERF_GPU ? ["--enable-gpu", "--use-angle=d3d11"] : [])],
  headless: true
});

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

const traceNames = {
  paintMs: ["Paint", "PaintImage"],
  rasterMs: ["RasterTask", "TileManager::FlushAndIssueSignals", "GPUTask"],
  compositeMs: ["UpdateLayerTree", "Layerize", "CompositeLayers", "Commit", "PrePaint"]
};

function summarizeTrace(buffer) {
  const events = JSON.parse(buffer.toString("utf8")).traceEvents || [];
  const totals = Object.fromEntries(Object.keys(traceNames).map((key) => [key, 0]));
  for (const event of events) {
    if (event.ph !== "X" || !event.dur) continue;
    for (const [key, names] of Object.entries(traceNames)) {
      if (names.includes(event.name)) totals[key] += event.dur / 1000;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Math.round(value)]));
}

async function measure(page, cdp, label, gesture) {
  await page.evaluate(() => {
    window.__frames = [];
    window.__longTasks = 0;
    let last = performance.now();
    window.__recording = true;
    const tick = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (window.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__longObserver?.disconnect();
    window.__longObserver = new PerformanceObserver((list) => { window.__longTasks += list.getEntries().length; });
    try { window.__longObserver.observe({ type: "longtask", buffered: false }); } catch {}
  });
  const before = await metrics(cdp);
  await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "cc", "gpu", "blink"] });
  const started = Date.now();
  await gesture();
  // Include the post-gesture settle work in the measurement.
  await page.waitForTimeout(450);
  const elapsed = Date.now() - started;
  const after = await metrics(cdp);
  const trace = summarizeTrace(await browser.stopTracing());
  const { frames, longTasks } = await page.evaluate(() => {
    window.__recording = false;
    return { frames: window.__frames.slice(1), longTasks: window.__longTasks };
  });
  const ms = (key) => Math.round(((after[key] || 0) - (before[key] || 0)) * 1000);
  return {
    gesture: label,
    elapsedMs: elapsed,
    frames: frames.length,
    p50: Math.round(percentile(frames, 0.5)),
    p95: Math.round(percentile(frames, 0.95)),
    max: Math.round(Math.max(0, ...frames)),
    longTasks,
    layoutMs: ms("LayoutDuration"),
    styleMs: ms("RecalcStyleDuration"),
    scriptMs: ms("ScriptDuration"),
    taskMs: ms("TaskDuration"),
    ...trace
  };
}

try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1040 }, deviceScaleFactor: Number(process.env.TREE_PERF_DPR || 1) });
  if (process.env.TREE_PERF_CSS) {
    // Optional experiment: inject extra CSS to compare paint variants.
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
      });
    }, process.env.TREE_PERF_CSS);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const results = [];
  for (const view of views) {
    await page.goto(view === "full" ? `${pageUrl}?chart=map&view=full` : `${pageUrl}?chart=map`, { waitUntil: "load" });
    if (view !== "default" && view !== "full") await page.click(`[data-tree-view="${view}"]`);
    await page.waitForTimeout(600);
    const nodes = await page.evaluate(() => document.querySelectorAll("#visual-tree .tree-node").length);
    const box = await page.locator("#visual-tree-viewport").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);

    const zoomOut = await measure(page, cdp, "wheel zoom out", async () => {
      for (let i = 0; i < 30; i += 1) { await page.mouse.wheel(0, 100); await page.waitForTimeout(16); }
    });
    if (process.env.TREE_PERF_SHOT_DIR) {
      await page.locator("#visual-tree-viewport").screenshot({ path: path.join(process.env.TREE_PERF_SHOT_DIR, `zoomed-out-${view}.png`) });
      // One capture per card tier, zoomed about the viewport centre.
      for (const target of [0.25, 0.4, 0.55, 0.9]) {
        for (let i = 0; i < 80; i += 1) {
          const scale = await page.evaluate(() => Number(document.querySelector("#visual-tree").dataset.scale));
          if (Math.abs(Math.log(scale / target)) < 0.04) break;
          await page.mouse.wheel(0, scale < target ? -30 : 30);
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(300);
        await page.locator("#visual-tree-viewport").screenshot({ path: path.join(process.env.TREE_PERF_SHOT_DIR, `tier-${view}-${target}.png`) });
      }
    }
    const zoomIn = await measure(page, cdp, "wheel zoom in", async () => {
      for (let i = 0; i < 30; i += 1) { await page.mouse.wheel(0, -100); await page.waitForTimeout(16); }
    });
    const pan = await measure(page, cdp, "drag pan", async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 40; i += 1) { await page.mouse.move(cx - i * 12, cy - i * 6); await page.waitForTimeout(16); }
      await page.mouse.up();
    });
    // Zoom in to card scale (about 100%), where full cards with text,
    // shadows and flags are painted, then measure pan and zoom there.
    for (let i = 0; i < 60; i += 1) {
      const scale = await page.evaluate(() => Number(document.querySelector("#visual-tree")?.dataset.scale || 0));
      if (scale >= 0.95) break;
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(500);
    const cardScale = await page.evaluate(() => Number(document.querySelector("#visual-tree")?.dataset.scale || 0));
    const cardPan = await measure(page, cdp, `drag pan @${cardScale.toFixed(2)}`, async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 40; i += 1) { await page.mouse.move(cx - i * 15, cy - i * 4); await page.waitForTimeout(16); }
      await page.mouse.up();
    });
    const cardZoom = await measure(page, cdp, `wheel zoom @${cardScale.toFixed(2)}`, async () => {
      for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, 100); await page.waitForTimeout(16); }
      for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, -100); await page.waitForTimeout(16); }
    });
    for (const row of [zoomOut, zoomIn, pan, cardPan, cardZoom]) results.push({ view, nodes, ...row });
  }
  console.table(results);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
