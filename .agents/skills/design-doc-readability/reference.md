# The measured draft-versus-merged comparison

Background for [SKILL.md](./SKILL.md).

A prose-first draft and the merged specification decided the same things. A throwaway
measurement pass over both, taken once on this machine, reported:

| Document | Chars per sentence | Sentences over 80 chars | Bold marks per 1k chars |
| -------- | ------------------ | ----------------------- | ----------------------- |
| Draft    | 54.7               | 43                      | 7.4                     |
| Merged   | 30.7               | 3                       | 1.1                     |

These are structural measurements, not a timed reading experiment. They make a review
comment about sentence length and emphasis checkable, but do not establish a reading-time
ratio or comprehension benefit. They motivated the following editing heuristics; the
thresholds are local review guidance, not validated universal limits:

- Sentences over 80 chars are almost always a paragraph that has not been turned into a
  table or a decision item.
- Bold marks per 1k chars above roughly 2 means emphasis is everywhere, which is no
  emphasis.
- Inline code spans inflate both the character count and the reading effort; a constant
  that appears once belongs in a table row with its measurement.

The same pass was used to compare the merged document with the peer drafts it absorbed,
which is how the "list the facts each draft uniquely held, then check the merge kept
them" step became part of the skill.
