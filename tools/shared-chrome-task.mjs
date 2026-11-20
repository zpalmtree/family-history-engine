import { sharedBrowserBridge, sharedChromeEndpoint } from "./shared-browser-bridge-client.mjs";
import { createBackgroundTarget } from "./cdp-background-target.mjs";

export { sharedChromeEndpoint };

export async function openSharedChromeTask({
  chromium,
  endpoint = sharedChromeEndpoint,
  taskLabel = "family-history",
  affinitySlot = "default",
  reconnectExisting = false,
  timeoutMs = 10_000,
  bridgeClient = sharedBrowserBridge
}) {
  if (endpoint !== sharedChromeEndpoint) {
    throw new Error(`${taskLabel} is restricted to the one shared localhost Chrome/CDP endpoint ${sharedChromeEndpoint}.`);
  }

  const connection = await bridgeClient.connect({
    chromium,
    endpoint,
    taskLabel,
    namespace: "family-history",
    lifetime: "session",
    affinitySlot,
    provider: taskLabel,
    reconnectExisting
  });
  const { browser, context } = connection;
  const browserSession = await browser.newBrowserCDPSession();
  let page;
  let targetId;
  const ownedPages = new Set();
  const onPage = async (candidate) => {
    const opener = await candidate.opener().catch(() => null);
    if (opener && ownedPages.has(opener)) {
      ownedPages.add(candidate);
      await connection.adoptPage(candidate).catch(() => {});
    }
  };

  try {
    const inventory = await sharedPageInventory(context);
    // An empty inventory means every Chrome window was closed; the task
    // target below then opens one background window (cdp-background-target).

    let reused = false;
    if (reconnectExisting && connection.lease?.rootTargetId) {
      const parked = inventory.find((item) => item.targetId === connection.lease.rootTargetId);
      if (parked) {
        page = parked.page;
        targetId = parked.targetId;
        reused = true;
      } else {
        await connection.forgetTarget(connection.lease.rootTargetId);
      }
    }
    if (!page) {
      const created = await createBackgroundTarget(browserSession, "about:blank");
      targetId = created.targetId;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !page) {
        page = (await sharedPageInventory(context)).find((item) => item.targetId === targetId)?.page;
        if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!page) throw new Error(`Chrome created no observable background task tab for ${taskLabel}.`);

    const identity = await connection.adoptPage(page, { root: true });
    if (identity.targetId !== targetId || !Number.isFinite(identity.windowId)) {
      throw new Error(`The bridge could not bind the ${taskLabel} task tab to an exact window-backed target.`);
    }
    const expectedWindowId = identity.windowId;

    ownedPages.add(page);
    context.on("page", onPage);
    let closed = false;
    let manualStepRevealed = false;
    return {
      browser,
      context,
      page,
      targetId,
      windowId: expectedWindowId,
      affinitySlot,
      reused,
      // True once a human step was revealed; helpers park the tab only then.
      get manualStepRevealed() { return manualStepRevealed; },
      async showForManualStep(reason) {
        if (page.isClosed()) throw new Error(`The ${taskLabel} task tab closed before manual action was requested.`);
        const current = await targetWindowId(context, page);
        if (current !== expectedWindowId) {
          throw new Error(`The ${taskLabel} task tab moved to another window after its bridge lease was established.`);
        }
        // bringToFront activates the tab inside its window, which is invisible
        // if the shared window itself is minimised or buried. Restore it first
        // so the person being asked to act can actually see what is waiting.
        await browserSession.send("Browser.setWindowBounds", {
          windowId: expectedWindowId,
          bounds: { windowState: "normal" }
        }).catch(() => {});
        await page.bringToFront();
        manualStepRevealed = true;
        console.log(`Revealed the existing bridge-owned ${taskLabel} tab for ${reason}; no new window was opened.`);
      },
      async close() {
        if (closed) return;
        closed = true;
        context.off("page", onPage);
        const descendants = [...ownedPages].filter((candidate) => candidate !== page && !candidate.isClosed());
        await Promise.all(descendants.map((candidate) => candidate.close({ runBeforeUnload: false }).catch(() => {})));
        if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
        if (targetId) await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});
        await browserSession.detach().catch(() => {});
        await connection.closeClient({ leaseAction: "release" }).catch(() => {});
      },
      async leaveOpen() {
        if (closed) return;
        closed = true;
        context.off("page", onPage);
        // Manual CAPTCHA, MFA, or provider-review steps must remain visible in
        // the existing shared window after the Node task releases its mutex.
        // Detach the CDP clients without closing the task tab or the shared
        // Chrome process; a later READY retry can reuse and finish it.
        await connection.park("manual");
        await browserSession.detach().catch(() => {});
        await connection.closeClient({ leaseAction: "keep" }).catch(() => {});
      }
    };
  } catch (error) {
    context.off("page", onPage);
    if (targetId) await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});
    await browserSession.detach().catch(() => {});
    await connection.closeClient({ leaseAction: "release" }).catch(() => {});
    throw error;
  }
}

export async function sharedPageInventory(context) {
  const inventory = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const session = await context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      inventory.push({ page, targetId: targetInfo.targetId });
    } finally {
      await session.detach().catch(() => {});
    }
  }
  return inventory;
}

async function targetWindowId(context, page) {
  const pageSession = await context.newCDPSession(page);
  const browserSession = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const result = await browserSession.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    return Number(result.windowId);
  } finally {
    await pageSession.detach().catch(() => {});
    await browserSession.detach().catch(() => {});
  }
}
