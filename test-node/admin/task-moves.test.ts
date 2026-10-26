import { afterEach, describe, expect, it } from "vitest";

import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import type { AdminTaskMoveRequest } from "../../src/admin/admin-schemas.js";
import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type PublicProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import { BindingHistoryService } from "../../src/maintenance/index.js";
import { isRecord } from "../../src/shared/index.js";
import {
  EMPTY_LOAD_SAMPLES,
  INITIAL_ROUTING_REVISION,
  LoadBalancer,
  MAX_MIGRATION_REASON_CHARS,
  createLoadBalancerAdminService,
  taskIdentity,
  type LoadBalancerAdminSource,
  type LoadBalancerBindingEntry,
  type LoadSample,
} from "../../src/proxy/index.js";

/**
 * [TRI-08] the manual migration API on a real route. Every case is answered by the real
 * `createLoadBalancerAdminService` over a real `LoadBalancer` through the real Fastify route, so
 * what is under test is the status and the code the route owns, not a stub's opinion: the
 * migration service, its bounded record store and the affinity table are the ones the proxy runs.
 * The assembled application is covered by `test-node/admin/api-contract.test.ts`; this file covers
 * what an assembled application can only answer once a pair is actually running.
 */

type GroupShape = ProxyPair["load_balancers"][number];

const PAIR_ID = "pair-moves";
const GROUP_ID = "lb-moves";

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

/** What none of these answers may ever repeat, whatever the binding was built from. */
const PRIVATE_USER_TEXT = "the private prompt the console must never see";
const PRIVATE_BODY_TEXT = "the private body the console must never see";
const SECRET_API_KEY = "sk-secret-value";
const SESSION_MARKER = "pc-session-marker-never-travels";

function target(id: string, url: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: url,
    target_api_key: SECRET_API_KEY,
    ...overrides,
  };
}

function group(
  id: string,
  nodeTargetIds: readonly string[],
  overrides: Partial<GroupShape> = {},
): GroupShape {
  return {
    id,
    name: id,
    enabled: true,
    model_pattern: "Qwen3.8-Flash-Next",
    members: nodeTargetIds.map((targetId) => ({ target_id: targetId, model_id: "" })),
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
    ...overrides,
  };
}

function pair(
  targets: readonly TargetConfig[],
  groups: readonly GroupShape[],
  overrides: Partial<ProxyPair> = {},
): ProxyPair {
  return {
    ...createDefaultProxyPair("logs"),
    id: PAIR_ID,
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
    ...overrides,
  };
}

/** Three different engines: the shape most gates need, with one group over all of them. */
function threeEngines(
  groups: readonly GroupShape[] = [group(GROUP_ID, ["node-a", "node-b", "node-c"])],
): ProxyPair {
  return pair(
    [
      target("node-a", "http://localhost:9393/v1"),
      target("node-b", "http://127.0.0.1:9494/v1"),
      target("node-c", "http://127.0.0.1:9595/v1"),
    ],
    groups,
  );
}

/** Two spellings of one engine, which is what `same_physical_key` refuses. */
function oneEngineTwoSpellings(): ProxyPair {
  return pair(
    [target("node-a", "http://localhost:9393/v1"), target("node-b", "http://127.0.0.1:9393/v1")],
    [group(GROUP_ID, ["node-a", "node-b"])],
  );
}

function publicPair(value: ProxyPair, running = true): PublicProxyPair {
  return { ...value, actual_listen_port: running ? 43_123 : null, running };
}

/**
 * The balancer lives in a slot so a test can replace it the way a pair stop and start does: the
 * route keeps its registration, and the runtime behind it is a different one with a different
 * epoch and an empty migration store.
 */
interface RuntimeSlot {
  balancer: LoadBalancer | undefined;
}

function source(pairs: readonly ProxyPair[], slot: RuntimeSlot): LoadBalancerAdminSource {
  return {
    bindingHistory: new BindingHistoryService(),
    loadBalancer: (pairId) => (pairId === PAIR_ID ? slot.balancer : undefined),
    loadMonitor: () => undefined,
    logRootForTarget: () => undefined,
    pairs: () => pairs.map((item) => publicPair(item, item.id === PAIR_ID)),
  };
}

interface Fixture {
  readonly balancer: LoadBalancer;
  readonly configured: ProxyPair;
  readonly server: ReturnType<typeof createAdminServer>;
  readonly slot: RuntimeSlot;
}

function fixture(
  options: {
    readonly pair?: ProxyPair;
    readonly maxMigrationRecords?: number;
  } = {},
): Fixture {
  const configured = options.pair ?? threeEngines();
  const balancer = new LoadBalancer(
    PAIR_ID,
    options.maxMigrationRecords === undefined
      ? {}
      : { maxMigrationRecords: options.maxMigrationRecords },
  );
  balancer.reconfigure(configured);
  const slot: RuntimeSlot = { balancer };
  const server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    loadBalancerService: createLoadBalancerAdminService(source([configured], slot)),
  });
  servers.push(server);
  return { balancer, configured, server, slot };
}

/** Replace the runtime the way a pair restart does: new epoch, empty store, no bindings. */
function restart(current: Fixture): LoadBalancer {
  const next = new LoadBalancer(PAIR_ID);
  next.reconfigure(current.configured);
  current.slot.balancer = next;
  return next;
}

/**
 * A chat request: the whole conversation travels in the body, which is what the state gate needs.
 * The cache key travels with the session, because two requests that share one cache key are the
 * same task to the affinity table, which is not what a test that wants two bindings asks for.
 */
function chatIdentity(sessionId: string, turn = "one") {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      messages: [{ role: "user", content: `${turn} ${PRIVATE_USER_TEXT}` }],
      prompt_cache_key: `${SESSION_MARKER}/${sessionId}`,
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/chat/completions",
  });
}

/** A chat request that brought no user content of its own, so the gate cannot prove it safe. */
function emptyChatIdentity(sessionId: string) {
  return taskIdentity({
    payload: { model: "Qwen3.8-Flash-Next", messages: [] },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/chat/completions",
  });
}

