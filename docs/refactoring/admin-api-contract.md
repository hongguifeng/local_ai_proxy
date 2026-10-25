# Admin API contract: one declaration, two consumers

`src/admin/admin-schemas.ts` declares every wire shape the admin API accepts or answers, once,
as a Zod schema. Two things are read off those declarations:

- the TypeScript types in `src/admin/admin-contracts.ts`, through `AdminDto<T>` =
  `DeepReadonly<z.output<T>>`;
- the objects Fastify compiles, through `toAdminJsonSchema(schema)`.

`AdminServerOptions` then holds services whose methods answer those DTO types, so a renamed or
forgotten field cannot change the serializer without changing the contract type, or the type
without changing the serializer. `test-node/admin/api-contract.test.ts` boots the real
application and pins the route table and the top-level response keys, which is where a rename
on a route that has no response schema would otherwise reach the browser as `undefined`.

## The conversion rules

`z.toJSONSchema()` cannot be handed to Fastify as it is. Three parts are translated, and only
those three.

| Zod emits | Why it cannot be used | What `toAdminJsonSchema` does |
| --- | --- | --- |
| `$schema: ".../draft/2020-12/schema"` | Fastify's validator is a draft-07 compiler and refuses the reference with `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"` as soon as a request schema declares it. | The key is deleted. Every draft-07 keyword Zod emits is understood, so the declaration itself needs no translation. |
| `propertyNames: { type: "string" }` | The check is a no-op on JSON — every key of an object is already a string — while fast-json-stringify's strict validator writes two warnings to stderr for each one it meets, nested ones included. | The key is deleted at every depth, not just at the root. |
| `anyOf: [ <schema>, { type: "null" } ]` from `.nullable()` | fast-json-stringify validates an `anyOf` value with its ajv validator instead of using its own serializer path, so a key the schema does not declare becomes a 500 instead of being dropped. | Collapsed into `type: ["object", "null"]` plus the branch's own keywords, which is the same statement on the serializer's ordinary path: closed shapes still drop undeclared keys, open ones still keep them, and `null` still prints as `null`. |

`additionalProperties: {}` is deliberately left alone. It is Zod's way of saying "any other key
is allowed", and both compilers act on it: an undeclared key survives validation and survives
serialization. That is how openness is expressed in this file. A closed payload says
`additionalProperties: false`, which is Zod's default for `z.object`, and that is what makes
fast-json-stringify drop a key the declaration does not name.

## Two constraints that ride along as metadata

`minProperties` and `uniqueItems` are the two keywords Zod's own JSON-Schema reader lists as
unsupported, so `POST /api/logs/cleanup` attaches them with `.meta()`, which `toJSONSchema`
merges into the output. They are the reason that route has always rejected an empty body and a
repeated group id, and they are the only place in the file where a rule lives outside the
shape.

The summary-model save is the other deliberate exception. The wire structure of a save is
declared here so the route can check its shape, but the field rules stay with
`summaryModelConfigSchema`: a bad URL, an empty model name or a header line without a colon
comes back as `invalid_config` with the offending paths, which is what the browser points at.
That schema uses `.refine()`, which no JSON Schema can express, so duplicating those rules here
would only split one rule across two places.

## Open or closed, per payload

A payload is **closed** when this project writes every key of it. It is **open** where the
content belongs to someone else: the summary model's own JSON, a stored pricing block, a client
request body, an upstream answer, a proxy pair as the console holds it.

| Payload | Decision | Reason |
| --- | --- | --- |
| `{ error: { code, message } }` | closed | The browser reads it for every failure; an accidental extra field must not ride along with an error. |
| health snapshot | closed | Three keys this process writes. |
| proxy pair, and the `pairs`/`pair` wrapper | **open** | The console reads keys this file does not list and posts the same object back when a pair is saved. |
| the `{ enabled }` toggle | **open** | It belongs to the pair family; the handler reads `enabled` and nothing else. |
| target check / metrics / models answers | closed | Every key is written by the probe in `src/proxy`. |
| model-price import request and answer | closed | Written by this project; money stays text. |
| load-balancer status, including its `metrics` block | closed | Read out of memory by this project, so drift in a node or a metric is visible here instead of in the browser. |
| group page, group rows, batch records, the three series, cleanup | closed | Written by `logListItem()` and the series builders. |
| record detail top level | closed | The eight keys are all this project writes. |
| `request`, `response`, `request_meta`, `response_meta`, the pricing block | **open** | They hold other people's JSON: the client's body, the upstream's answer, the header names each side chose, the matched rule and the measured usage exactly as they arrived. |
| a stored summary | **open** | It is the summary model's own JSON. A key the prompt never asked for (`model_note` in the measured case) must survive POST → store → GET byte for byte. |
| a task brief | closed | The fact names are the project's own; the model's prose arrives as one paragraph. |
| statistics overview, trend, options, buckets, totals | closed | This project's arithmetic, and `dataVersion` is pinned to 1. |
| summary-model settings | closed | Seven keys the settings route writes. |

