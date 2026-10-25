---
name: admin-api-probing
description: >-
  Diagnose an admin /api route that answers 404 or 500, or add one: registration is split
  by feature under src/admin/routes/ behind service-presence checks, the production
  service set is complete and asserted before the port binds, so a 404 on a real
  application means a missing record rather than missing wiring, and Fastify validation
  400s carry FST_ERR_VALIDATION. Use when an admin route is missing, fails, or changes.
---

# Missing or failing admin API routes

## When this applies

- A browser call to `/api/...` answers 404 or 500 and you need to know whether the route
  is unregistered or the data is missing.
- You add, rename, or remove an admin route, a response field, or a service method.
- You change which services `createNodeApplication()` wires into the admin server.

## Invariants

- Registration is split by feature: `src/admin/routes/logs.ts`, `statistics.ts`,
  `pairs.ts`, `targets.ts`, `settings.ts`, `load-balancer.ts`, `model-catalog.ts`,
  `static-files.ts`. `createAdminServer` in `src/admin/admin-server.ts` builds only the
  server, the request hooks and `/api/health`, then calls each registrar behind the same
  `options.X !== undefined` check. A route exists exactly when its registrar was called.
- The production half is not optional (AI-09): `AdminServerOptions` requires every
  service the route table answers from, `assembleAdminServices` in
  `src/app/admin-services.ts` builds that set, and `assertAdminServicesComplete` refuses
  a hole by name before the admin port is bound. On a real application a 404 therefore
  means the record or group is missing;
  `{ "code": "not_found", "message": "Route not found." }` is only reachable on a
  server assembled from `PartialAdminServerOptions`, which is what the stub tests pass.
- Service interfaces live in `src/admin/admin-contracts.ts` and the JSON schemas in
  `src/admin/admin-schemas.ts`. A schema is a wire contract, not documentation: renaming
  a declared field without changing the schema still ships, and an undeclared field only
  survives because the response schemas are open.
- 28 of the 33 registered routes declare a response schema. The five that do not are the
  stream endpoints — `GET /api/logs/export` (ZIP) and `GET /api/usage-statistics/export`
  (CSV) — plus `/`, `/static/app.css` and `/static/app.js`; each says so at its
  registration. A rename on one of those five is invisible to both typechecks and would
  surface only as `undefined` in the UI.
- Fastify schema-validation 400s carry the code `FST_ERR_VALIDATION`; the error handler
  falls back to `bad_request` only when the error has no `code`, so a test that asserts
  the code on a rejected body must expect `FST_ERR_VALIDATION`.

## Standard commands

```bash
npm test -- test-node/admin/api-contract.test.ts
npm test -- test-node/app/runtime.test.ts
npm run typecheck
npm run lint
```

## Reading the result

- `test-node/admin/api-contract.test.ts` boots the real application and pins the whole
  route table plus the top-level response keys. It is the fastest way to separate the
  two causes: a missing registration fails the route-table case, a missing record fails
  a per-route code assertion.
- An empty-config run answers most routes with empty collections, so a 500 points at the
  service implementation, at a stub fixture missing a required field, or at the native
  SQLite binding (see `packaging-smoke`), not at routing.
- A 404 from a running instance while the route-table case is green means the record or
  group id is wrong, not that the wiring is broken.

## Deeper material

- [reference.md](./reference.md) — how the 404/500 split was established and which stub
  assemblies can still produce the not-found handler.
- [admin-api-contract.md](../../../docs/refactoring/admin-api-contract.md) — the API
  contract decisions.
- [current-architecture.md](../../../docs/current-architecture.md) §5 — the module map
  and the route registration rule.
