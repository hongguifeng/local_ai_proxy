---
name: admin-api-probing
description: >-
  Why an admin endpoint answers 404 or 500: admin service methods are optional and routes register only when present, so compare src/app/runtime.ts wiring against LogAdminService, PairAdminService, SummaryModelAdminService and ModelCatalogAdminService, add new-route coverage to the assembled-app smoke test, and remember Fastify validation errors carry FST_ERR_VALIDATION. Use when an /api route is missing or a DB-backed admin call fails.
---

# Missing or failing admin API routes

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- Admin service methods are optional and routes register only when present. For a 404, compare `src/app/runtime.ts` wiring with `LogAdminService`, `PairAdminService`, `SummaryModelAdminService`, and `ModelCatalogAdminService`; add new-route coverage to the assembled-app smoke test in `test-node/app/runtime.test.ts`. Fastify schema-validation 400s carry the error code `FST_ERR_VALIDATION` (the error handler only falls back to `bad_request` when the error has no `code`), so tests asserting the code must expect `FST_ERR_VALIDATION`.
