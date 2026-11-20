// Visible viewer metadata only: no image, transcript, input or navigation actions.
export function assertFamilySearchImageUrl(value, expected = value) {
  const url = new URL(value);
  const target = new URL(expected);
  if (url.protocol !== "https:" || url.hostname !== "www.familysearch.org"
      || url.port || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some((key) => !["wc", "owc", "i", "cc", "groupId", "lang"].includes(key))
      || !/^\/ark:\/61903\/3:1:[A-Z0-9-]+\/?$/i.test(url.pathname)
      || url.pathname !== target.pathname) {
    throw new Error("FamilySearch viewer metadata requires the unchanged exact image ARK, without a transcript view.");
  }
  return url;
}

export async function readFamilySearchViewerMetadata(page, expected) {
  assertFamilySearchImageUrl(page.url(), expected);
  const snapshot = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const safeUrl = (value) => {
      try {
        const url = new URL(value, location.href);
        if (url.protocol !== "https:" || url.hostname !== "www.familysearch.org" || url.port || url.hash || url.username || url.password) return null;
        const safe = new URL(`${url.origin}${url.pathname}`);
        for (const key of ["wc", "owc", "i", "cc", "groupId", "lang"]) {
          for (const value of url.searchParams.getAll(key)) if (value.length <= 500) safe.searchParams.append(key, value);
        }
        return safe.href;
      } catch { return null; }
    };
    const gate = [...document.querySelectorAll('input[type="password"], iframe[src*="captcha" i], [class*="captcha" i]')].some(visible);
    if (gate) return { gate: true };
    const inputs = [...document.querySelectorAll('input[aria-label="Enter Image number" i]')]
      .filter(visible).filter((input) => ["number", "text"].includes(input.type)
        && !input.closest('form[action*="signin" i], form[action*="login" i]'));
    let ordinal = null;
    let total = null;
    if (inputs.length === 1) {
      const value = clean(inputs[0].value);
      if (/^\d+$/.test(value)) ordinal = Number(value);
      let parent = inputs[0].parentElement;
      for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
        const text = clean(parent.innerText);
        if (text.length > 250) break;
        const matches = [...text.matchAll(/\bof\s+([\d,]+)\b/gi)];
        if (matches.length === 1) { total = Number(matches[0][1].replaceAll(",", "")); break; }
      }
    }
    const controls = [...document.querySelectorAll('main button, main [role="button"], main a[href]')].filter(visible);
    const navigation = controls.flatMap((element) => {
      const label = clean(element.getAttribute("aria-label") || element.innerText);
      if (!/^(?:Previous|Next) Image$/i.test(label)) return [];
      const rawHref = element.getAttribute("href");
      const href = rawHref ? safeUrl(rawHref) : null;
      const nativeImage = href && /^\/ark:\/61903\/3:1:[A-Z0-9-]+\/?$/i.test(new URL(href).pathname)
        && [...new URL(rawHref, location.href).searchParams.keys()].every((key) => ["wc", "owc", "i", "cc", "groupId", "lang"].includes(key));
      return [{ label, href: nativeImage ? href : null,
        disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true" }];
    });
    const filmControls = controls.flatMap((element) => {
      const label = clean(element.getAttribute("aria-label"));
      const text = clean(element.innerText);
      return /film number|alternative waypoints/i.test(label) ? [{ label, text: text.slice(0, 1000) }] : [];
    });
    const filmTexts = [...document.querySelectorAll("main h1, main h2, main h3")].filter(visible)
      .map((element) => clean(element.innerText)).filter((text) => /Film\s*#?\s*\d+/i.test(text));
    // Accept a literal film label in a leaf span without materializing a
    // surrounding viewer panel or general page/record text.
    for (const span of document.querySelectorAll("main span")) {
      if (span.childElementCount === 0 && visible(span) && /^Film\s*#\s*\d{7,9}$/i.test(clean(span.innerText))) filmTexts.push(clean(span.innerText));
    }
    const filmNumbers = [...new Set([...filmTexts, ...filmControls.flatMap((control) => [control.text, control.label])]
      .flatMap((text) => [...text.matchAll(/(?:Film\s*#?\s*|^)(\d{7,9})\b/gi)].map((match) => match[1])))];
    const breadcrumbs = [...document.querySelectorAll('main a[href]')].filter(visible).flatMap((element) => {
      const href = safeUrl(element.href);
      if (!href || !/\/search\/(?:image\/index|collection\/\d+)/i.test(new URL(href).pathname)) return [];
      return [{ text: clean(element.innerText).slice(0, 1000), href }];
    });
    const breadcrumbText = [...document.querySelectorAll('[aria-label*="breadcrumb" i], [data-testid*="breadcrumb" i]')]
      .filter(visible).map((element) => clean(element.innerText).slice(0, 2000));
    return { gate: false, url: safeUrl(location.href), inputCount: inputs.length, ordinal, total,
      filmNumbers, filmControls, breadcrumbs, breadcrumbText, navigation,
      busy: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible) };
  });
  assertFamilySearchImageUrl(page.url(), expected);
  return snapshot;
}

export function classifyFamilySearchViewerMetadata(snapshot) {
  if (snapshot.gate) return "gate";
  if (snapshot.inputCount > 1 || snapshot.filmNumbers.length > 1
      || ["Previous Image", "Next Image"].some((label) => snapshot.navigation.filter((item) => item.label.toLowerCase() === label.toLowerCase()).length > 1)) return "ambiguous";
  if (snapshot.busy || snapshot.inputCount !== 1 || !Number.isInteger(snapshot.ordinal) || snapshot.ordinal < 1
      || !Number.isInteger(snapshot.total) || snapshot.total < snapshot.ordinal || snapshot.filmNumbers.length !== 1
      || snapshot.navigation.length !== 2 || snapshot.breadcrumbs.length === 0) return "pending";
  return "ready";
}

export async function waitForFamilySearchViewerMetadata(page, expected, {
  read = readFamilySearchViewerMetadata, now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 12_000,
} = {}) {
  const deadline = now() + timeoutMs;
  let previous = "";
  let stable = 0;
  let lastSnapshot;
  while (now() < deadline) {
    assertFamilySearchImageUrl(page.url(), expected);
    const snapshot = await read(page, expected);
    lastSnapshot = snapshot;
    assertFamilySearchImageUrl(page.url(), expected);
    const state = classifyFamilySearchViewerMetadata(snapshot);
    if (state === "gate") return snapshot;
    if (state === "ambiguous") throw new Error("FamilySearch viewer metadata is ambiguous; no sequence conclusion is available.");
    const signature = JSON.stringify(snapshot);
    stable = state === "ready" ? (signature === previous ? stable + 1 : 1) : 0;
    previous = signature;
    if (stable >= 3) return snapshot;
    await pause(500);
  }
  const error = new Error("FamilySearch viewer metadata did not settle with an image ordinal, total, film and breadcrumb; this is an extraction failure, not a negative finding.");
  error.viewerMetadata = lastSnapshot;
  throw error;
}