Two consequences of that table are worth stating, because they are the failure modes this file
exists to prevent.

**Serialization.** Attaching a response schema hands the answer to fast-json-stringify, which
prints only the properties the schema declares. Types compiling proves nothing here: a key can
be present in the type, in the service model and in the answer, or missing from the answer, and
the build looks the same either way. `test-node/admin/response-schema-openness.test.ts`
therefore checks the decision against a server that is actually running — the assembled
application for the open payloads, and a live admin server for the declared ones.

**Validation.** Fastify's validator used to delete keys a schema does not declare before the
handler saw them (`removeAdditional`), so a closed request body silently lost a key instead of
refusing it. That is switched off in `createAdminServer`: a closed payload now answers
`400 FST_ERR_VALIDATION`, and an open one keeps the keys it was given. `docs/current-architecture.md`
owns the startup and verification commands; this file only owns the wire contract.

## Errors are declared but not attached

`ADMIN_ERROR_DTO_SCHEMA` is the shared shape, and `adminError()` in `admin-contracts.ts` is the
only place that builds it. It is attached to no route: `adminResponseSchemas(ok)` declares only
the success answer.

The reason is measured, not theoretical. A reply sent inside `setErrorHandler` **is** serialized
through the route's response schema, so a closed `{ code, message }` schema attached to 400
deletes the `issues` array that a rejected configuration carries — and `01-core.js` reads
`data.error.issues`, `configIssueText()` formats it, and `09-wiring.js` shows it in a toast,
while `test-node/admin/pairs.test.ts` pins four exact field paths. `AdminConfigFieldIssuesDto`
carries those paths, and because no error answer carries a schema, a rename stops the build at
the producer instead of being deleted by a serializer.

## Two things the schema order decides

`fast-json-stringify` prints required properties before optional ones. Two declarations are
shaped by that fact, and the reason is written in the file so it does not look like a mistake.

- The record detail declares `decode_window_ms`, `request_meta` and `response_meta` optional so
  the answer keeps the order the service model writes them in — the order the browser has always
  received. `decode_window_ms` is genuinely absent on a pending record; the two meta blocks are
  written on every detail.
- `setPairEnabledRequestDto` is a loose object. A closed body would delete a key before the
  handler ran, and the test that posts `{ enabled, extra_switch }` expects the handler, not the
  validator, to be the one that ignores it.

## The client seam

`src/admin/static/01-core.js` has exactly one `fetch`, inside `api()`. Every admin call the
console makes goes through it, so it is the single place where the wire contract can be named,
and the call now carries a JSDoc block that points at this file. An unsuccessful answer is
turned into an `ApiError` whose `message` comes from `data.error.message`, whose `code` comes
from `data.error.code` and whose `issues` come from `data.error.issues` when the answer carries
them, so the failure side of the seam is typed against the same shape `adminError()` and
`adminConfigError()` produce. The success side is left as it is on purpose: retyping the return
as `Record<string, unknown>` breaks every caller under `tsc -p tsconfig.ui.json`. The browser is
still nine numbered classic scripts, so the contract is referenced through JSDoc only — no module
import, no export, no new script file, and `09-wiring.js` is still last.

## What the pair answer guarantees, and what it does not

`[AI-08] carries a legacy flat pair's modelled values and drops what the model does not know`
writes a legacy flat pair into `proxies.json` — 27 keys, with `log_root`, `redact_logs` and
`model_mapping_mode` set at the pair level and no `targets` list. `/api/pairs` answers 11 keys
for it: `id, name, enabled, listen_host, listen_port, access_log, targets, default_target_id,
load_balancers, running, actual_listen_port`. Only 5 of the written keys are among those, so 22
are dropped and 6 are added by the pipeline.

The loss is not on the wire. An open pair object does answer undeclared keys verbatim —
fast-json-stringify was measured directly, and `accepts a pair body with a key no schema names
and answers it back` passes for exactly that reason; so does `running` and
`actual_listen_port`, which no schema names but the real answer carries. The loss happens
earlier: `normalizeProxyPair()` rebuilds a pair from its own key list, so a key the
configuration model does not declare never reaches the serializer. Normalising a legacy flat
pair into the nested model is deliberate current behaviour — the pair's `log_root` does survive,
as the absolute path of the single target normalisation has to invent for a pair that listed none.

Keeping configuration the model does not declare is a separate requirement and is owned by
**AI-25**, recorded in `docs/ai-development-optimization-todo.md`. It means changing
`src/config`, which is not this document's subject, and it would also start writing the
console's own `running`, `actual_listen_port` and `expanded` into the saved file.
