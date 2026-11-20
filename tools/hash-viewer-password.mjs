#!/usr/bin/env node

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const valueOnly = process.argv.includes("--value-only");
const promptStream = valueOnly ? process.stderr : process.stdout;
if (!process.stdin.isTTY || (!valueOnly && !process.stdout.isTTY) || typeof process.stdin.setRawMode !== "function") {
  console.error("Run npm run auth:hash in an interactive terminal so the passphrase can remain hidden.");
  process.exit(1);
}

const first = await hiddenPrompt("New family passphrase: ");
const second = await hiddenPrompt("Confirm passphrase: ");
if (first !== second) {
  console.error("Passphrases did not match.");
  process.exit(1);
}
if (first.length < 16) {
  console.error("Use a passphrase of at least 16 characters.");
  process.exit(1);
}
const salt = randomBytes(16);
const digest = await scrypt(first, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const encoded = `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
if (valueOnly) {
  process.stdout.write(encoded);
} else {
  console.log(`\n${encoded}`);
  console.log("Copy only this hash into the Vercel VIEWER_PASSWORD_HASH sensitive variable.");
}

async function hiddenPrompt(label) {
  promptStream.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          promptStream.write("\n");
          finish();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          promptStream.write("\n");
          finish();
          process.exit(130);
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}
