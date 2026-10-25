# The UI bundle and its static checks: details

Background for [SKILL.md](./SKILL.md).

## Why the bundle read retries ENOENT

The bundle is published by `[System.IO.File]::Replace`, which briefly removes the destination.
A reader polling across that window got `ENOENT` for a file that was being replaced — measured
once in about ten thousand back-to-back reads. Without the retry, `build-ui-bundle.test.ts`
flakes; after the whole bounded window an absent bundle still fails with the "build it first"
message, so the retry does not hide a real miss.

## Proving a packaged build delivered this script

Compare what the packaged server serves at `/static/app.js` with the payload assembled from
`app.asar` entries — that one file, read back through `@electron/asar`'s
`extractFile(archive, path)`, where the path is backslash-separated and has no leading
backslash. The server substitutes the strip-fields placeholder, and the replacement is longer
than the placeholder, so raw lengths differ by design: compare after applying that
substitution, and show the placeholder present in the packaged payload and absent from the
served text. That pair is what proves the substitution ran.

## The strict-type contract

`tsconfig.ui.json` enables `allowJs`, `checkJs`, `strictNullChecks` and
`exactOptionalPropertyTypes` over the complete browser graph. The DOM helpers return concrete
elements; `requiredTyped`/`optionalTyped` add constructor checks with selector-bearing errors,
and `controlsOn` returns an input/select/textarea union so checked and selection APIs need real
class guards. The API result assertion is the wire boundary: errors are parsed from `unknown`
with field guards, so a malformed error body cannot become a type assertion hole. Remaining
strict options such as `noImplicitAny` are separate from the completed null migration.

`src/admin/ui-contracts.d.ts` imports Node type declarations for the shared DTOs while the
browser code still uses browser APIs at runtime, which is why the declarations are `.d.ts`
rather than a runtime module.

## Throwaway browser probes

A probe hit the same wall the admin tests already respect: `/api/load-balancer/status` has
`additionalProperties: false` with a long `required` list, so a stub fixture missing
`canonicalKey`, `failures` or `inRotation` answers 500 and the probe waits for a poll that never
fills anything.
