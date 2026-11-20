# Changelog

The first heading is the version `npm run engine:release` publishes. Upgrade a tree with `npm run tree:upgrade -- --ref v<version>`.

## 0.2.1 — 2026-11-20

- `tools/test-tree-config.mjs`: tests that need a known configuration (a dormant `collateral` scope, two roots) import it first and behave the same in every tree.
- Eight more tests ship: exhibits, inbox tidy and sweep, page depth, viewer readings, kinship and pedigree layouts, signature exhibits.

## 0.2.0 — 2026-11-20

- `npm run tree:upgrade` moves a tree to another engine release, keeping its own data, config and branding, then runs store migrations and the checks. A tree started on 0.1.0 has no upgrade script yet: clone this release and run `node <clone>/tools/tree-upgrade.mjs --tree <your tree> --from <clone>` once.
- Releases carry a version and a tag; `tree-init` records the engine version and source in `tree.config.json`.
- CI on every push: a tree started from the fixture GEDCOM must build and pass `data:check` and `tree:check`.
- Countries beyond the original seven (`places.countries`), with code badges where there is no flag artwork.
- GRO certificate ordering ships, with no built-in order.

## 0.1.0 — 2026-11-20

- First public release: canonical evidence store, research scheduler, provider automation, consents, GEDCOM import and export, `tree-init`, the protected viewer.
