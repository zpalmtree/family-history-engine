// One deploy at a time.
//
// deploy:main builds and validates the exact tree it will commit, then commits and pushes it. If
// another session's commit lands while that pass runs, the pass is thrown away and repeated on the
// new HEAD. That was sound with one or two writers. On 19 Nov 2026 six sessions shared the
// checkout while Gaming Mode held every agent tool on the machine to four cores between them: a
// pass that takes two minutes alone took ten, three passes ran side by side, each one that
// finished threw the other two away, and a deploy went from two minutes to between 8 and 45, with
// up to four passes each. Running passes side by side gains nothing once they share the same
// cores, and every repeated pass slows the ones still running.
//
// So deploys queue. Each holds an exclusive kernel lock on a file in the Git directory from before
// it reads HEAD until its push has landed; the next one starts on the HEAD that push produced and
// validates once. The lock is an flock(2) lock held by a small child process whose only job is to
// hold it for as long as this process keeps a pipe to it open, so it is released the instant the
// deploy ends, however it ends (exit, crash, kill, timeout): there is no lock file to go stale and
// nothing to clean up by hand.
//
// The queue never stops a deploy. Where flock is missing, or the wait passes its limit, the deploy
// goes ahead exactly as it did before queues existed, and the retry-on-a-moved-HEAD loop still
// covers a commit made outside deploy:main.

import { spawn } from "node:child_process";
import fs from "node:fs";

export const defaultQueueWaitMs = 45 * 60 * 1000;

function readHolder(holderFile) {
  try {
    const holder = JSON.parse(fs.readFileSync(holderFile, "utf8"));
    process.kill(holder.pid, 0);
    return holder;
  } catch {
    return null;
  }
}

export function describeQueueHolder(holderFile) {
  const holder = readHolder(holderFile);
  if (!holder) return "another deploy is running";
  const since = new Date(holder.since).toLocaleTimeString("en-GB", { hour12: false });
  return `another deploy has been running since ${since} (pid ${holder.pid}${holder.label ? `: ${holder.label}` : ""})`;
}

/**
 * Wait for this deploy's turn. Resolves to { held, waitedMs, reason, release }: `held` is false
 * when the queue could not be joined ("unavailable") or the wait passed its limit ("timeout"), and
 * the caller carries on regardless. `release` is safe to call more than once.
 */
export function joinDeployQueue({
  lockFile,
  label = "",
  waitMs = defaultQueueWaitMs,
  noticeAfterMs = 2_000,
  noticeEveryMs = 60_000,
  command = "flock",
  log = console.log
} = {}) {
  const started = Date.now();
  const holderFile = `${lockFile}.holder`;
  const waited = () => Date.now() - started;
  const notQueued = (reason) => ({ held: false, reason, waitedMs: waited(), release: async () => {} });

  return new Promise((resolve) => {
    let settled = false;
    let firstNotice;
    let repeatNotice;
    let limit;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstNotice);
      clearInterval(repeatNotice);
      clearTimeout(limit);
      resolve(value);
    };

    let child;
    try {
      // flock takes the lock, then runs the shell: "held" says the lock is ours, and cat keeps it
      // until its input closes, which happens when this process ends its side or dies.
      child = spawn(command, [lockFile, "sh", "-c", "echo held; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      settle(notQueued("unavailable"));
      return;
    }
    child.on("error", () => settle(notQueued("unavailable")));
    child.on("exit", () => settle(notQueued("unavailable")));
    child.stdin.on("error", () => {});

    child.stdout.once("data", () => {
      if (settled) {
        child.stdin.end();
        return;
      }
      const mine = { pid: process.pid, since: new Date().toISOString(), label };
      try {
        fs.writeFileSync(holderFile, `${JSON.stringify(mine)}\n`);
      } catch {
        // The holder file only words the notice other sessions print while they wait.
      }
      // From here the lock must not keep this process alive, and must not outlive it.
      child.stdout.destroy();
      child.unref();
      child.stdin.unref?.();
      let released = null;
      const release = () => {
        released ||= new Promise((done) => {
          try {
            if (readHolder(holderFile)?.pid === process.pid) fs.rmSync(holderFile, { force: true });
          } catch {
            // Nothing depends on the holder file.
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          child.ref();
          const giveUp = setTimeout(() => {
            child.kill("SIGKILL");
            done();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(giveUp);
            done();
          });
          child.stdin.end();
        });
        return released;
      };
      settle({ held: true, reason: null, waitedMs: waited(), release });
    });

    firstNotice = setTimeout(() => {
      log(`queue: ${describeQueueHolder(holderFile)}; waiting for it to finish, so that neither run throws the other's validation away.`);
    }, noticeAfterMs);
    repeatNotice = setInterval(() => {
      log(`queue: still waiting after ${Math.round(waited() / 1000)} s; ${describeQueueHolder(holderFile)}.`);
    }, noticeEveryMs);
    limit = setTimeout(() => {
      settle(notQueued("timeout"));
      child.kill();
    }, waitMs);
  });
}
