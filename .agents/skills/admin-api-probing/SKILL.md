---
name: admin-api-probing
description: >-
  Why an admin endpoint answers 404 or 500: admin service methods are optional and
  routes register only when present, so compare src/app/runtime.ts wiring against
  LogAdminService, PairAdminService, SummaryModelAdminService and
  ModelCatalogAdminService, remember that registration lives in
  src/admin/routes/<feature>.ts behind the same service checks, add new-route coverage
  to the route contract test, and remember Fastify validation errors carry
  FST_ERR_VALIDATION. Use when an /api route is missing or a DB-backed admin call fails.
---

# Missing or failing admin API routes

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- Admin service methods are optional and routes register only when present. For a 404, compare `src/app/runtime.ts` wiring with `LogAdminService`, `PairAdminService`, `SummaryModelAdminService`, and `ModelCatalogAdminService`; add new-route coverage to the assembled-app smoke test in `test-node/app/runtime.test.ts`. Fastify schema-validation 400s carry the error code `FST_ERR_VALIDATION` (the error handler only falls back to `bad_request` when the error has no `code`), so tests asserting the code must expect `FST_ERR_VALIDATION`.
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
