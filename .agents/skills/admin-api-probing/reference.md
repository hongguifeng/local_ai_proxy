# Admin route 404 and 500: how the answer was established

This is the history behind [SKILL.md](./SKILL.md). Read it when the short invariants are
not enough to explain what an assembled application does.

## What a 404 can mean

Before AI-09, every admin service method was optional and each route registered only when
its method existed. A missing method therefore looked exactly like a missing record, and
the two had to be told apart by comparing `src/app/runtime.ts` wiring with the four
service classes (`LogAdminService`, `PairAdminService`, `SummaryModelAdminService`,
`ModelCatalogAdminService`).

Since AI-09 the production assembly is total: `AdminServerOptions` requires the services
and the log, pair and summary methods in full, `assembleAdminServices` builds that set,
and `assertAdminServicesComplete` refuses a hole by name before the admin port is bound.
Only a server built from `PartialAdminServerOptions` — the stub admin servers under
`test-node/` — can still answer the not-found handler, so on an assembled application the
remaining 404 cause is a missing record or group.

## What a 500 can mean

- The service threw: an unreadable log root, a closed database handle, or a provider
  error the route does not translate.
- A stub fixture returned a shape the route or its response schema rejects. The
  strictest example is `GET /api/load-balancer/status`: its schema is
  `additionalProperties: false` with a long `required` list, so a fixture missing
  `canonicalKey`, `failures` or `inRotation` produces a 500, not an empty panel.
  `GET /api/load-balancer/tasks` is closed the same way at eight nested depths, so a
  fixture that invents a TTL, an expiry or a user-message count on a binding row loses
  that field silently instead of failing — which is why
  `test-node/admin/response-schema-openness.test.ts` walks every declared object.
- The native SQLite binding cannot load. After `npm run rebuild:electron` a plain Node
  process sees the Electron ABI and DB-backed routes answer 500 `ERR_DLOPEN_FAILED`.
  That is an ABI state, not a route bug; `npm run abi:check` proves which ABI is
  installed and `npm run rebuild:node` restores the Node one.

## Where the route-table assertion lives

`test-node/admin/api-contract.test.ts` was written to make a missing registration a test
failure instead of a browser-side `undefined`. It pins 36 registrations and the top-level
response keys of the JSON routes, including the empty-configuration case. Its `probeUrl`
function also spells out the query strings the statistics routes require, which is why
`real-upstream-acceptance` points at it instead of inventing URLs.

The 31-of-36 schema count is current, not historical: the five stream endpoints
(`/api/logs/export`, `/api/usage-statistics/export`, `/`, `/static/app.css`,
`/static/app.js`) carry no response schema because their body is not a JSON DTO. Recount
with the TypeScript AST rather than a grep — several registrations write their generic
across three lines, so a line-based scan undercounts. The table spans four methods (`GET`,
`POST`, `PUT`, `DELETE`); TRI-08 added the first delete, so a verb roster of three is out
of date.
