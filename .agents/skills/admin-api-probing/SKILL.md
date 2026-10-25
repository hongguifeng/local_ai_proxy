---
name: admin-api-probing
description: >-
  Why an admin endpoint answers 404 or 500: admin service methods are optional and
  routes register only when present, so compare src/app/runtime.ts wiring against
  LogAdminService, PairAdminService, SummaryModelAdminService and
  ModelCatalogAdminService, remember that registration lives in
  src/admin/routes/<feature>.ts behind the same service checks, add new-route coverage
  to the route contract test, and remember Fastify validation errors carry
  FST_ERR_VALIDATION. The production service set is required and a hole is refused at startup
  by assertAdminServicesComplete, so on an assembled application a 404 means a missing record
  or group and only a stub assembly can answer "Route not found.". Use when an /api route is
  missing or a DB-backed admin call fails.
---

# Missing or failing admin API routes

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- Admin service methods are optional and routes register only when present. For a 404, compare `src/app/runtime.ts` wiring with `LogAdminService`, `PairAdminService`, `SummaryModelAdminService`, and `ModelCatalogAdminService`; add new-route coverage to the assembled-app smoke test in `test-node/app/runtime.test.ts`. Fastify schema-validation 400s carry the error code `FST_ERR_VALIDATION` (the error handler only falls back to `bad_request` when the error has no `code`), so tests asserting the code must expect `FST_ERR_VALIDATION`.
- Since AI-09 the production half is not optional: `AdminServerOptions` requires every service the route table answers from and the log, pair and summary methods in full, `assembleAdminServices` in `src/app/admin-services.ts` builds that set, and `assertAdminServicesComplete` refuses a hole by name before the admin port is bound. A 404 from the assembled application therefore means the record or group is missing, not the wiring; `{ code: "not_found", message: "Route not found." }` is the answer of the not-found handler and is only reachable on a server assembled from `PartialAdminServerOptions`, which is what the stub tests pass.
- Registration is split by feature under `src/admin/routes/`: `logs.ts`, `statistics.ts`,
  `pairs.ts`, `targets.ts`, `settings.ts`, `load-balancer.ts`, `model-catalog.ts`,
  `static-files.ts`. `createAdminServer` in `src/admin/admin-server.ts` builds the
  server, the request hooks and `/api/health`, then calls each registrar behind the same
  `options.X !== undefined` check, so a route is missing when the wiring in
  `src/app/runtime.ts` does not provide that service. Service interfaces live in
  `src/admin/admin-contracts.ts` and the JSON schemas in `src/admin/admin-schemas.ts`.
- `test-node/admin/api-contract.test.ts` boots the real application and pins the whole
  route table plus the top-level response keys. It is the fastest way to tell a missing
  registration apart from a missing record: the first shows up in the route table test,
  the second in the per-route code assertions.
