---
name: safe-deletion
description: >-
  Prove a removal is complete before running the tests: enumerate every reference with an
  untruncated grep, check a local variable across the whole enclosing function, anchor
  deletions on exact text instead of line numbers, then separate your breakage from
  pre-existing failures with git stash push and a re-run on HEAD. Use when removing code, a
  feature, a control, or an exported symbol.
---

# Proving a feature removal is complete

## When this applies

- You delete a function, module, route, control, test helper or configuration key.
- You rename a symbol and need to be sure no reference survives.
- A test suite fails after a removal and you need to know whether you caused it.

## Invariants

- Enumerate references with an **untruncated** grep. Piping through `head` once hid a
  `[data-verify-lb-models]` click left in an unrelated poll test, which then hung 30 s on a
  button that no longer existed.
- Grep a local variable's name across the _whole_ enclosing function before deleting it. A
  `const draft = drafts[groupIndex] || {}` looked preview-only, but a later edit used it to
  rebuild the chip and node-status rows; deleting it failed six UI tests.
- Anchor deletions on exact text, never line numbers: the read tool trims the leading
  whitespace of the first displayed line, which is enough to shift a slice by a whole block and
  fire an assertion on the wrong line.
- Removing a cross-domain import changes the module graph, so the removal is not complete until
  `npm run check:modules` reports zero cycles and zero out-of-domain imports.
- A removed UI control is also a documentation and tooling change: the browser suite, the
  fixtures, the skills that name it, and any committed baseline that shows it all have to
  follow. Regenerate baselines rather than assuming the pixel comparison will notice.
- A skill or design document that names the removed thing must be edited in the same change;
  `npm run check:skills` fails when a named file, command or link no longer exists.

## Standard commands

```bash
# Enumerate every reference; write the output to a gitignored file instead of piping
# into head (closing that pipe early is what truncates the list).
grep -rn "<removed-symbol>" src test-node docs scripts electron > test-results/refs.txt

npm run check:modules
npm run check:skills
npm test -- <related test files>

# Separate pre-existing breakage from yours.
git stash push -- src test-node
npm test -- <failing test>
git stash pop
```

## Reading the result

- A reference list that still contains a hit after the change is unfinished work, even when the
  build is green: a dangling selector or event handler fails only at runtime.
- A test that fails on the stashed HEAD too is pre-existing. That takes minutes and is far
  cheaper than a 75-second UI run of guesswork.
- `check:modules` naming a chain means the deletion left an edge pointing at a module that the
  importing domain may not reach; fix the import, not the checker.

## Deeper material

- [current-architecture.md](../../../docs/current-architecture.md) §6 — the dependency
  direction rules the module checker enforces.
- `scripts/module-edges.ts` — the executable version of those rules.
