import { randomUUID } from "node:crypto";
import net from "node:net";

export const sharedChromeEndpoint = "http://127.0.0.1:9226";
export const sharedBrowserBackend = process.env.FAMILY_HISTORY_BROWSER_BACKEND || "broker";
const controlPipe = process.env.SHARED_BROWSER_PIPE || "\\\\.\\pipe\\shared-browser-bridge-v1";

export const sharedBrowserBridge = {
  connect: connectSharedBrowser
};

export async function connectSharedBrowser({
  chromium,
  endpoint = sharedChromeEndpoint,
  taskLabel = "family-history",
  namespace = "family-history",
  lifetime = "session",
  affinitySlot,
  provider,
  reconnectExisting = false
}) {
  if (endpoint !== sharedChromeEndpoint) {
    throw new Error(`${taskLabel} is restricted to the one shared localhost Chrome/CDP endpoint ${sharedChromeEndpoint}.`);
  }
  if (sharedBrowserBackend === "legacy-cdp") {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = requireSharedProfileContext(browser, taskLabel);
    return legacyConnection(browser, context);
  }
  if (sharedBrowserBackend !== "broker") {
    throw new Error(`Unsupported FAMILY_HISTORY_BROWSER_BACKEND=${sharedBrowserBackend}; use broker or explicit rollback value legacy-cdp.`);
  }
  if (process.platform !== "win32") {
    throw new Error(`${taskLabel} must connect to the broker from Windows Node through the project PowerShell wrapper.`);
  }

  const browserState = await bridgeControl("browser.ensure");
  if (browserState?.status !== "running" || !browserState.cdpEndpoint) {
    throw new Error(`Shared browser broker is not running for ${taskLabel} (status=${browserState?.status || "unknown"}).`);
  }
  if (!/[\\/]FamilyHistorySubscriptionChrome$/i.test(String(browserState.profileDir || ""))) {
    throw new Error(`Shared browser broker exposed the wrong Chrome profile for ${taskLabel}.`);
  }
  const lease = await bridgeControl("lease.acquire", {
    owner: `${taskLabel}:${process.pid}`,
    namespace,
    lifetime,
    ...(affinitySlot ? { affinitySlot } : {}),
    ...(provider ? { provider } : {}),
    ...(reconnectExisting ? { reconnectExisting: true } : {})
  });
  // Parked leases never expire in the bridge, so a helper that parks a tab and
  // exits would otherwise leave it open indefinitely. Every project connection
  // releases (and closes) this namespace's abandoned parks before it opens more.
  await sweepStaleParkedLeases({ namespace, affinitySlot, currentLeaseId: lease.leaseId }).catch(() => {});
  let browser;
  let context;
  try {
    browser = await chromium.connectOverCDP(browserState.cdpEndpoint, { timeout: 15_000 });
    context = requireSharedProfileContext(browser, taskLabel);
  } catch (error) {
    await browser?.close().catch(() => {});
    if (lifetime === "session") {
      await bridgeControl("lease.release", { leaseId: lease.leaseId }).catch(() => {});
    } else {
      await bridgeControl("lease.park", { leaseId: lease.leaseId, lifetime }).catch(() => {});
    }
    throw error;
  }
  let finished = false;
  const heartbeat = setInterval(() => {
    bridgeControl("lease.heartbeat", { leaseId: lease.leaseId }).catch(() => {});
  }, 30_000);
  heartbeat.unref();

  const ownedPages = new Set();
  const targetIds = new Map();
  const rememberPage = (page, identity) => {
    if (ownedPages.has(page)) {
      targetIds.set(page, identity.targetId);
      return;
    }
    ownedPages.add(page);
    targetIds.set(page, identity.targetId);
    page.once("close", () => {
      ownedPages.delete(page);
      targetIds.delete(page);
    });
  };
  const adoptPage = async (page, { root = false } = {}) => {
    const identity = await targetIdentity(context, page);
    await bridgeControl("lease.adopt", {
      leaseId: lease.leaseId,
      targetId: identity.targetId,
      root,
      ...(identity.windowId !== undefined ? { windowId: identity.windowId } : {})
    });
    rememberPage(page, identity);
    return identity;
  };
  const expectedTargets = new Set(lease.descendants || []);
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const identity = await targetIdentity(context, page).catch(() => null);
    if (identity && expectedTargets.has(identity.targetId)) rememberPage(page, identity);
  }
  const onPage = (candidate) => {
    void (async () => {
      const opener = await candidate.opener().catch(() => null);
      if (!opener || !ownedPages.has(opener) || ownedPages.has(candidate)) return;
      await adoptPage(candidate);
    })().catch(() => {});
  };
  context.on("page", onPage);

  return {
    browser,
    context,
    lease,
    adoptPage,
    ownedPages() {
      return [...ownedPages].filter((page) => !page.isClosed());
    },
    async forgetTarget(targetId) {
      await bridgeControl("lease.forget", { targetId });
      for (const [page, ownedTargetId] of targetIds) {
        if (ownedTargetId !== targetId) continue;
        ownedPages.delete(page);
        targetIds.delete(page);
      }
    },
    async park(parkLifetime = lifetime === "persistent" ? "persistent" : "manual") {
      return await bridgeControl("lease.park", { leaseId: lease.leaseId, lifetime: parkLifetime });
    },
    async resume() {
      return await bridgeControl("lease.resume", { leaseId: lease.leaseId });
    },
    async release({ closeTargets = false } = {}) {
      return await bridgeControl("lease.release", { leaseId: lease.leaseId, closeTargets });
    },
    async closeClient({ leaseAction = "release", closeTargets = false } = {}) {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      context.off("page", onPage);
      if (leaseAction === "park") await bridgeControl("lease.park", {
        leaseId: lease.leaseId,
        lifetime: lifetime === "persistent" ? "persistent" : "manual"
      });
      else if (leaseAction === "release") await bridgeControl("lease.release", { leaseId: lease.leaseId, closeTargets });
      await browser.close().catch(() => {});
    }
  };
}

