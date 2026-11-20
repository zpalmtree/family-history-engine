# Project Rules

These rules apply to every agent working on this family tree. `GOAL.md` says what the work is for; `DECISIONS.md` records this tree's own choices and authorizations. Where they conflict, this file and `DECISIONS.md` win.

## Writing and publishing

- Write, commit and deploy only from the primary checkout named by `paths.primaryCheckout` in `tree.config.json` (any checkout when it is unset), on branch `main`, current with `origin/main`. Never write from an alternate clone or worktree, never reset or discard work you did not make, never force-push.
- Commit through `npm run deploy:main -- --message "<message>" --paths <files>`. It regenerates derived files, validates, commits exactly the named paths and pushes. Shared registries (`evidence/records-manifest.json` and the other queues) are committed by row with `--records <ids>`, never named in `--paths`.
- Never edit generated views: `data/family/*.json`, `data/family-data.js`, `data/tree-layouts.js`, `evidence/source-atoms.json`, `evidence/viewer-sources.json`, `evidence/acquisition-session-queue.json`.
- Never publish the repository root. The viewer is built from the allowlisted protected build (`npm run site:stage`); canonical data, queues, tools and notes never enter it.

## Evidence

- Canonical claims live in `evidence/proof/people/`, `evidence/proof/unions/` and `evidence/proof/kinships/`; sources, citations, questions and acquisition targets in `evidence/sources/`, `evidence/citations/`, `evidence/research/` and `evidence/acquisition/`.
- A parent edge, even a candidate one, needs an archived original with an independent review at its current hash. An index or transcript alone registers a citation with the person unlinked.
- Prefer original images over transcripts, transcripts over indexes. Keep confirmed, candidate and unresolved facts distinct. A same-name, same-place match alone is never enough.
- Record literal readings separately from canonical identities. Never copy a name from a neighbouring page.
- Record every search with `npm run research:attempt -- ...` or `npm run research:acquisition:attempt -- ...`, with a bounded scope. A truncated result set is incomplete, never a negative.
- Facts imported from a GEDCOM are leads at candidate strength, not proof. Promote them only with evidence.
- Never infer living relatives from people-search sites, social media or address association.

## Records and privacy

- Keep browser screenshots, checkout and account pages, and restricted record downloads out of Git. Record every acquired source in `evidence/records-manifest.json`.
- Keep payment data, passwords, API keys and viewer secrets out of code, chat, `.env`, logs and screenshots.
- Respect each provider's terms. Records acquired under one person's subscription are for this tree only.

## Outward-facing helpers

- Payment, bank-transfer, email, contact-form, sign-in, registration and mailbox helpers act only when `consents.json` switches them on (`npm run consents` lists them). They are all off in a new tree.
- Even when switched on, a payment needs the owner's exact `PAY <request-id>` phrase and stays within its recorded amount; a no-charge submission needs the exact `SUBMIT <target-slug>` phrase. CVV, MFA, CAPTCHA, bank challenges and the final bank-transfer send are always the owner's.
- Treat paid certificates as proof-point purchases, after free and already-accessible sources have been checked.

## Research scopes

- Omitted scope always means the default scope in `tree.config.json`. An additional scope may run only when the owner's current prompt authorizes it, and every command then carries `--scope <name>`.

## Reporting

- Give every item that needs the owner a stable ID: `NEEDS USER <id> — <short title>`, with the exact action or reply token. Continue other work meanwhile; mark the whole goal blocked only when no safe, productive work remains.
