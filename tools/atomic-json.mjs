import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonAtomic(file, value) {
  const target = file instanceof URL ? fileURLPath(file) : path.resolve(file);
  const directory = path.dirname(target);
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : 0o644;
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode });
  try {
    const handle = fs.openSync(temporary, "r");
    try {
      fsyncIfSupported(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") {
      const directoryHandle = fs.openSync(directory, "r");
      try {
        fsyncIfSupported(directoryHandle);
      } finally {
        fs.closeSync(directoryHandle);
      }
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeJsonCreateOnlyAtomic(file, value) {
  const target = file instanceof URL ? fileURLPath(file) : path.resolve(file);
  const directory = path.dirname(target);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });

  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") === contents) return false;
    throw new Error(`immutable JSON file already exists with different content: ${target}`);
  }

  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o644 });
  try {
    const handle = fs.openSync(temporary, "r");
    try {
      fsyncIfSupported(handle);
    } finally {
      fs.closeSync(handle);
    }

    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (fs.readFileSync(target, "utf8") !== contents) {
        throw new Error(`immutable JSON file already exists with different content: ${target}`);
      }
      return false;
    } finally {
      fs.rmSync(temporary, { force: true });
    }

    if (process.platform !== "win32") {
      const directoryHandle = fs.openSync(directory, "r");
      try {
        fsyncIfSupported(directoryHandle);
      } finally {
        fs.closeSync(directoryHandle);
      }
    }
    return true;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function fsyncIfSupported(handle) {
  try {
    fs.fsyncSync(handle);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  }
}

export function updateJsonAtomic(file, update) {
  const current = readJson(file);
  const next = update(current) ?? current;
  writeJsonAtomic(file, next);
  return next;
}

export function withFileLockSync(file, callback, { timeoutMs = 30_000, staleMs = 120_000 } = {}) {
  const target = file instanceof URL ? fileURLPath(file) : path.resolve(file);
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        // Another writer may release the lock between mkdir's EEXIST result
        // and this metadata read. Retry acquisition instead of failing a
        // registration that was already safely serialized.
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (age > staleMs) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for JSON lock: ${target}`);
      Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function fileURLPath(value) {
  if (value.protocol !== "file:") throw new Error(`only file URLs are supported: ${value}`);
  return fileURLToPath(value);
}
