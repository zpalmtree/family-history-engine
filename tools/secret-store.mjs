#!/usr/bin/env node
// The operating system's own secret store, for macOS and Linux.
//
//   npm run secret -- status <name>     is it stored? (never prints the value)
//   npm run secret -- set <name>        reads the value from stdin and stores it
//   npm run secret -- delete <name>
//
// macOS: the login Keychain (`security`). Linux: the Secret Service
// (`secret-tool`, GNOME Keyring or KWallet). Each secret is stored under the
// tree's id, so two trees never share one. Values pass through stdin or the
// child process's own pipes, never the command line, environment, logs or
// repository. On Windows the project's DPAPI profiles under LocalAppData stay
// the store; this module refuses there.

import { spawnSync } from "node:child_process";
import { loadTreeConfig } from "./tree-config.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function secretBackend(platform = process.platform) {
  if (platform === "darwin") return "keychain";
  if (platform === "linux") return "secret-service";
  return null;
}

export function serviceName(name, config = loadTreeConfig()) {
  if (!NAME.test(name)) throw new Error("A secret name is a lower-case slug.");
  return `family-history/${config.tree.id}/${name}`;
}

// The exact commands each backend runs; the value only ever travels on stdin.
export function secretCommands(backend, service, account = process.env.USER || "family-history") {
  if (backend === "keychain") {
    return {
      // `security -i` reads its command, value included, from stdin, so the
      // value never appears in the process's arguments.
      set: ["security", ["-i"]],
      get: ["security", ["find-generic-password", "-s", service, "-a", account, "-w"]],
      delete: ["security", ["delete-generic-password", "-s", service, "-a", account]]
    };
  }
  if (backend === "secret-service") {
    return {
      set: ["secret-tool", ["store", "--label", service, "service", service, "account", account]],
      get: ["secret-tool", ["lookup", "service", service, "account", account]],
      delete: ["secret-tool", ["clear", "service", service, "account", account]]
    };
  }
  throw new Error("No operating-system secret store on this platform; on Windows the project's DPAPI profiles are used.");
}

function runCommand([command, args], input) {
  return spawnSync(command, args, { input, encoding: "utf8" });
}

export function setSecret(name, value, { backend = secretBackend(), run = runCommand } = {}) {
  if (!value) throw new Error("Refusing to store an empty secret.");
  const commands = secretCommands(backend, serviceName(name));
  const quote = (text) => `"${String(text).replace(/["\\]/g, "\\$&")}"`;
  const input = backend === "keychain"
    ? `add-generic-password -U -s ${quote(serviceName(name))} -a ${quote(process.env.USER || "family-history")} -w ${quote(value)}\n`
    : value;
  const result = run(commands.set, input);
  if (result.status !== 0) throw new Error(`Could not store ${name} (${backend}).`);
}

export function getSecret(name, { backend = secretBackend(), run = runCommand } = {}) {
  const result = run(secretCommands(backend, serviceName(name)).get, "");
  if (result.status !== 0) return null;
  return String(result.stdout).replace(/\r?\n$/, "") || null;
}

export function deleteSecret(name, { backend = secretBackend(), run = runCommand } = {}) {
  const result = run(secretCommands(backend, serviceName(name)).delete, "");
  return result.status === 0;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, name] = process.argv.slice(2);
  try {
    if (!secretBackend()) throw new Error("No operating-system secret store on this platform; on Windows the project's DPAPI profiles are used.");
    if (!name || !["status", "set", "delete"].includes(action)) throw new Error("usage: npm run secret -- status|set|delete <name>   (set reads the value from stdin)");
    if (action === "set") {
      setSecret(name, await readStdin());
      console.log(`stored ${name}`);
    } else if (action === "delete") {
      console.log(deleteSecret(name) ? `deleted ${name}` : `${name} was not stored`);
    } else {
      console.log(getSecret(name) ? `${name}: stored` : `${name}: not stored`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
