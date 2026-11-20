#!/usr/bin/env node

// Prints a one-line deprecation notice for a renamed npm script, then exits 0 so
// the aliased command still runs. Chained with `&&` in package.json rather than
// wrapping the target, which keeps `npm run <alias> -- --flag` passthrough intact:
// npm appends caller arguments to the end of the whole script string, so they
// land on the real command and never on this warning.

const [deprecated, replacement] = process.argv.slice(2);

if (!deprecated || !replacement) {
  console.error("usage: warn-deprecated-script.mjs <deprecated-name> <replacement-name>");
  process.exit(2);
}

console.error(`warning: \`npm run ${deprecated}\` is deprecated; use \`npm run ${replacement}\`.`);
