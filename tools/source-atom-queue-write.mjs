import { readJson, writeJsonAtomic } from "./atomic-json.mjs";

export function snapshotQueueAtomIds(queue) {
  return new Map((queue.targets || []).map((target) => [target.id, target.atomId]));
}

export function writeChangedQueueAtomIds(file, beforeAtomIds, desiredQueue) {
  const changes = [];
  for (const target of desiredQueue.targets || []) {
    const before = beforeAtomIds.get(target.id);
    if (before !== target.atomId) changes.push({ id: target.id, before, after: target.atomId });
  }
  if (!changes.length) return false;

  const latest = readJson(file);
  const latestTargets = new Map((latest.targets || []).map((target) => [target.id, target]));
  let changed = false;
  for (const change of changes) {
    const target = latestTargets.get(change.id);
    if (!target) throw new Error(`provider queue target disappeared during source atom refresh: ${change.id}`);
    if (target.atomId === change.after) continue;
    if (target.atomId !== change.before) {
      throw new Error(`provider queue atomId changed concurrently during source atom refresh: ${change.id}`);
    }
    target.atomId = change.after;
    changed = true;
  }
  if (changed) writeJsonAtomic(file, latest);
  return changed;
}
