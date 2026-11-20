# Setting up a tree

This repository holds two things: the **engine** (`tools/`, `lib/`, `app/`, `assets/`, the viewer shell `index.html`) and one family's **tree** (`evidence/`, `tree/`, `tree.config.json`, `consents.json` and the runbooks). The engine reads everything specific to a tree or a machine from that tree's files, so another family can run the same engine on their own tree.

## Start a new tree

```sh
node tools/tree-init.mjs --dir ../smith-family --id smith-family --title "Smith Family" [--gedcom smith.ged]
cd ../smith-family
npm install
npm run build
```

`tree-init` copies the engine as committed at `HEAD` (never another session's unfinished work) into the new directory, makes a first local commit, and writes:

| File | Purpose |
| --- | --- |
| `tree.config.json` | Tree id and title, root people, research scopes, machine paths, viewer title, Vercel scope |
| `consents.json` | Which outward-facing helpers the owner has switched on (none at first) |
| `AGENTS.md`, `GOAL.md` | Generic rules and work loop for the research agent |
| `DECISIONS.md` | The owner's own goals, choices and authorizations |
| `evidence/` | An empty canonical store, or one built from the GEDCOM |

`node tools/gedcom-import.mjs --file <file.ged>` imports into an existing, near-empty tree the same way. With `--gedcom`, every person, name, life event, place and parent link in the file becomes a **candidate** assertion backed by a single family-statement source for the file. The importer opens one research question per imported parent link, so the agent's first job is to check the imported tree against original records. Nothing imported is treated as proven.

Then:

1. Set `tree.rootPersonIds` to the people whose ancestry the tree follows (the import picks the first person in the file; check it).
2. Set `paths.primaryCheckout` to the checkout's absolute path. Set `paths.recordArchive` to an encrypted folder outside Git for source masters, and `paths.desktopMirror` if you keep a copy elsewhere.
3. Fill in `DECISIONS.md`.
4. Create a private Git repository for the tree and push it. Never make it public: it holds living people's details and records acquired under your subscriptions.

## Configuration reference (`tree.config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `tree.id` | `family-tree` | Slug used for temporary directories and the export header |
| `tree.title` | `Family history` | Human title |
| `tree.rootPersonIds` | `[]` | People whose direct ancestry the tree follows |
| `tree.homePersonIds` | the roots | People the viewer opens on |
| `scopes.default` | `main` | Scope used when a command names none |
| `scopes.additional` | `[]` | Further research scopes; each runs only with the owner's explicit authorization |
| `scopes.dormant` | `[]` | Additional scopes whose records stay visible but are not worked |
| `paths.primaryCheckout` | `null` (any) | The one checkout allowed to commit and deploy |
| `paths.desktopMirror` | `null` (none) | Mirror target for `npm run sync:win` |
| `paths.recordArchive` | `~/family-history-source-masters/<id>` | Source-master archive; `FAMILY_RECORD_ARCHIVE` overrides |
| `viewer.title`, `shortTitle`, `subtitle` | the tree title | Viewer branding |
| `vercel.scope` | `null` | Vercel team for direct publication |
| `consentsFile` | `consents.json` | Name of the consents file |
| `engineBoundary.terms` | `[]` | This tree's distinctive words; the engine-boundary check stops them spreading into engine code |

`node tools/tree-config.mjs` prints the merged configuration and `node tools/tree-config.mjs --check` validates it.

## Consents (`consents.json`)

Helpers that act as the owner are off until the owner switches them on:

| Capability | What it does |
| --- | --- |
| `card-payment` | Pays a provider with a card already saved in the owner's browser |
| `bank-transfer` | Prepares a Wise transfer; the owner presses Send |
| `mailed-check` | Has a cheque printed and posted through the owner's Lob account |
| `email-enquiry` | Sends enquiries, reminders and quote acceptances |
| `contact-form` | Submits contact forms with the owner's details |
| `saved-signin` | Submits sign-in forms Chrome has autofilled |
| `account-registration` | Registers on a site the owner names |
| `mailbox-read` | Reads provider replies, attachments and one-time email codes |
| `inbox-tidy` | Archives processed research mail (never deletes) |
| `life-stories` | Writes life stories through the owner's Claude Code plan |

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "email-enquiry": { "enabled": true, "grantedOn": "2026-11-19", "grantedBy": "Ann Smith" }
  }
}
```

`node tools/consents.mjs` lists the current state. A consent never replaces a helper's own gates: payments still need the exact `PAY <request-id>` phrase and stay within the recorded amount, submissions still need `SUBMIT <target-slug>`, and CVV, MFA, CAPTCHA and the final bank-transfer send always stay with the owner.

## Tree-specific code (`tree/`)

Rules that only make sense for one tree live under `tree/`, never in `tools/`:

- `tree/hooks/<name>.mjs`: extra checks the engine runs by convention (for example `check-family-data`, which receives the generated chart and an `issues` array).
- `tree/engine-boundary-baseline.json`: how many times each engine file still names this tree's families. `node tools/engine-boundary.mjs` warns when an engine file gains a mention; the count may only fall.

## Exporting

```sh
node tools/gedcom-export.mjs --out family.ged [--established-only] [--include-living] [--no-sources]
```

The export carries every non-rejected person, event, place and parent link, with candidate and unresolved facts marked by an `Assessment` note and their sources as `SOUR` records. Living people are reduced to "Living" unless `--include-living` is passed.

## What still assumes one tree

The engine was separated from the tree it was first built for in stages. These parts still assume it:

- Some tests in `data:check` read the original tree's store or its frontier baseline. A new tree should run `npm run build` and `node tools/check-new-tree.mjs`, which run only the checks that hold for any tree.
- The viewer shell (`index.html`) takes its title, roots, tabs and labels from `tree.config.json`.
- The flag and country list (`tools/place-labels.mjs`, `assets/flags/`) covers seven countries (England, Germany, Ireland, Italy, Scotland, United States, Wales).
- Browser automation, credential storage and mailbox reading require Windows Chrome over CDP from WSL, Windows DPAPI and the PowerShell wrappers.
- Provider integrations (Ancestry, Findmypast, FamilySearch, GRO, TNA, Archion and others) are built into `tools/` rather than separate plug-ins.
