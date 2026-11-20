// Per-tree configuration.
//
// The engine (tools/, lib/, app/, the viewer shell) is meant to serve any family
// tree. Everything that belongs to one tree or one machine (its root people, its
// research scopes, where its primary checkout and Desktop mirror live, how its
// viewer is titled, which outward-facing helpers its owner has switched on) is
// read from `tree.config.json` at the repository root instead of being written
// into the code.
//
// A missing file or key falls back to a neutral default, so a fresh tree made by
// `npm run tree:init` works with a minimal config. `TREE_CONFIG_PATH` points the
// engine at another file (tests use this).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TREE_CONFIG_FILE = "tree.config.json";
export const TREE_CONFIG_SCHEMA_VERSION = 1;
// Version of the canonical evidence store layout (evidence/proof, sources,
// citations, research, acquisition). Bump only with a migration under
// tools/migrations/ that upgrades an existing tree.
export const STORE_SCHEMA_VERSION = 1;
export const DEFAULT_SCOPE = "main";

export const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PERSON_ID = /^[a-z0-9][a-z0-9-]*$/;

export function defaultTreeConfig() {
  return {
    schemaVersion: TREE_CONFIG_SCHEMA_VERSION,
    store: { schemaVersion: STORE_SCHEMA_VERSION },
    tree: {
      id: "family-tree",
      title: "Family history",
      // The people whose direct ancestry the tree follows.
      rootPersonIds: [],
      // People the viewer opens on (defaults to the roots).
      homePersonIds: []
    },
    scopes: {
      default: DEFAULT_SCOPE,
      // Extra scopes besides the default. Each needs explicit authorization in
      // the user's prompt before any operational command may run under it.
      additional: [],
      // Scopes whose records stay visible but are not worked unless authorized.
      dormant: []
    },
    paths: {
      // Absolute path of the one checkout allowed to write, commit and deploy.
      // null: whichever checkout the command runs in.
      primaryCheckout: null,
      // Optional mirror of the working tree (e.g. a Windows Desktop copy).
      // null: no mirror; `sync:win` is skipped.
      desktopMirror: null,
      // Where encrypted source masters live outside Git. The
      // FAMILY_RECORD_ARCHIVE environment variable overrides it.
      recordArchive: null
    },
    viewer: {
      title: null,
      shortTitle: null,
      subtitle: null,
      exportTitle: null,
      exportSlug: null,
      // Require an origin flag on every person shown on the tree.
      requireFlags: false,
      // How the viewer names each root person: [{ personId, name, sideLabel,
      // sideViewId }]. Defaults to the tree roots, named from the store.
      roots: []
    },
    vercel: {
      // Vercel team scope for direct publication and Blob audits.
      scope: null
    },
    consentsFile: "consents.json",
    // The tree's owner: signs outgoing enquiries; the personal mailbox
    // reader uses the mailbox. Kept in this private file, never the engine.
    owner: { name: null, personalMailbox: null }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value;
  }
  return out;
}

