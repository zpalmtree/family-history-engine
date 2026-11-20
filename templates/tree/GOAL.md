# Family History Goal

Extend this tree's direct ancestry through reliable evidence, and keep the tree and its evidence in step. `AGENTS.md` holds the hard rules; `DECISIONS.md` holds this tree's own choices.

## Measure progress by the tree

1. **Primary:** a parent edge established, reaching a new direct ancestor or generation.
2. **Leading:** a parent named by an archived, reviewed original (a candidate edge); a candidate promoted; a contradiction resolved.
3. **Supporting:** a core fact confirmed or corrected; an original acquired and published; a new route for a stalled frontier.

Everything else (bounded negatives, catalogue checks, rereads that change nothing) is background.

## Start of a session

1. Read this file, `DECISIONS.md` and `evidence/INDEX.md` if present.
2. Run `git status --short` and preserve all existing work.
3. If consents include sign-in, run `npm run providers:signin`. If they include mailbox reading, run `npm run requests:inbox:sweep`.
4. Save the selection receipt: `npm run --silent research:session:status -- --json > /tmp/research-selection.json`, and run `npm run research:status -- --needs-user`.

## Work loop

1. Take the selected item from the receipt and read only its linked canonical records.
2. Choose the action most likely to name a parent in an original you can archive:
    1. an acquired original not yet read;
    2. a parent-bearing record (baptism, marriage naming fathers, census household, will) in a collection open now, free sources first;
    3. an index pointing at such a record, then acquire the image in the same session;
    4. a narrative naming parents, used only to aim a search;
    5. catalogue, holdings or archive correspondence, only when 1 to 4 are exhausted.
3. Stop after three consecutive provider operations that add nothing new; record the bounded negatives and one next action.
4. When an original names a parent, search the same source for the parents' marriage and baptisms before leaving it.
5. Record attempts, update canonical data, run `npm run build` and `npm run tree:check`.
6. Complete the selection with `npm run research:scheduler:complete -- --selection /tmp/research-selection.json ...`, commit with `deploy:main`, save a fresh receipt and continue.

## Stop and ask only when

- no productive canonical action remains;
- a contradiction affects a living person's identity or a close relationship the owner confirmed;
- the next step needs a sign-up, a submission, a payment or a new authorization;
- an action would expose sensitive personal, account or payment data.
