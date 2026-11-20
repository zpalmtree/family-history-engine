(function exposeFamilyTreeRecency(globalObject) {
  "use strict";

  const NEW_NODE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

  function isNewTreeNode(treeAddedAt, now = Date.now()) {
    const addedAtMs = typeof treeAddedAt === "string" ? Date.parse(treeAddedAt) : Number.NaN;
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(addedAtMs) || !Number.isFinite(nowMs)) return false;
    const ageMs = nowMs - addedAtMs;
    return ageMs >= 0 && ageMs <= NEW_NODE_WINDOW_MS;
  }

  globalObject.familyTreeRecency = Object.freeze({
    isNewTreeNode,
    NEW_NODE_WINDOW_MS
  });
})(globalThis);