export function validateTreeConfig(config) {
  const errors = [];
  if (config.schemaVersion !== TREE_CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TREE_CONFIG_SCHEMA_VERSION}, found ${JSON.stringify(config.schemaVersion)}`);
  }
  if (config.store?.schemaVersion !== STORE_SCHEMA_VERSION) {
    errors.push(`store.schemaVersion ${JSON.stringify(config.store?.schemaVersion)} is not supported by this engine (expected ${STORE_SCHEMA_VERSION}); run the store migrations first`);
  }
  if (typeof config.tree?.id !== "string" || !SCOPE_ID.test(config.tree.id)) errors.push("tree.id must be a lower-case slug");
  if (typeof config.tree?.title !== "string" || !config.tree.title.trim()) errors.push("tree.title must be a non-empty string");
  for (const key of ["rootPersonIds", "homePersonIds"]) {
    if (!Array.isArray(config.tree?.[key]) || config.tree[key].some((id) => typeof id !== "string" || !PERSON_ID.test(id))) {
      errors.push(`tree.${key} must be an array of person ids`);
    }
  }
  const scopes = config.scopes || {};
  if (typeof scopes.default !== "string" || !SCOPE_ID.test(scopes.default)) errors.push("scopes.default must be a scope slug");
  if (!Array.isArray(scopes.additional) || scopes.additional.some((scope) => typeof scope !== "string" || !SCOPE_ID.test(scope))) {
    errors.push("scopes.additional must be an array of scope slugs");
  } else if (scopes.additional.includes(scopes.default) || new Set(scopes.additional).size !== scopes.additional.length) {
    errors.push("scopes.additional must be unique and must not repeat scopes.default");
  }
  if (!Array.isArray(scopes.dormant) || scopes.dormant.some((scope) => !Array.isArray(scopes.additional) || !scopes.additional.includes(scope))) {
    errors.push("scopes.dormant must list only scopes named in scopes.additional");
  }
  if (!Array.isArray(config.viewer?.roots) || config.viewer.roots.some((root) => !root || typeof root.personId !== "string" || !PERSON_ID.test(root.personId)
    || (root.name !== undefined && typeof root.name !== "string") || (root.sideLabel !== undefined && typeof root.sideLabel !== "string")
    || (root.sideViewId !== undefined && (typeof root.sideViewId !== "string" || !SCOPE_ID.test(root.sideViewId))))) {
    errors.push("viewer.roots must be an array of { personId, name?, sideLabel?, sideViewId? }");
  }
  for (const key of ["primaryCheckout", "desktopMirror", "recordArchive"]) {
    const value = config.paths?.[key];
    if (value !== null && value !== undefined && (typeof value !== "string" || !path.isAbsolute(value))) {
      errors.push(`paths.${key} must be an absolute path or null`);
    }
  }
  if (typeof config.consentsFile !== "string" || path.isAbsolute(config.consentsFile) || config.consentsFile.split(/[\\/]/).includes("..")) {
    errors.push("consentsFile must be a path inside the repository");
  }
  return errors;
}

export function treeConfigPath(root = engineRoot, env = process.env) {
  return env.TREE_CONFIG_PATH ? path.resolve(env.TREE_CONFIG_PATH) : path.join(root, TREE_CONFIG_FILE);
}

export function parseTreeConfig(raw, source = TREE_CONFIG_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${source} must hold a JSON object`);
  const config = mergeDeep(defaultTreeConfig(), parsed);
  const errors = validateTreeConfig(config);
  if (errors.length) throw new Error(`${source} is invalid:\n- ${errors.join("\n- ")}`);
  return Object.freeze(config);
}

const cache = new Map();

export function loadTreeConfig({ root = engineRoot, env = process.env, fresh = false } = {}) {
  const file = treeConfigPath(root, env);
  if (!fresh && cache.has(file)) return cache.get(file);
  const config = fs.existsSync(file)
    ? parseTreeConfig(fs.readFileSync(file, "utf8"), file)
    : Object.freeze(defaultTreeConfig());
  cache.set(file, config);
  return config;
}

export function researchScopes(config = loadTreeConfig()) {
  return [config.scopes.default, ...config.scopes.additional];
}

export function primaryCheckout(config = loadTreeConfig()) {
  return config.paths.primaryCheckout ? path.resolve(config.paths.primaryCheckout) : null;
}

export function desktopMirror(config = loadTreeConfig()) {
  return config.paths.desktopMirror ? path.resolve(config.paths.desktopMirror) : null;
}

export function dormantScopes(config = loadTreeConfig()) {
  return [...config.scopes.dormant];
}

// Root of the encrypted source-master archive outside Git.
export function recordArchiveRoot(config = loadTreeConfig(), env = process.env) {
  if (env.FAMILY_RECORD_ARCHIVE) return env.FAMILY_RECORD_ARCHIVE;
  if (config.paths.recordArchive) return config.paths.recordArchive;
  return path.join(os.homedir(), "family-history-source-masters", config.tree.id);
}

