---
name: design-doc-readability
description: >-
  Design docs are judged by measured readability, not intent: a throwaway Python pass over a doc and its peer drafts reports chars, average sentence length, sentences over 80 chars, bold marks per 1k chars, heading counts, tables and inline-code spans. Required shape is a decision summary of one-sentence items, numbered requirements the tests point back to, explicit v1 non-goals, a checkable acceptance list and open questions as a table. Use when writing or merging a design or spec document.
---

# Judging design documents by measurement

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- Design docs are judged by measurable readability, not intent. A throwaway Python pass over a doc and any peer draft it will be compared with reports chars, average sentence length, sentences over 80 chars, `**` marks per 1k chars, h2/h3 counts, tables and inline-code spans; here a prose-first draft scored 54.7 chars/sentence, 43 long sentences and 7.4 bold marks per 1k chars against the merged spec's 30.7 / 3 / 1.1 - about 2.6x the reading time for the same decisions. Required shape: a decision summary where every item is one short sentence (one item = one verifiable contract), numbered requirements that the test plan and the final acceptance list point back to, an explicit v1 non-goals section, a checkable acceptance list at the end, and open questions as a question / recommendation / alternative table instead of paragraphs. A list of constraints is one table, not nine `###` subsections; bold only what must not be missed (bold everywhere is no emphasis at all); inline code is a cost, not a free way to be precise. Measured numbers belong in a table and must justify every constant in the spec (poll interval, KV tier threshold, binding cap), otherwise the reader cannot tell measured from guessed. Name the document that is the implementation authority and demote the other drafts to process material; when merging peer drafts, first list the facts each one uniquely held and then check the merge kept them, and re-verify peer recommendations against the code before adopting them.
