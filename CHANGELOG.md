# Changelog

The first heading is the version `npm run engine:release` publishes. Upgrade a tree with `npm run tree:upgrade -- --ref v<version>`.

## 0.3.3 — 2026-11-20

- Tested on macOS 26 (Apple silicon, Node 22): the engine tests, the five-minute walkthrough, the new-tree checks, `browser:start`/`npm run local` against Chrome, and the Keychain secret store.
- A locked secret store (the macOS login Keychain over SSH, or Linux without a desktop keyring) now says it is locked instead of reporting the secret as not stored.
- Session status no longer warns that the inbox has never been swept on a tree that has sent no requests.
- The research README's question-id prefix groups come from `research.questionIdPrefixes` in `tree.config.json` (default `rq-frontier-`).
- From ongoing research use: FamilySearch film reading and record import fixes, public-record recovery fixes, a more compact research README for large branches, and new publish-gate tests.

## 0.3.2 — 2026-11-20

- README: screenshots of the sample tree (map, a person's page, pedigree, phone) and a five-minute walkthrough.

## 0.3.1 — 2026-11-20

- macOS and Linux: `npm run local -- … --secret-stdin <name>` pipes a stored secret to a tool's stdin (the contact-form requester profile), and the TLCPL library profile lives in the operating system's secret store. Windows and WSL keep the DPAPI profiles.

## 0.3.0 — 2026-11-20

- macOS and Linux: a "local" browser backend (the default off Windows), `npm run browser:start / status / stop` for a Chrome with the tree's own profile (`paths.browserProfile`), and `npm run local -- tools/<tool>.mjs` to run a research tool against it under one browser lock. CI drives a headless Chrome through it on Linux.
- `npm run secret -- set|status|delete <name>`: secrets in the macOS Keychain or the Linux Secret Service, named per tree, passed on stdin only.

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
