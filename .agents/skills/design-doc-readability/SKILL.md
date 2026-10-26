---
name: design-doc-readability
description: >-
  Write or merge a design document that is judged by measured readability rather than
  intent: one-sentence decision summary, numbered requirements the tests point back to,
  explicit v1 non-goals, a checkable acceptance list, open questions as a table, measured
  numbers in a table, and one named implementation authority. Use when writing or merging
  a design or specification document.
---

# Judging design documents by measurement

## When this applies

- You write a new design, spec or task document.
- You merge peer drafts, or demote a draft once a decision is made.
- A document reads long, but you need evidence before rewriting it.

## Invariants

- Shape is fixed: a decision summary where every item is one short sentence (one item =
  one verifiable contract), numbered requirements that the test plan and the final
  acceptance list point back to, an explicit v1 non-goals section, a checkable acceptance
  list at the end, and open questions as a question / recommendation / alternative table
  instead of paragraphs.
- A list of constraints is one table, not nine `###` subsections.
- Bold only what must not be missed; bold everywhere is no emphasis at all. Inline code is
  a cost, not a free way to be precise.
- Measured numbers belong in a table and must justify every constant the document sets
  (poll interval, threshold, cap). Otherwise the reader cannot tell measured from guessed.
- One document is the implementation authority; every other draft is process material.
  When merging, first list the facts each draft uniquely held, then check the merge kept
  them, and re-verify a peer's recommendation against the code before adopting it.
- This is a Node-only repository: a measurement pass is a throwaway script, never a
  committed `.py` file (`test-node/docs/node-only-repository.test.ts` fails on one).

## Standard commands

```bash
# There is no fixed readability command. Run a throwaway pass outside the repository's
# build graph that reports chars, average sentence length, sentences over 80 chars, bold
# marks per 1k chars, heading counts, tables and inline-code spans.

# The doc format entry this project does have; docs/ is excluded from npm run format:check.
npx prettier --ignore-path .gitignore --check docs/ai-development-optimization-todo.md
npm test -- test-node/docs
```

## Reading the result

- Compare average sentence length, the count of long sentences and bold marks per 1k chars
  as signals for editing. These measurements describe document structure; they do not
  establish reading time, comprehension or design correctness.
- A document that sets a constant without a measured source is unfinished, not concise.
- `npx prettier --ignore-path .gitignore --check` must pass on the file you touched; a
  file under `docs/` is not covered by `npm run format:check`.

## Deeper material

- [feature-design-review](../feature-design-review/SKILL.md) — evidence, state ownership,
  lifecycle and API/UI consistency checks before adopting a design.
- [reference.md](./reference.md) — the measured draft-versus-merged comparison.
- [ai-development-optimization-todo.md](../../../docs/ai-development-optimization-todo.md)
  — the document shape this project uses for its own plan, with completion records.
- [current-architecture.md](../../../docs/current-architecture.md) §8 — which material is
  current and which is history.
