---
name: safe-deletion
description: >-
  Before deleting a feature, control or code path: enumerate every reference with an untruncated grep, check a local variable across the whole enclosing function, anchor deletions on exact text rather than line numbers because the read tool trims leading whitespace, and use git stash push plus a re-run on HEAD to separate your breakage from pre-existing failures. Use when removing code or a UI feature.
---

# Proving a feature removal is complete

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- Removing a feature is proven by three checks before any test run: enumerate every reference with an **untruncated** grep (piping through `head` hid one `[data-verify-lb-models]` click left in an unrelated poll test, which then hung 30 s on a button that no longer existed), grep a local variable's name across the _whole_ enclosing function before deleting it (`const draft = drafts[groupIndex] || {}` looked preview-only but a later edit used it to rebuild the chip and node-status rows, so deleting it failed 6 UI tests), and anchor deletions on exact text rather than line numbers - the read tool trims the leading whitespace of the first displayed line, which is enough to shift a slice by a whole block and make an assertion fire on the wrong line. `git stash push -- src test-node` plus re-running the failing test on HEAD separates your breakage from pre-existing failures in minutes, far cheaper than a 75 s UI run of guesswork.