// A parked "manual" lease holds a tab revealed for a human step (sign-in,
// CAPTCHA, CVV). A later task in the same slot supersedes it after a short
// grace; any manual park is abandoned after six hours. Persistent leases are
// reusable affinity tabs, abandoned after a day unless their slot is protected.
export const PARKED_LEASE_POLICY = Object.freeze({
  sameSlotGraceMs: 30 * 60_000,
  manualTtlMs: 6 * 60 * 60_000,
  persistentTtlMs: 24 * 60 * 60_000,
  protectedSlots: Object.freeze(["subscription-providers"])
});

export function selectStaleParkedLeases(leases, {
  namespace,
  affinitySlot,
  currentLeaseId,
  now = Date.now(),
  policy = PARKED_LEASE_POLICY
} = {}) {
  return (Array.isArray(leases) ? leases : []).filter((lease) => {
    if (!lease || lease.state !== "parked" || lease.leaseId === currentLeaseId) return false;
    if (lease.namespace !== namespace) return false;
    if (lease.affinitySlot && policy.protectedSlots.includes(lease.affinitySlot)) return false;
    const touched = Date.parse(lease.heartbeatAt || lease.updatedAt || lease.createdAt || "");
    if (!Number.isFinite(touched)) return false;
    const age = now - touched;
    if (lease.lifetime === "persistent") return age >= policy.persistentTtlMs;
    if (affinitySlot && lease.affinitySlot === affinitySlot && age >= policy.sameSlotGraceMs) return true;
    return age >= policy.manualTtlMs;
  });
}

export async function sweepStaleParkedLeases({ namespace, affinitySlot, currentLeaseId, control = bridgeControl, now = Date.now() } = {}) {
  const stale = selectStaleParkedLeases(await control("lease.list"), { namespace, affinitySlot, currentLeaseId, now });
  const released = [];
  for (const lease of stale) {
    try {
      await control("lease.release", { leaseId: lease.leaseId, closeTargets: true });
      released.push(lease.leaseId);
    } catch {}
  }
  return released;
}

export async function bridgeControl(method, params = {}) {
  const request = { id: randomUUID(), method, params };
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPipe);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Shared browser control ${method} timed out.`)), 10_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== request.id) throw new Error("Shared browser control response ID mismatch.");
        if (response.error) throw new Error(response.error.message || `Shared browser control ${method} failed.`);
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error(`Shared browser control socket closed during ${method}.`));
    });
  });
}

async function targetIdentity(context, page) {
  const pageSession = await context.newCDPSession(page);
  const browserSession = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    let windowId;
    try {
      const result = await browserSession.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
      windowId = Number(result.windowId);
    } catch {}
    return {
      targetId: targetInfo.targetId,
      ...(Number.isFinite(windowId) ? { windowId } : {})
    };
  } finally {
    await pageSession.detach().catch(() => {});
    await browserSession.detach().catch(() => {});
  }
}

function requireSharedProfileContext(browser, taskLabel) {
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error(`The shared Windows Chrome profile exposed no default browser context for ${taskLabel}.`);
  }
  // Chrome's persistent profile is the first CDP context. Additional contexts
  // may belong to bridge-isolated visual reviews and are outside this lease.
  return contexts[0];
}

function legacyConnection(browser, context) {
  return {
    browser,
    context,
    lease: null,
    async adoptPage(page) { return await targetIdentity(context, page); },
    ownedPages() { return []; },
    async forgetTarget() {},
    async park() {},
    async resume() {},
    async release() {},
    async closeClient() { await browser.close().catch(() => {}); }
  };
}
