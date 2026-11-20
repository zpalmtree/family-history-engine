// Projects package.json down to the parts that can actually affect the deployed
// viewer, for the deployment fingerprint.
//
// Why this exists: the fingerprint decides whether the workflow deploys at all,
// and it used to hash package.json whole. This repo has ~194 npm scripts, nearly
// all of them research and acquisition tooling, so adding a script moved the
// fingerprint and forced a redeploy of a byte-identical viewer. Worse, it made
// every tooling commit go red if the author forgot to restage -- which was the
// cause of every CI failure in the sampled history.
//
// Safety direction matters here. Missing a real change would skip a needed
// deployment and silently leave production stale, so this projection is
// deliberately a superset of what strictly matters: all dependency and runtime
// metadata, plus every script transitively reachable from the real build
// command. Excess only causes an unnecessary deploy; omission causes a wrong one.

// Dependency and runtime metadata. Any of these can change what gets installed
// or how Node executes the app.
export const RUNTIME_PACKAGE_FIELDS = Object.freeze([
  "name",
  "version",
  "type",
  "engines",
  "packageManager",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions"
]);

// The build entry is read from vercel.json rather than hardcoded, so changing
// the build command automatically changes which scripts are in scope. A change
// to vercel.json itself is already covered: it is hashed as a runtime file.
export function buildEntryScript(vercelConfigText) {
  try {
    const command = JSON.parse(vercelConfigText)?.buildCommand;
    const match = /npm run ([A-Za-z0-9:_-]+)/.exec(command || "");
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Every script reachable from `entry` by following `npm run <name>` references. */
export function reachableScripts(scripts = {}, entry) {
  const seen = new Set();
  if (!entry || !scripts[entry]) return seen;
  const stack = [entry];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || !scripts[name]) continue;
    seen.add(name);
    for (const match of scripts[name].matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) stack.push(match[1]);
  }
  return seen;
}

/**
 * Canonical, stable text for the fingerprint. Returns the raw source unchanged
 * if anything is unparseable, so a malformed input can never silently shrink
 * what the fingerprint covers.
 */
export function runtimePackageProjection(packageJsonText, vercelConfigText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return packageJsonText;
  }
  const entry = buildEntryScript(vercelConfigText);
  if (!entry) return packageJsonText;

  const projection = {};
  for (const field of RUNTIME_PACKAGE_FIELDS) {
    if (pkg[field] !== undefined) projection[field] = pkg[field];
  }
  const reachable = [...reachableScripts(pkg.scripts, entry)].sort();
  projection.scripts = Object.fromEntries(reachable.map((name) => [name, pkg.scripts[name]]));
  return JSON.stringify(projection, null, 2);
}