export function homePersonIds(config = loadTreeConfig()) {
  return config.tree.homePersonIds.length ? [...config.tree.homePersonIds] : [...config.tree.rootPersonIds];
}

export function viewerBranding(config = loadTreeConfig()) {
  const title = config.viewer.title || config.tree.title;
  return {
    title,
    shortTitle: config.viewer.shortTitle || title,
    subtitle: config.viewer.subtitle || title
  };
}

// What the viewer needs to know about this tree, carried in the generated
// family data (never the machine paths). `nameOf` maps a person id to a
// display name for roots the config does not name.
export function viewerProfile(config = loadTreeConfig(), nameOf = () => null) {
  const branding = viewerBranding(config);
  const configured = new Map(config.viewer.roots.map((root) => [root.personId, root]));
  const rootIds = config.tree.rootPersonIds.length ? config.tree.rootPersonIds : config.viewer.roots.map((root) => root.personId);
  const roots = rootIds.map((personId) => {
    const root = configured.get(personId) || {};
    const name = root.name || String(nameOf(personId) || personId).split(/\s+/)[0];
    return { personId, name, sideLabel: root.sideLabel || `${name}'s side`, ...(root.sideViewId ? { sideViewId: root.sideViewId } : {}) };
  });
  return {
    ...branding,
    // Countries this tree adds beyond the engine's own ([{ name, flag }]).
    countries: (config.places?.countries || []).filter((entry) => entry?.name).map((entry) => ({ name: entry.name, flag: entry.flag || null })),
    // Image exports: "<exportTitle> — <view>" saved as "<exportSlug>-<view>.png".
    exportTitle: config.viewer.exportTitle || config.tree.title,
    exportSlug: config.viewer.exportSlug || config.tree.id,
    roots,
    homePersonIds: homePersonIds(config)
  };
}

// The protected viewer's server code (app/layout.js, app/login/page.js,
// lib/viewer-auth.js) reads its title and session issuer from
// lib/viewer-branding.js, kept equal to this.
export const VIEWER_BRANDING_FILE = "lib/viewer-branding.js";
export function viewerBrandingSource({ title, issuer }) {
  return `// Generated from tree.config.json by node tools/tree-config.mjs --write-branding.\nexport default ${JSON.stringify({ title, issuer }, null, 2)};\n`;
}
export function viewerBrandingFile(config = loadTreeConfig()) {
  return viewerBrandingSource({ title: config.viewer.exportTitle || config.tree.title, issuer: config.tree.id });
}

// The name outgoing enquiries are signed with; the helpers refuse to send
// without it.
export function ownerName(config = loadTreeConfig()) {
  const name = config.owner?.name;
  if (!name || !String(name).trim()) throw new Error("Set owner.name in tree.config.json before sending enquiries.");
  return String(name).trim();
}

export function ownerSurname(config = loadTreeConfig()) {
  return ownerName(config).split(/\s+/).at(-1);
}

export function ownerSurnameOrNull(config = loadTreeConfig()) {
  const name = config.owner?.name;
  return name && String(name).trim() ? String(name).trim().split(/\s+/).at(-1) : null;
}

export function viewerTitle(config = loadTreeConfig()) {
  return viewerBranding(config).title;
}

export function vercelScopeArgs(config = loadTreeConfig()) {
  return config.vercel.scope ? ["--scope", config.vercel.scope] : [];
}

// A filesystem-safe prefix for temporary directories, e.g. screenshot runs.
export function tempPrefix(config = loadTreeConfig()) {
  return config.tree.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  try {
    const config = loadTreeConfig({ fresh: true });
    if (args.includes("--write-branding")) {
      fs.writeFileSync(path.join(engineRoot, VIEWER_BRANDING_FILE), viewerBrandingFile(config));
      console.log(`wrote ${VIEWER_BRANDING_FILE}`);
    } else if (args.includes("--check")) {
      console.log(`tree config ok: ${config.tree.id} (scopes ${researchScopes(config).join(", ")}; store schema v${config.store.schemaVersion})`);
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