/** A Responses request: context may live upstream instead of travelling in the body. */
function responsesIdentity(sessionId: string, turn = "one", previousResponseId?: string) {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      input: [{ role: "user", content: `${turn} ${PRIVATE_BODY_TEXT}` }],
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

/** Put a task on a node without running it through the request path. */
function bind(
  balancer: LoadBalancer,
  identity: ReturnType<typeof taskIdentity>,
  targetId: string,
): LoadBalancerBindingEntry {
  const table = balancer.tableFor(GROUP_ID);
  if (table === undefined) {
    throw new Error(`The group ${GROUP_ID} must have an affinity table.`);
  }
  const binding = table.bind(identity, targetId);
  return bindingEntryOf(balancer, binding.id);
}

/** The one binding a test group holds, read from the projection. */
function onlyEntry(balancer: LoadBalancer): LoadBalancerBindingEntry {
  const snapshot = balancer.bindingSnapshot(GROUP_ID);
  if (snapshot === undefined) {
    throw new Error(`The group ${GROUP_ID} must have a binding table.`);
  }
  const entry = snapshot.entries[0];
  if (entry === undefined || snapshot.entries.length !== 1) {
    throw new Error(`The group ${GROUP_ID} must hold exactly one binding.`);
  }
  return entry;
}

/** The projection's row for one binding number. */
function bindingEntryOf(balancer: LoadBalancer, bindingId: number): LoadBalancerBindingEntry {
  const snapshot = balancer.bindingSnapshot(GROUP_ID);
  if (snapshot === undefined) {
    throw new Error(`The group ${GROUP_ID} must have a binding table.`);
  }
  const entry = snapshot.entries.find((item) => item.ref.bindingId === bindingId);
  if (entry === undefined) {
    throw new Error(`The projection must still list binding ${bindingId}.`);
  }
  return entry;
}

/** The configured group the reservation path is asked to place a request into. */
function groupOf(balancer: LoadBalancer): NonNullable<ReturnType<LoadBalancer["groupFor"]>> {
  const group = balancer.groupFor(GROUP_ID);
  if (group === undefined) {
    throw new Error(`The group ${GROUP_ID} must still be configured.`);
  }
  return group;
}

/** Reserve one request on a binding so the service has a boundary to wait for. */
function reserveOneRequest(
  balancer: LoadBalancer,
  identity: ReturnType<typeof taskIdentity>,
): { release(): void } {
  const reservation = balancer.plan({
    group: groupOf(balancer),
    identity,
    samples: EMPTY_LOAD_SAMPLES,
  });
  if (reservation === undefined) {
    throw new Error("The selector must have established a reservation.");
  }
  return { release: () => reservation.release() };
}

function freshSample(now: number, overrides: Partial<LoadSample> = {}): LoadSample {
  return {
    sampleSequence: 1,
    sampledAt: now,
    running: 0,
    waiting: 0,
    kvUsage: 0.2,
    source: "test",
    ...overrides,
  };
}

/** Every submit needs its own key, so a retry is always a deliberate act. */
let keys = 0;

/** What the client sees when it reads the list: the address it has to carry back. */
function moveBody(
  balancer: LoadBalancer,
  destinationTargetId: string,
  overrides: {
    readonly groupId?: string;
    readonly bindingId?: number;
    readonly incarnation?: number;
    readonly groupRevision?: number;
    readonly routingRevision?: number;
    readonly sourceTargetId?: string;
    readonly runtimeEpoch?: string;
    readonly idempotencyKey?: string;
    readonly reason?: string;
  } = {},
): AdminTaskMoveRequest {
  const groupId = overrides.groupId ?? GROUP_ID;
  const snapshot = balancer.bindingSnapshot(groupId);
  if (snapshot === undefined) {
    throw new Error(`The group ${groupId} must have a binding table.`);
  }
  const entry =
    overrides.bindingId === undefined
      ? snapshot.entries[0]
      : snapshot.entries.find((item) => item.ref.bindingId === overrides.bindingId);
  if (entry === undefined) {
    throw new Error(
      `The projection must still list binding ${overrides.bindingId ?? "the first"}.`,
    );
  }
  const groupRevision = balancer.groupRevision(groupId);
  if (groupRevision === undefined) {
    throw new Error(`The group ${groupId} must have a revision.`);
  }
  return {
    bindingId: entry.ref.bindingId,
    destinationTargetId,
    expectedRoutingRevision: overrides.routingRevision ?? entry.routingRevision,
    expectedSourceTargetId: overrides.sourceTargetId ?? entry.targetId,
    groupId,
    groupRevision: overrides.groupRevision ?? groupRevision,
    idempotencyKey: overrides.idempotencyKey ?? `move-key-${(keys += 1)}`,
    incarnation: overrides.incarnation ?? entry.ref.incarnation,
    pairId: PAIR_ID,
    runtimeEpoch: overrides.runtimeEpoch ?? balancer.runtimeEpoch,
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  };
}

interface Answer {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly payload: Record<string, unknown>;
}

function answerOf(statusCode: number, payload: string): Answer {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  const error = parsed["error"];
  if (isRecord(error)) {
    return {
      status: statusCode,
      code: typeof error["code"] === "string" ? error["code"] : undefined,
      message: typeof error["message"] === "string" ? error["message"] : undefined,
      payload: parsed,
    };
  }
  return { status: statusCode, code: undefined, message: undefined, payload: parsed };
}

async function submit(
  server: ReturnType<typeof createAdminServer>,
  body: unknown,
): Promise<Answer> {
  const response = await server.inject({
    method: "POST",
    url: "/api/load-balancer/task-moves",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return answerOf(response.statusCode, response.payload);
}

async function callOff(
  server: ReturnType<typeof createAdminServer>,
  operationId: string,
): Promise<Answer> {
  const response = await server.inject({
    method: "DELETE",
    url: `/api/load-balancer/task-moves/${operationId}`,
  });
  return answerOf(response.statusCode, response.payload);
}

/** The answer's own fields, read the same way in every test. */
function fields(answer: Answer): Record<string, unknown> {
  expect(answer.code).toBeUndefined();
  return answer.payload;
}

function numberOf(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  expect(typeof value).toBe("number");
  return value as number;
}

function textOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  expect(typeof value).toBe("string");
  return value as string;
}

/** The one record the runtime holds, whatever it became. */
function onlyRecord(balancer: LoadBalancer) {
  const records = balancer.migrationOperations();
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error("The store must hold one record.");
  }
  return record;
}

describe("[TRI-08] the manual move route on the service the proxy runs", () => {
  it("answers an applied move with 200, the two ends and the revision the write produced", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("move-1"), "node-a");

    const answer = await submit(server, moveBody(balancer, "node-b", { reason: "load moved" }));
    expect(answer.status).toBe(200);
    const body = fields(answer);
    expect(body["state"]).toBe("applied");
    expect(body["effect"]).toBe("next_request");
    expect(body["fromTargetId"]).toBe("node-a");
    expect(body["toTargetId"]).toBe("node-b");
    expect(numberOf(body, "routingRevision")).toBe(INITIAL_ROUTING_REVISION + 1);
    expect(numberOf(body, "inFlightAtRequest")).toBe(0);
    expect(body["runtimeEpoch"]).toBe(balancer.runtimeEpoch);
    expect(body["groupRevision"]).toBe(balancer.groupRevision(GROUP_ID));
    expect(textOf(body, "operationId")).toBe(onlyRecord(balancer).operationId);

    // The write went through the safe entry: the table's one rebind moved the target and
    // stepped the revision, and a manual move protects the binding from an automatic policy.
    expect(bindingEntryOf(balancer, numberOf(body, "bindingId")).targetId).toBe("node-b");
    expect(bindingEntryOf(balancer, numberOf(body, "bindingId")).routingRevision).toBe(
      INITIAL_ROUTING_REVISION + 1,
    );
    expect(
      bindingEntryOf(balancer, numberOf(body, "bindingId")).activity.manualProtection,
    ).toBeDefined();
    expect(onlyRecord(balancer).state).toBe("applied");
    expect(onlyRecord(balancer).requestedBy).toBe("manual");
    expect(onlyRecord(balancer).reason).toBe("load moved");
  });

  it("answers a binding with a request in flight with 202 and writes nothing", async () => {
    const { balancer, server } = fixture();
    const running = reserveOneRequest(balancer, chatIdentity("move-2"));
    const entry = onlyEntry(balancer);
    expect(entry.activity.inFlight).toBe(1);

    const answer = await submit(server, moveBody(balancer, "node-b"));
    expect(answer.status).toBe(202);
    const body = fields(answer);
    expect(body["state"]).toBe("pending_boundary");
    expect(body["effect"]).toBe("next_request");
    expect(numberOf(body, "inFlightAtRequest")).toBe(1);
    expect(numberOf(body, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);
    expect(body["fromTargetId"]).toBe(entry.targetId);
    expect(body["toTargetId"]).toBe("node-b");

    // Nothing moved, and the request that is running keeps the route it was given.
    expect(onlyEntry(balancer).targetId).toBe(entry.targetId);
    expect(onlyRecord(balancer).state).toBe("pending_boundary");
    expect(onlyRecord(balancer).appliedRoutingRevision).toBeUndefined();

    running.release();
  });

  it("answers a destination that already holds the binding with 200 already_there and no record", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("move-3"), "node-a");

    const first = await submit(server, moveBody(balancer, "node-a", { idempotencyKey: "key-3" }));
    expect(first.status).toBe(200);
    expect(first.payload["state"]).toBe("already_there");
    expect(first.payload["effect"]).toBe("none");
    expect(first.payload["operationId"]).toBeNull();
    expect(first.payload["fromTargetId"]).toBe("node-a");
    expect(first.payload["toTargetId"]).toBe("node-a");

    // Nothing was written, so there is nothing to record; a retry of the same key repeats the
    // answer that was given, and still records nothing.
    expect(balancer.migrationOperations()).toEqual([]);
    const retry = await submit(server, moveBody(balancer, "node-a", { idempotencyKey: "key-3" }));
    expect(retry.status).toBe(200);
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload["state"]).toBe("already_there");
    expect(balancer.migrationOperations()).toEqual([]);
  });

  it("binds a no-op answer to its key so a changed destination cannot move under it", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("noop-key"), "node-a");

    const first = await submit(
      server,
      moveBody(balancer, "node-a", { idempotencyKey: "key-noop" }),
    );
    expect(first.status).toBe(200);
    expect(first.payload["state"]).toBe("already_there");

    // The same instruction under the same key repeats the answer; nothing was written the first
    // time, so there is nothing to write again.
    const retry = await submit(
      server,
      moveBody(balancer, "node-a", { idempotencyKey: "key-noop" }),
    );
    expect(retry.status).toBe(200);
    expect(retry.payload).toEqual(first.payload);
    expect(onlyEntry(balancer).targetId).toBe("node-a");

    // The same key carrying only a different destination is a different instruction, so design
    // section 5.3 refuses it with 409 instead of replaying it: a no-op outcome binds its key and
    // its digest just like a move that wrote, and the route must not move under a spent key.
    const changed = await submit(
      server,
      moveBody(balancer, "node-b", { idempotencyKey: "key-noop" }),
    );
    expect(changed.status).toBe(409);
    expect(changed.code).toBe("idempotency_conflict");
    expect(changed.message).toContain("idempotency key");
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(onlyEntry(balancer).routingRevision).toBe(INITIAL_ROUTING_REVISION);
    expect(balancer.migrationOperations()).toEqual([]);
  });

  it("answers a no-op retry with its own receipt after an unrelated move carried the route away", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("noop-later"), "node-a");
    const noopBody = moveBody(balancer, "node-a", { idempotencyKey: "key-noop-later" });

    const first = await submit(server, noopBody);
    expect(first.status).toBe(200);
    expect(first.payload["toTargetId"]).toBe("node-a");
    expect(numberOf(first.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);

    // Another instruction, another key, moves the route away. The live binding is now on node-b.
    const later = await submit(server, moveBody(balancer, "node-b"));
    expect(later.status).toBe(200);
    expect(onlyEntry(balancer).targetId).toBe("node-b");
    expect(onlyEntry(balancer).routingRevision).toBe(INITIAL_ROUTING_REVISION + 1);

    // The no-op retry repeats the answer it was given and writes nothing: the receipt is not a
    // query about where the route stands now, so it neither reports the later destination nor
    // carries the later revision, and it certainly does not undo the later move.
    const retry = await submit(server, noopBody);
    expect(retry.status).toBe(200);
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload["effect"]).toBe("none");
    expect(retry.payload["toTargetId"]).toBe("node-a");
    expect(onlyEntry(balancer).targetId).toBe("node-b");
    expect(onlyEntry(balancer).routingRevision).toBe(INITIAL_ROUTING_REVISION + 1);
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("replays the same key, epoch and parameters with the first answer and moves the route once", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("move-4"), "node-a");
    const body = moveBody(balancer, "node-b", { idempotencyKey: "key-4" });

    const first = await submit(server, body);
    expect(first.status).toBe(200);
    const replay = await submit(server, body);
    expect(replay.status).toBe(200);
    // A repeated POST is a submission receipt, not a query about the operation's current state:
    // the whole body - state, effect, counts and versions - is the one the first submit answered
    // with, and the retry writes nothing.
    expect(replay.payload).toEqual(first.payload);
    expect(replay.payload["state"]).toBe("applied");
    expect(replay.payload["effect"]).toBe("next_request");

    // One retry does not move the route twice: one record, one revision step.
    const record = onlyRecord(balancer);
    expect(record.state).toBe("applied");
    expect(bindingEntryOf(balancer, record.bindingId).routingRevision).toBe(
      INITIAL_ROUTING_REVISION + 1,
    );

    // `reason` is an audit label, not an operation parameter: the same move worded differently
    // is still the same move, so it replays rather than being refused as a conflict. Every other
    // field is the first body's, which is what makes the digest the digest of that move.
    const reworded = await submit(server, {
      ...body,
      reason: "moved again, by hand",
    });
    expect(reworded.status).toBe(200);
    expect(reworded.payload["operationId"]).toBe(first.payload["operationId"]);
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("keeps a refused submission's refusal when the same key and parameters are retried", async () => {
    const { balancer, server } = fixture();
    bind(balancer, emptyChatIdentity("refused-retry"), "node-a");
    const body = moveBody(balancer, "node-b");

    const first = await submit(server, body);
    expect(first.status).toBe(422);
    expect(first.code).toBe("state_not_migratable");
    expect(first.message).toContain("no user content");

    // A retry of a submission the state gate refused is refused the same way again: the same
    // status, the same code and the same sentence, so a network retry cannot turn a refusal into
    // a success that reports a rejected state.
    const retry = await submit(server, body);
    expect(retry.status).toBe(422);
    expect(retry.code).toBe("state_not_migratable");
    expect(retry.message).toBe(first.message);
    expect(retry.payload["state"]).toBeUndefined();
    expect(retry.payload["operationId"]).toBeUndefined();

    // Nothing moved and nothing was recorded twice: the refusal is the only record this key opened.
    expect(balancer.migrationOperations()).toHaveLength(1);
    expect(onlyEntry(balancer).targetId).toBe("node-a");

    // The same key with a different destination is a different instruction, so it is refused as
    // spent rather than replayed - and it does not move the route either.
    const changed = await submit(server, { ...body, destinationTargetId: "node-c" });
    expect(changed.status).toBe(409);
    expect(changed.code).toBe("idempotency_conflict");
    expect(changed.message).toContain("idempotency key");
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("refuses a key reused by different parameters, and a lone groupRevision is enough to differ", async () => {
    const { balancer, server } = fixture();
    const first = bind(balancer, chatIdentity("move-5"), "node-a");
    const second = bind(balancer, chatIdentity("move-5-second", "a second turn"), "node-a");
    const base = moveBody(balancer, "node-b", { idempotencyKey: "key-5" });
    expect((await submit(server, base)).status).toBe(200);

    const variations: readonly Record<string, unknown>[] = [
      { ...base, destinationTargetId: "node-c" },
      { ...base, groupRevision: numberOf(base, "groupRevision") + 1 },
      { ...base, groupRevision: numberOf(base, "groupRevision") - 1 },
      { ...base, incarnation: numberOf(base, "incarnation") + 1 },
      { ...base, expectedRoutingRevision: numberOf(base, "expectedRoutingRevision") + 1 },
      { ...base, expectedSourceTargetId: "node-b" },
      { ...base, bindingId: second.ref.bindingId },
    ];
    const answered: string[] = [];
    for (const variation of variations) {
      const answer = await submit(server, variation);
      answered.push(`${answer.status} ${answer.code}`);
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("idempotency_conflict");
      expect(answer.message).toContain("idempotency key");
    }
    // Seven different bodies, one answer each: none of them was replayed as the first move.
    expect(new Set(answered).size).toBe(1);

    // None of them wrote, and none of them added a record to the store.
    expect(balancer.migrationOperations()).toHaveLength(1);
    expect(bindingEntryOf(balancer, first.ref.bindingId).targetId).toBe("node-b");
    expect(bindingEntryOf(balancer, second.ref.bindingId).targetId).toBe("node-a");
  });

  it("answers a retry from its receipt even after the group it names left the configuration", async () => {
    const { balancer, server, configured } = fixture();
    const identity = chatIdentity("removed-group-retry");
    bind(balancer, identity, "node-a");
    const held = reserveOneRequest(balancer, identity);
    const body = moveBody(balancer, "node-b", { idempotencyKey: "key-removed-group" });

    const first = await submit(server, body);
    expect(first.status).toBe(202);

    // The group leaves the configuration while the intent waits. The runtime epoch is unchanged
    // and the receipt is still held, so the retry of the first submission is answered that
    // submission: what the client is repeating is an instruction this runtime already answered,
    // not a fresh claim about what is configured now. A configuration check placed ahead of the
    // receipt would answer it with a 404 instead.
    configured.load_balancers.splice(0);
    balancer.reconfigure(configured);
    expect(balancer.groupRevision(GROUP_ID)).toBeUndefined();
    expect(onlyRecord(balancer).state).toBe("expired");

    const retry = await submit(server, body);
    expect(retry.status).toBe(202);
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload["state"]).toBe("pending_boundary");
    expect(retry.payload["operationId"]).toBe(first.payload["operationId"]);

    // The four not-found causes are still located before the receipt is consulted, because a
    // runtime that is gone or replaced holds no receipt to answer from: an epoch that is not this
    // one is still the 404 it was, with its own sentence.
    const oldEpoch = await submit(server, {
      ...body,
      runtimeEpoch: "epoch-of-a-replaced-runtime",
    });
    expect(oldEpoch.status).toBe(404);
    expect(oldEpoch.code).toBe("binding_not_found");
    expect(oldEpoch.message).toContain("runtime epoch");

    // The same key carrying only a different group is a different instruction, so it is refused
    // as spent rather than answered by the group that is not there: a key this runtime answered
    // is never handed to the configuration preflight to be turned into a not-found.
    const otherGroup = await submit(server, { ...body, groupId: "group-never-configured" });
    expect(otherGroup.status).toBe(409);
    expect(otherGroup.code).toBe("idempotency_conflict");
    expect(otherGroup.message).toContain("idempotency key");

    // An instruction this runtime has never answered still gets the configuration question, and
    // a group that is not there is named with the sentence this surface has always used.
    const brandNew = await submit(server, {
      ...body,
      groupId: "group-never-configured",
      idempotencyKey: "key-never-answered-here",
    });
    expect(brandNew.status).toBe(404);
    expect(brandNew.code).toBe("binding_not_found");
    expect(brandNew.message).toBe("Load balancer group not found.");

    // Nothing was written by any of these: the group left with its bindings, so there is no table
    // left to move, and the expired intent is still the only thing this runtime recorded.
    expect(balancer.bindingSnapshot(GROUP_ID)).toBeUndefined();
    expect(balancer.migrationOperations()).toHaveLength(1);

    held.release();
  });

  it("lets one page win when two hold the same old revision, and refuses the other as stale", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("move-6"), "node-a");
    // Both pages read the same revision before either writes; the second is therefore looking at
    // a route that no longer exists.
    const left = moveBody(balancer, "node-b", { idempotencyKey: "key-6-left" });
    const right = moveBody(balancer, "node-b", { idempotencyKey: "key-6-right" });

    const first = await submit(server, left);
    expect(first.status).toBe(200);
    const second = await submit(server, right);
    expect(second.status).toBe(409);
    expect(second.code).toBe("binding_stale");
    expect(second.message).toContain("routing revision");

    // The winner's write stands; the loser changed nothing, and no later request can be moved by
    // a reference that was already stale when it arrived.
    expect(onlyEntry(balancer).targetId).toBe("node-b");
    expect(balancer.migrationOperations().map((record) => record.state)).toEqual([
      "applied",
      "rejected",
    ]);
  });

  it("refuses the three stale versions with one 409 code and three different sentences", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("move-7"), "node-a");
    const current = moveBody(balancer, "node-b");
    const groupRevision = numberOf(current, "groupRevision");

    const staleGroup = await submit(
      server,
      moveBody(balancer, "node-b", { groupRevision: groupRevision + 1 }),
    );
    expect(staleGroup.status).toBe(409);
    expect(staleGroup.code).toBe("binding_stale");
    expect(staleGroup.message).toContain("group is at revision");

    const staleRouting = await submit(
      server,
      moveBody(balancer, "node-b", {
        routingRevision: numberOf(current, "expectedRoutingRevision") + 4,
      }),
    );
    expect(staleRouting.status).toBe(409);
    expect(staleRouting.code).toBe("binding_stale");
    expect(staleRouting.message).toContain("routing revision");

    const wrongSource = await submit(
      server,
      moveBody(balancer, "node-b", { sourceTargetId: "node-c" }),
    );
    expect(wrongSource.status).toBe(409);
    expect(wrongSource.code).toBe("binding_stale");
    expect(wrongSource.message).toContain("not on");

    // Three causes stay readable apart, and none of them wrote.
    expect(new Set([staleGroup.message, staleRouting.message, wrongSource.message]).size).toBe(3);
    expect(balancer.migrationOperations()).toHaveLength(3);
    expect(onlyEntry(balancer).targetId).toBe("node-a");
  });

  it("refuses every destination gate that is an eligibility conflict with 409 and its own sentence", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("gate-1"), "node-a");

    const outside = await submit(server, moveBody(balancer, "node-z"));
    expect(outside.status).toBe(409);
    expect(outside.code).toBe("target_not_eligible");
    expect(outside.message).toContain("not a member");

    const unknownFixture = fixture({
      pair: pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9494/v1"),
        ],
        [group(GROUP_ID, ["node-a", "node-b", "node-gone"])],
      ),
    });
    bind(unknownFixture.balancer, chatIdentity("gate-2"), "node-a");
    // A member of the group with no target behind it: the membership check passes, so the refusal
    // that comes back is the one that says the engine itself is gone.
    const unknown = await submit(
      unknownFixture.server,
      moveBody(unknownFixture.balancer, "node-gone"),
    );
    expect(unknown.status).toBe(409);
    expect(unknown.code).toBe("target_not_eligible");
    expect(unknown.message).toContain("no longer a target");

    const cooldownFixture = fixture();
    cooldownFixture.balancer.markCooldown("node-b", Date.now() + 30_000);
    bind(cooldownFixture.balancer, chatIdentity("gate-3"), "node-a");
    const cooling = await submit(
      cooldownFixture.server,
      moveBody(cooldownFixture.balancer, "node-b"),
    );
    expect(cooling.status).toBe(409);
    expect(cooling.code).toBe("target_not_eligible");
    expect(cooling.message).toContain("cooling down");

    const asleepFixture = fixture();
    asleepFixture.balancer.setSample("node-b", freshSample(Date.now(), { awake: false }));
    bind(asleepFixture.balancer, chatIdentity("gate-4"), "node-a");
    const asleep = await submit(asleepFixture.server, moveBody(asleepFixture.balancer, "node-b"));
    expect(asleep.status).toBe(409);
    expect(asleep.code).toBe("target_not_eligible");
    expect(asleep.message).toContain("asleep");

    const disabledFixture = fixture({
      pair: pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9494/v1", { enabled: false }),
          target("node-c", "http://127.0.0.1:9595/v1"),
        ],
        [group(GROUP_ID, ["node-a", "node-b", "node-c"])],
      ),
    });
    bind(disabledFixture.balancer, chatIdentity("gate-5"), "node-a");
    const disabled = await submit(
      disabledFixture.server,
      moveBody(disabledFixture.balancer, "node-b"),
    );
    expect(disabled.status).toBe(409);
    expect(disabled.code).toBe("target_not_eligible");
    expect(disabled.message).toContain("disabled");

    const spellingFixture = fixture({ pair: oneEngineTwoSpellings() });
    bind(spellingFixture.balancer, chatIdentity("gate-6"), "node-a");
    const sameEngine = await submit(
      spellingFixture.server,
      moveBody(spellingFixture.balancer, "node-b"),
    );
    expect(sameEngine.status).toBe(409);
    expect(sameEngine.code).toBe("target_not_eligible");
    expect(sameEngine.message).toContain("another spelling");

    const modelFixture = fixture({
      pair: pair(
        [
          target("node-a", "http://localhost:9393/v1"),
          target("node-b", "http://127.0.0.1:9494/v1"),
        ],
        [
          {
            ...group(GROUP_ID, ["node-a", "node-b"]),
            members: [
              { target_id: "node-a", model_id: "" },
              { target_id: "node-b", model_id: "other-model" },
            ],
          },
        ],
      ),
    });
    bind(modelFixture.balancer, chatIdentity("gate-7"), "node-a");
    const wrongModel = await submit(modelFixture.server, moveBody(modelFixture.balancer, "node-b"));
    // Design section 6.2 puts model compatibility with the safety refusals, not with the
    // eligibility conflicts: what cannot be proven safe is answered 422 `state_not_migratable`.
    expect(wrongModel.status).toBe(422);
    expect(wrongModel.code).toBe("state_not_migratable");
    expect(wrongModel.message).toContain("model id");

    // Six destination conditions, six sentences, one conflict code: a client can tell which
    // condition refused it without guessing, and none of them touched the route. The model
    // condition is refused as unprocessable by design, with its own sentence.
    const eligibility = [outside, unknown, cooling, asleep, disabled, sameEngine];
    expect(new Set(eligibility.map((answer) => answer.message)).size).toBe(6);
    for (const answer of eligibility) {
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("target_not_eligible");
      expect(answer.payload["state"]).toBeUndefined();
    }
    expect(new Set([...eligibility.map((a) => a.message), wrongModel.message]).size).toBe(7);
    for (const answer of [...eligibility, wrongModel]) {
      expect(answer.payload["state"]).toBeUndefined();
    }
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(onlyEntry(modelFixture.balancer).targetId).toBe("node-a");
  });

  it("refuses the two state gates with 422 state_not_migratable", async () => {
    const { balancer, server } = fixture();
    bind(balancer, responsesIdentity("state-1", "one", "resp-1"), "node-a");

    const responseDependent = await submit(server, moveBody(balancer, "node-b"));
    expect(responseDependent.status).toBe(422);
    expect(responseDependent.code).toBe("state_not_migratable");
    expect(responseDependent.message).toContain("response id");

    const unknownFixture = fixture();
    bind(unknownFixture.balancer, responsesIdentity("state-2"), "node-a");
    const unknownState = await submit(
      unknownFixture.server,
      moveBody(unknownFixture.balancer, "node-b"),
    );
    expect(unknownState.status).toBe(422);
    expect(unknownState.code).toBe("state_not_migratable");
    expect(unknownState.message).toContain("cannot prove");

    const noContentFixture = fixture();
    bind(noContentFixture.balancer, emptyChatIdentity("state-3"), "node-a");
    const noContent = await submit(
      noContentFixture.server,
      moveBody(noContentFixture.balancer, "node-b"),
    );
    expect(noContent.status).toBe(422);
    expect(noContent.code).toBe("state_not_migratable");
    expect(noContent.message).toContain("no user content");

    // A refusal the state gate found is not a parameter error and not a conflict, and the three
    // causes are readable apart.
    expect(new Set([responseDependent.message, unknownState.message, noContent.message]).size).toBe(
      3,
    );
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(onlyEntry(unknownFixture.balancer).targetId).toBe("node-a");
    expect(onlyEntry(noContentFixture.balancer).targetId).toBe("node-a");
  });

  it("answers a store that cannot take new work with 503 and still reports a refusal it found", async () => {
    const { balancer, server } = fixture({ maxMigrationRecords: 1 });
    bind(balancer, chatIdentity("full-1"), "node-a");

    const applied = await submit(server, moveBody(balancer, "node-b"));
    expect(applied.status).toBe(200);

    // The record that is still worth reporting occupies the only slot, so a move that would
    // have gone through is refused for the store's own limit. The design fixes this as 503:
    // retrying later can help, and it is not the user's parameters that are wrong.
    const second = await submit(server, moveBody(balancer, "node-c"));
    expect(second.status).toBe(503);
    expect(second.code).toBe("migration_backlog_full");
    expect(second.message).toContain("as many migration records as it is allowed to");

    // A refusal the gates already found is still the answer the caller needs, so the store's
    // limit does not overwrite it.
    balancer.markCooldown("node-c", Date.now() + 30_000);
    const refused = await submit(server, moveBody(balancer, "node-c"));
    expect(refused.status).toBe(409);
    // Every target condition shares one code, as the design fixes it; the sentence is what tells
    // the user which condition it was.
    expect(refused.code).toBe("target_not_eligible");
    expect(refused.message).toContain("cooling down");

    // Nothing was written while the store was full.
    expect(balancer.migrationOperations()).toHaveLength(1);
    expect(onlyEntry(balancer).targetId).toBe("node-b");
  });

  it("refuses a no-op the runtime cannot remember with 503 instead of a receipt it cannot keep", async () => {
    const { balancer, server } = fixture({ maxMigrationRecords: 1 });
    const busy = chatIdentity("capacity-noop");
    const parkedBinding = bind(balancer, busy, "node-a");
    const held = reserveOneRequest(balancer, busy);
    const heldBody = moveBody(balancer, "node-b", {
      bindingId: parkedBinding.ref.bindingId,
      idempotencyKey: "key-held-answer",
    });
    const parked = await submit(server, heldBody);
    expect(parked.status).toBe(202);

    // The one answer this runtime can afford to hold belongs to an intent that may still move,
    // so there is nothing to give up for a new key. The no-op that would have been answered under
    // that key is refused with the store's own limit instead of a 200 whose receipt was dropped
    // on the floor: a success nobody can replay is not an idempotent success, and the same key
    // with a different destination would have moved the route.
    const idleBinding = bind(
      balancer,
      chatIdentity("capacity-noop-idle", "a second turn"),
      "node-a",
    );
    const noopBody = moveBody(balancer, "node-a", {
      bindingId: idleBinding.ref.bindingId,
      idempotencyKey: "key-cannot-be-remembered",
    });
    const noop = await submit(server, noopBody);
    expect(noop.status).toBe(503);
    expect(noop.code).toBe("migration_backlog_full");
    expect(noop.message).toContain("cannot promise to remember this idempotency key");

    // Nothing was written: the idle binding is on the node it was bound to at the revision it was
    // created with, and the only record is still the parked intent.
    expect(bindingEntryOf(balancer, idleBinding.ref.bindingId).targetId).toBe("node-a");
    expect(bindingEntryOf(balancer, idleBinding.ref.bindingId).routingRevision).toBe(
      INITIAL_ROUTING_REVISION,
    );
    expect(onlyRecord(balancer).state).toBe("pending_boundary");

    // The answer that was kept is still replayable: making room was never paid for by dropping a
    // live intent's receipt.
    const retryHeld = await submit(server, heldBody);
    expect(retryHeld.status).toBe(202);
    expect(retryHeld.payload).toEqual(parked.payload);

    // Once the intent has ended there is something the index can give up, so the same
    // instruction is answered with a receipt this runtime can keep: a retry repeats it, and the
    // same key with a changed destination is refused instead of allowed to move the route.
    const cancelled = await callOff(server, textOf(parked.payload, "operationId"));
    expect(cancelled.status).toBe(200);
    held.release();

    const remembered = await submit(server, noopBody);
    expect(remembered.status).toBe(200);
    expect(remembered.payload["state"]).toBe("already_there");
    expect(remembered.payload["operationId"]).toBeNull();
    const replayed = await submit(server, noopBody);
    expect(replayed.status).toBe(200);
    expect(replayed.payload).toEqual(remembered.payload);

    const changed = await submit(server, { ...noopBody, destinationTargetId: "node-b" });
    expect(changed.status).toBe(409);
    expect(changed.code).toBe("idempotency_conflict");
    expect(bindingEntryOf(balancer, idleBinding.ref.bindingId).targetId).toBe("node-a");
    expect(bindingEntryOf(balancer, idleBinding.ref.bindingId).routingRevision).toBe(
      INITIAL_ROUTING_REVISION,
    );
    // The cap held throughout: one record, never a second one written under a full store.
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("calls off a parked intent with 200 cancelled and leaves the route where it was", async () => {
    const { balancer, server } = fixture();
    const running = reserveOneRequest(balancer, chatIdentity("cancel-1"));
    const parked = await submit(server, moveBody(balancer, "node-b"));
    expect(parked.status).toBe(202);
    const operationId = textOf(parked.payload, "operationId");

    const cancelled = await callOff(server, operationId);
    expect(cancelled.status).toBe(200);
    const body = fields(cancelled);
    expect(body["state"]).toBe("cancelled");
    expect(body["effect"]).toBe("none");
    expect(body["operationId"]).toBe(operationId);
    expect(body["runtimeEpoch"]).toBe(balancer.runtimeEpoch);
    expect(numberOf(body, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);

    expect(onlyRecord(balancer).state).toBe("cancelled");
    expect(onlyEntry(balancer).targetId).not.toBe("node-b");

    // The boundary the intent was waiting for arrives anyway; a cancelled record is terminal,
    // so the release writes nothing.
    running.release();
    expect(onlyRecord(balancer).state).toBe("cancelled");
    expect(onlyEntry(balancer).targetId).not.toBe("node-b");
  });

  it("refuses to call off an applied move and points the user at a move back", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("cancel-2"), "node-a");
    const applied = await submit(server, moveBody(balancer, "node-b"));
    expect(applied.status).toBe(200);

    const cancelled = await callOff(server, textOf(applied.payload, "operationId"));
    expect(cancelled.status).toBe(409);
    expect(cancelled.code).toBe("operation_already_applied");
    expect(cancelled.message).toContain("Submit a move back instead");

    // The route did change, and a cancel cannot pretend otherwise: the binding stays where the
    // write left it, and the record keeps the revision the write produced.
    expect(onlyEntry(balancer).targetId).toBe("node-b");
    const record = onlyRecord(balancer);
    expect(record.state).toBe("applied");
    expect(record.appliedRoutingRevision).toBe(INITIAL_ROUTING_REVISION + 1);
  });

  it("calls a parked intent off when the group revision moves, and the cancel names it expired", async () => {
    const { balancer, server, configured } = fixture();
    const running = reserveOneRequest(balancer, chatIdentity("expire-1"));
    const parked = await submit(server, moveBody(balancer, "node-b"));
    expect(parked.status).toBe(202);

    // A save that changed where a member forwards moves the group revision, which is what makes
    // the intent registered under the old number stale.
    const revisionBefore = balancer.groupRevision(GROUP_ID) ?? 0;
    balancer.reconfigure(
      pair(configured.targets, configured.load_balancers, {
        targets: configured.targets.map((item) =>
          item.id === "node-b" ? { ...item, target_url: "http://127.0.0.1:9999/v1" } : item,
        ),
      }),
    );
    expect(balancer.groupRevision(GROUP_ID)).toBe(revisionBefore + 1);
    expect(onlyRecord(balancer).state).toBe("expired");

    const cancelled = await callOff(server, textOf(parked.payload, "operationId"));
    expect(cancelled.status).toBe(409);
    expect(cancelled.code).toBe("operation_expired");
    expect(cancelled.message).toContain("revision");

    running.release();
    expect(onlyEntry(balancer).targetId).toBe("node-a");
  });

  it("answers a failover, a removed group, a cooled-down destination and a pair stop each with the name of what happened", async () => {
    // A failover outranks a parked intent: it takes the route first, so the intent is called off
    // before the boundary it was waiting for could run.
    const failoverFixture = fixture();
    const parkedOn = bind(failoverFixture.balancer, chatIdentity("expire-2"), "node-a");
    const running = reserveOneRequest(failoverFixture.balancer, chatIdentity("expire-2"));
    const parked = await submit(
      failoverFixture.server,
      moveBody(failoverFixture.balancer, "node-b"),
    );
    const operationId = textOf(parked.payload, "operationId");
    failoverFixture.balancer.invalidateMigrationsFor(parkedOn.ref, "failover");
    expect(onlyRecord(failoverFixture.balancer).state).toBe("expired");
    const failoverAnswer = await callOff(failoverFixture.server, operationId);
    expect(failoverAnswer.status).toBe(409);
    expect(failoverAnswer.code).toBe("operation_expired");
    expect(failoverAnswer.message).toContain("failover");
    running.release();

    // A group that left the configuration takes its bindings with it, so the intent has nothing
    // to move.
    const removedFixture = fixture();
    const removedRunning = reserveOneRequest(removedFixture.balancer, chatIdentity("expire-3"));
    const removedParked = await submit(
      removedFixture.server,
      moveBody(removedFixture.balancer, "node-b"),
    );
    removedFixture.balancer.reconfigure(pair(removedFixture.configured.targets, []));
    expect(onlyRecord(removedFixture.balancer).state).toBe("expired");
    const removedAnswer = await callOff(
      removedFixture.server,
      textOf(removedParked.payload, "operationId"),
    );
    expect(removedAnswer.status).toBe(409);
    expect(removedAnswer.code).toBe("operation_expired");
    expect(removedAnswer.message).toContain("left the table");
    removedRunning.release();

    // The destination the intent was opened for stops being eligible. The request coming back is
    // the boundary that would have written the move, and the condition refuses it there: the
    // intent is called off with the sentence that says why, and the route stays where it was.
    const destinationFixture = fixture();
    const destinationRunning = reserveOneRequest(
      destinationFixture.balancer,
      chatIdentity("expire-4"),
    );
    const destinationParked = await submit(
      destinationFixture.server,
      moveBody(destinationFixture.balancer, "node-b"),
    );
    destinationFixture.balancer.markCooldown("node-b", Date.now() + 30_000);
    destinationRunning.release();
    expect(onlyRecord(destinationFixture.balancer).state).toBe("expired");
    const destinationAnswer = await callOff(
      destinationFixture.server,
      textOf(destinationParked.payload, "operationId"),
    );
    expect(destinationAnswer.status).toBe(409);
    expect(destinationAnswer.code).toBe("operation_expired");
    expect(destinationAnswer.message).toContain("cooling down");
    expect(onlyEntry(destinationFixture.balancer).targetId).toBe("node-a");

    // A pair stop drops the records with the runtime, so a cancel of an old operation finds
    // nothing rather than reporting a route that no longer exists as cancelled.
    const stoppedFixture = fixture();
    const stoppedRunning = reserveOneRequest(stoppedFixture.balancer, chatIdentity("expire-5"));
    const stoppedParked = await submit(
      stoppedFixture.server,
      moveBody(stoppedFixture.balancer, "node-b"),
    );
    stoppedFixture.balancer.clear();
    const stoppedAnswer = await callOff(
      stoppedFixture.server,
      textOf(stoppedParked.payload, "operationId"),
    );
    expect(stoppedAnswer.status).toBe(404);
    expect(stoppedAnswer.code).toBe("operation_not_found");
    expect(stoppedFixture.balancer.migrationOperations()).toEqual([]);
    stoppedRunning.release();
  });

  it("drops the records on a restart, so an old key and an old id both find nothing", async () => {
    const current = fixture();
    bind(current.balancer, chatIdentity("restart-1"), "node-a");
    const body = moveBody(current.balancer, "node-b", { idempotencyKey: "key-restart" });
    const applied = await submit(current.server, body);
    expect(applied.status).toBe(200);
    const oldOperationId = textOf(applied.payload, "operationId");
    const oldEpoch = textOf(applied.payload, "runtimeEpoch");

    // The next start is a new runtime: new epoch, empty store, and the old binding number is not
    // the same binding.
    const next = restart(current);
    bind(next, chatIdentity("restart-1"), "node-a");
    const oldEpochBody = await submit(
      current.server,
      moveBody(next, "node-b", { runtimeEpoch: oldEpoch, idempotencyKey: "key-restart" }),
    );
    expect(oldEpochBody.status).toBe(404);
    expect(oldEpochBody.code).toBe("binding_not_found");
    expect(oldEpochBody.message).toContain("runtime epoch");

    // The operation the old runtime answered with is gone with it, so a cancel cannot be aimed at
    // the new route.
    const cancelled = await callOff(current.server, oldOperationId);
    expect(cancelled.status).toBe(404);
    expect(cancelled.code).toBe("operation_not_found");

    // The same key under the new epoch finds no record to replay: it is evaluated fresh rather
    // than acting on state the old runtime never checked.
    const fresh = await submit(
      current.server,
      moveBody(next, "node-b", { idempotencyKey: "key-restart" }),
    );
    expect(fresh.status).toBe(200);
    expect(fresh.payload["operationId"]).not.toBe(oldOperationId);
    expect(fresh.payload["runtimeEpoch"]).toBe(next.runtimeEpoch);
    expect(next.migrationOperations().map((record) => record.state)).toEqual(["applied"]);
  });

  it("refuses a cancel of a record that was refused or already called off, by its own name", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("cancel-3"), "node-a");

    const refused = await submit(server, moveBody(balancer, "node-z"));
    expect(refused.status).toBe(409);
    expect(refused.payload["operationId"]).toBeUndefined();
    // The refusal is recorded so a same-key retry can be answered from it, and an id that was
    // never issued cannot be called off.
    expect(balancer.migrationOperations().map((record) => record.state)).toEqual(["rejected"]);
    const neverIssued = await callOff(server, "operation-that-was-never-registered");
    expect(neverIssued.status).toBe(404);
    expect(neverIssued.code).toBe("operation_not_found");

    // A parked intent called off twice is refused with a sentence that says what the record
    // already is, rather than a second answer that pretends the cancel was undone.
    const running = reserveOneRequest(balancer, chatIdentity("cancel-3"));
    const parked = await submit(server, moveBody(balancer, "node-b"));
    expect(parked.status).toBe(202);
    const first = await callOff(server, textOf(parked.payload, "operationId"));
    expect(first.status).toBe(200);
    const second = await callOff(server, textOf(parked.payload, "operationId"));
    expect(second.status).toBe(409);
    expect(second.code).toBe("operation_not_cancellable");
    expect(second.message).toContain("cancelled");
    running.release();
    expect(balancer.migrationOperations().map((record) => record.state)).toEqual([
      "rejected",
      "cancelled",
    ]);
  });

  it("reports an observed move only once the request path proves the destination received it", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("observe-1"), "node-a");
    const observedBody = moveBody(balancer, "node-b", { idempotencyKey: "key-obs" });
    const applied = await submit(server, observedBody);
    expect(applied.status).toBe(200);

    // Planning the next request onto the destination proves nothing by itself: the request still
    // has to reach that engine before the move can be called observed.
    const group = groupOf(balancer);
    const nextRequest = balancer.plan({
      group,
      identity: chatIdentity("observe-1"),
      samples: EMPTY_LOAD_SAMPLES,
    });
    expect(nextRequest?.decision.targetId).toBe("node-b");
    expect(onlyRecord(balancer).state).toBe("applied");
    expect(onlyRecord(balancer).observedAt).toBeUndefined();

    // The request path confirms the destination answered the connection, and hands back the
    // material the stored route is written from: source, destination, who asked, the operation
    // and the revision.
    const meta = nextRequest?.confirmRouted();
    expect(meta).toBeDefined();
    expect(meta?.operationId).toBe(applied.payload["operationId"]);
    expect(meta?.movedBy).toBe("manual");
    expect(meta?.movedFrom).toBe("node-a");
    expect(meta?.movedTo).toBe("node-b");
    expect(meta?.routingRevision).toBe(INITIAL_ROUTING_REVISION + 1);

    expect(onlyRecord(balancer).state).toBe("observed");
    nextRequest?.release();

    // A second confirmation proves nothing further: `observed` is terminal and is never rewritten.
    expect(nextRequest?.confirmRouted()).toBeUndefined();
    expect(onlyRecord(balancer).state).toBe("observed");

    // A retry of the same key is answered the receipt the submit was answered with - the applied
    // answer, its own effect, its own revision - while the operation's current state stays
    // `observed` for a reader that asks for it. Nothing is written again.
    const replay = await submit(server, observedBody);
    expect(replay.status).toBe(200);
    expect(replay.payload).toEqual(applied.payload);
    expect(replay.payload["state"]).toBe("applied");
    expect(replay.payload["effect"]).toBe("next_request");
    expect(numberOf(replay.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION + 1);
    expect(onlyRecord(balancer).state).toBe("observed");
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("answers a parked submission with its own 202 after a lifecycle event called it off", async () => {
    const { balancer, server } = fixture();
    const identity = chatIdentity("expired-replay");
    bind(balancer, identity, "node-a");
    const running = reserveOneRequest(balancer, identity);
    const body = moveBody(balancer, "node-b");

    const parked = await submit(server, body);
    expect(parked.status).toBe(202);
    const parkedFields = fields(parked);
    const entry = onlyEntry(balancer);

    // A failover is an availability action and outranks the parked intent: it calls the intent off
    // before the boundary it was waiting for could run.
    balancer.invalidateMigrationsFor(entry.ref, "failover");
    expect(onlyRecord(balancer).state).toBe("expired");

    // The retry is answered the submission's own receipt: still 202, still `pending_boundary`,
    // still the count and the revision the submit was answered with. Nothing turns a called-off
    // intent into a 200, and nothing re-evaluates the route.
    const retry = await submit(server, body);
    expect(retry.status).toBe(202);
    expect(retry.code).toBeUndefined();
    expect(retry.payload).toEqual(parkedFields);
    expect(retry.payload["state"]).toBe("pending_boundary");
    expect(retry.payload["effect"]).toBe("next_request");
    expect(numberOf(retry.payload, "inFlightAtRequest")).toBe(1);
    expect(numberOf(retry.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(balancer.migrationOperations()).toHaveLength(1);
    expect(onlyRecord(balancer).state).toBe("expired");
    running.release();
  });

  it("answers a parked submit's retry with its own 202 after the boundary applied the intent", async () => {
    const { balancer, server } = fixture();
    const identity = chatIdentity("applied-receipt");
    bind(balancer, identity, "node-a");
    const running = reserveOneRequest(balancer, identity);
    const body = moveBody(balancer, "node-b");

    const parked = await submit(server, body);
    expect(parked.status).toBe(202);
    const parkedFields = fields(parked);

    // The request coming back is the boundary the intent waited for, and the route moves.
    running.release();
    expect(onlyRecord(balancer).state).toBe("applied");
    expect(onlyEntry(balancer).targetId).toBe("node-b");
    expect(onlyEntry(balancer).routingRevision).toBe(INITIAL_ROUTING_REVISION + 1);

    // The retry is still answered the submission's own receipt: 202, `pending_boundary`, the
    // count and the revision it was answered with. The route moved afterwards, and that is not
    // this answer's news.
    const retry = await submit(server, body);
    expect(retry.status).toBe(202);
    expect(retry.payload).toEqual(parkedFields);
    expect(retry.payload["state"]).toBe("pending_boundary");
    expect(numberOf(retry.payload, "inFlightAtRequest")).toBe(1);
    expect(numberOf(retry.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);
    expect(balancer.migrationOperations()).toHaveLength(1);

    // Nor is a landing: once the destination is proven to have received a request, the receipt
    // is still the same 202 the submit was answered with.
    const nextRequest = balancer.plan({
      group: groupOf(balancer),
      identity,
      samples: EMPTY_LOAD_SAMPLES,
    });
    expect(nextRequest?.decision.targetId).toBe("node-b");
    expect(nextRequest?.confirmRouted()).toBeDefined();
    expect(onlyRecord(balancer).state).toBe("observed");
    nextRequest?.release();

    const afterLanding = await submit(server, body);
    expect(afterLanding.status).toBe(202);
    expect(afterLanding.payload).toEqual(parkedFields);
    expect(afterLanding.payload["state"]).toBe("pending_boundary");
    expect(onlyRecord(balancer).state).toBe("observed");
    expect(balancer.migrationOperations()).toHaveLength(1);
  });

  it("answers a parked submit's retry with its own 202 after the intent was called off", async () => {
    const { balancer, server } = fixture();
    const identity = chatIdentity("cancelled-receipt");
    bind(balancer, identity, "node-a");
    const running = reserveOneRequest(balancer, identity);
    const body = moveBody(balancer, "node-b");

    const parked = await submit(server, body);
    expect(parked.status).toBe(202);
    const parkedFields = fields(parked);
    const operationId = textOf(parked.payload, "operationId");

    // The user calls the intent off, and the cancel is answered `cancelled`. That is the intent's
    // own news; it is not a reason to answer the original submit differently.
    const cancelled = await callOff(server, operationId);
    expect(cancelled.status).toBe(200);
    expect(fields(cancelled)["state"]).toBe("cancelled");
    expect(onlyRecord(balancer).state).toBe("cancelled");

    const retry = await submit(server, body);
    expect(retry.status).toBe(202);
    expect(retry.code).toBeUndefined();
    expect(retry.payload).toEqual(parkedFields);
    expect(retry.payload["state"]).toBe("pending_boundary");
    expect(onlyRecord(balancer).state).toBe("cancelled");
    // Nothing was written by the retry, and the route is still where the refusal left it.
    expect(onlyEntry(balancer).targetId).toBe("node-a");
    expect(balancer.migrationOperations()).toHaveLength(1);
    running.release();
  });

  it("repeats the count a submit proved instead of a count read off a binding that is gone", async () => {
    const { balancer, server } = fixture();
    const identity = chatIdentity("vanished-receipt");
    bind(balancer, identity, "node-a");
    const running = reserveOneRequest(balancer, identity);
    const body = moveBody(balancer, "node-b");

    const parked = await submit(server, body);
    expect(parked.status).toBe(202);
    expect(numberOf(parked.payload, "inFlightAtRequest")).toBe(1);

    // The binding leaves the table while its request is still running, so there is no live
    // binding for a retry to read. A retry still repeats what the submit proved - one request
    // running, this binding id, the revision the intent was opened under - rather than reading a
    // route that no longer exists and reporting the absence as zero.
    const table = balancer.tableFor(GROUP_ID);
    if (table === undefined) {
      throw new Error(`The group ${GROUP_ID} must have a binding table.`);
    }
    const binding = table.bindingForId(numberOf(parked.payload, "bindingId"));
    if (binding === undefined) {
      throw new Error("The binding must still be in the table.");
    }
    table.remove(binding);
    expect(balancer.bindingSnapshot(GROUP_ID)?.entries ?? []).toHaveLength(0);

    const retry = await submit(server, body);
    expect(retry.status).toBe(202);
    expect(retry.payload).toEqual(parked.payload);
    expect(numberOf(retry.payload, "inFlightAtRequest")).toBe(1);
    expect(numberOf(retry.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION);
    expect(balancer.migrationOperations()).toHaveLength(1);
    expect(onlyRecord(balancer).state).toBe("pending_boundary");

    // The request coming back is the boundary the intent was waiting for, and the attempt
    // re-resolves the reference and finds nothing: the intent says the binding left instead of
    // being written against whatever reused the number.
    running.release();
    expect(onlyRecord(balancer).state).toBe("expired");
    expect(onlyRecord(balancer).endReason).toContain("left the table");
    expect(onlyRecord(balancer).appliedRoutingRevision).toBeUndefined();
    expect(balancer.inFlight("node-b")).toBe(0);
  });

  it("answers the first receipt with its own revision when a later move has already moved on", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("versions"), "node-a");
    const firstBody = moveBody(balancer, "node-b");

    const first = await submit(server, firstBody);
    expect(first.status).toBe(200);
    expect(numberOf(first.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION + 1);

    // A second, different instruction carries the route further.
    const second = await submit(server, moveBody(balancer, "node-c"));
    expect(second.status).toBe(200);
    expect(numberOf(second.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION + 2);
    expect(onlyEntry(balancer).targetId).toBe("node-c");

    // The retry of the first instruction repeats that instruction's own answer. The later move's
    // revision belongs to node-c, so it must not be stamped onto the first receipt.
    const replay = await submit(server, firstBody);
    expect(replay.status).toBe(200);
    expect(replay.payload).toEqual(first.payload);
    expect(numberOf(replay.payload, "routingRevision")).toBe(INITIAL_ROUTING_REVISION + 1);
    expect(replay.payload["toTargetId"]).toBe("node-b");
    expect(replay.payload["operationId"]).not.toBe(second.payload["operationId"]);
    expect(onlyEntry(balancer).targetId).toBe("node-c");
    expect(balancer.migrationOperations()).toHaveLength(2);
  });

  it("keeps request content, session material and upstream keys out of every answer", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("leak-1"), "node-a");

    const applied = await submit(
      server,
      moveBody(balancer, "node-b", { reason: "moved because of the load share" }),
    );
    expect(applied.status).toBe(200);
    const wire = JSON.stringify(applied.payload);
    // The session the binding was built from, the text in its body, the cache key that travels
    // with the client and the upstream key the node carries: none of them may appear.
    for (const secret of [
      PRIVATE_USER_TEXT,
      PRIVATE_BODY_TEXT,
      SECRET_API_KEY,
      SESSION_MARKER,
      "leak-1",
    ]) {
      expect(wire).not.toContain(secret);
    }
    // The answer carries the design's fields and the two versions a client needs to notice a
    // different runtime; nothing else travels.
    expect(Object.keys(applied.payload).sort()).toEqual(
      [
        "bindingId",
        "effect",
        "fromTargetId",
        "groupRevision",
        "inFlightAtRequest",
        "operationId",
        "routingRevision",
        "runtimeEpoch",
        "state",
        "toTargetId",
      ].sort(),
    );

    // A refusal says why in its own sentence, and its body is still just `{ code, message }`.
    const refused = await submit(server, moveBody(balancer, "node-b", { routingRevision: 9 }));
    expect(refused.status).toBe(409);
    expect(Object.keys(refused.payload)).toEqual(["error"]);
    expect(Object.keys(refused.payload["error"] ?? {})).toEqual(["code", "message"]);
    expect(JSON.stringify(refused.payload)).not.toContain(PRIVATE_USER_TEXT);
  });

  it("accepts a reason up to the audit label cap and refuses one longer", async () => {
    const { balancer, server } = fixture();
    bind(balancer, chatIdentity("reason-1"), "node-a");

    const atCap = await submit(
      server,
      moveBody(balancer, "node-b", { reason: "r".repeat(MAX_MIGRATION_REASON_CHARS) }),
    );
    expect(atCap.status).toBe(200);
    expect(onlyRecord(balancer).reason).toHaveLength(MAX_MIGRATION_REASON_CHARS);

    const overCap = await submit(
      server,
      moveBody(balancer, "node-c", { reason: "r".repeat(MAX_MIGRATION_REASON_CHARS + 1) }),
    );
    expect(overCap.status).toBe(400);
    expect(overCap.code).toBe("FST_ERR_VALIDATION");
    expect(balancer.migrationOperations()).toHaveLength(1);
  });
});
