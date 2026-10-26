import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";

import {
  LoadBalancer,
  MAX_RECENT_REQUEST_STARTS,
  taskIdentity,
  type BindingActivity,
  type LoadBalancerBindingEntry,
  type LoadBalancerReservation,
} from "../../src/proxy/index.js";

/**
 * TRI-02 puts a per-binding activity ledger inside the load balancer and gives the
 * future node list a side-effect-free projection. These cases pin the ledger lifecycle:
 * counting lives at reservation establishment and release, late and duplicate releases
 * can neither go negative nor touch a binding that reused the number, and evicted
 * bindings keep their ledger only while something is still in flight.
 */

type GroupShape = ProxyPair["load_balancers"][number];

function target(id: string, url: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: url,
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

function pair(targets: readonly TargetConfig[], groups: readonly GroupShape[]): ProxyPair {
  return {
    ...createDefaultProxyPair("logs"),
    id: "pair-1",
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
  };
}

function identity(sessionId: string, turn = "one") {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      instructions: "rules",
      input: [{ role: "user", content: turn }],
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

function pairWithTwoNodes(): ProxyPair {
  return pair(
    [target("node-a", "http://localhost:9393/v1"), target("node-b", "http://127.0.0.1:9394/v1")],
    [group("lb-1", ["node-a", "node-b"])],
  );
}

const CONFIG = pairWithTwoNodes();

/** A balancer on a controllable clock: ledger timestamps have to be provable. */
function balancerOnClock(options: { ttlMs?: number; maxBindingsPerGroup?: number } = {}) {
  let clockNow = 1_000;
  const balancer = new LoadBalancer("pair-1", {
    now: () => clockNow,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxBindingsPerGroup === undefined
      ? {}
      : { maxBindingsPerGroup: options.maxBindingsPerGroup }),
  });
  balancer.reconfigure(CONFIG);
  return {
    balancer,
    now: () => clockNow,
    advance: (ms: number): void => {
      clockNow += ms;
    },
  };
}

function planned(
  balancer: LoadBalancer,
  sessionId: string,
  turn: string,
  now: number,
): LoadBalancerReservation {
  const groupShape = CONFIG.load_balancers[0];
  if (groupShape === undefined) {
    throw new Error("The fixture pair must carry its group.");
  }
  const reservation = balancer.plan({
    group: groupShape,
    identity: identity(sessionId, turn),
    now,
  });
  if (reservation === undefined) {
    throw new Error("The load balancing group must have a usable node.");
  }
  return reservation;
}

function entryOf(balancer: LoadBalancer, groupId: string): LoadBalancerBindingEntry {
  const snapshot = balancer.bindingSnapshot(groupId);
  if (snapshot === undefined) {
    throw new Error(`The group ${groupId} must still have a binding table.`);
  }
  const entry = snapshot.entries[0];
  if (entry === undefined) {
    throw new Error("The projection must still list the binding under test.");
  }
  return entry;
}

function activityOf(balancer: LoadBalancer, groupId: string): BindingActivity {
  return entryOf(balancer, groupId).activity;
}

describe("TRI-02 reservation counting at the reservation points", () => {
  it("TRI-02 a reservation opens the ledger and its release closes it", () => {
    const { balancer, now, advance } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    expect(now()).toBe(1_000);

    const started = activityOf(balancer, "lb-1");
    expect(started.inFlight).toBe(1);
    expect(started.lastRequestStartedAt).toBe(1_000);
    expect(started.recentRequestStarts).toEqual([1_000]);
    expect(started.lastResponseEndedAt).toBeUndefined();
    expect(started.lastUsage).toBeUndefined();

    // The target-level count keeps working exactly as before.
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(1);

    advance(2_500);
    reservation.release();
    const ended = activityOf(balancer, "lb-1");
    expect(ended.inFlight).toBe(0);
    expect(ended.lastResponseEndedAt).toBe(3_500);
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
  });

  it("TRI-02 duplicate release cannot drive the binding count negative", () => {
    const { balancer, now } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    reservation.release();
    reservation.release();
    expect(activityOf(balancer, "lb-1").inFlight).toBe(0);
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
  });

  it("TRI-02 concurrent reservations on one binding count and release separately", () => {
    const { balancer, now, advance } = balancerOnClock();
    const first = planned(balancer, "session-1", "one", now());
    advance(500);
    // The second request hits the same binding through affinity, so it is a second
    // reservation against the same ledger, not a second binding.
    const second = planned(balancer, "session-1", "two", now());
    expect(second.binding).toBe(first.binding);
    expect(balancer.tableFor("lb-1")?.size).toBe(1);

    const both = activityOf(balancer, "lb-1");
    expect(both.inFlight).toBe(2);
    expect(both.recentRequestStarts).toEqual([1_000, 1_500]);
    expect(both.lastRequestStartedAt).toBe(1_500);
    expect(balancer.inFlight(first.decision.targetId)).toBe(2);

    first.release();
    expect(activityOf(balancer, "lb-1").inFlight).toBe(1);
    second.release();
    expect(activityOf(balancer, "lb-1").inFlight).toBe(0);
    expect(balancer.inFlight(first.decision.targetId)).toBe(0);
  });

  it("TRI-02 the request-start ring stays bounded across many reservations", () => {
    const { balancer, advance } = balancerOnClock();
    const starts: number[] = [];
    for (let index = 0; index < MAX_RECENT_REQUEST_STARTS + 4; index += 1) {
      const at = 1_000 + index * 10;
      starts.push(at);
      planned(balancer, "session-1", `turn-${index}`, at).release();
      advance(10);
    }
    const ring = activityOf(balancer, "lb-1").recentRequestStarts;
    expect(ring).toHaveLength(MAX_RECENT_REQUEST_STARTS);
    expect(ring).toEqual(starts.slice(-MAX_RECENT_REQUEST_STARTS));
  });
});

describe("TRI-02 the projection reads without touching", () => {
  it("TRI-02 reading the snapshot and the entries changes no TTL, counter or target", () => {
    const { balancer, now } = balancerOnClock();
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    table.bind(identity("session-1", "one"), "node-a");

    const firstRead = balancer.bindingSnapshot("lb-1");
    const secondRead = balancer.bindingSnapshot("lb-1");
    expect(firstRead?.entries).toStrictEqual(secondRead?.entries);
    // The table-level projection is just as stable: reading it again yields the same
    // copies, which is what proves it neither refreshes TTL nor bumps counters.
    expect(table.bindingEntries()).toStrictEqual(table.bindingEntries());

    const entry = entryOf(balancer, "lb-1");
    expect(entry.targetId).toBe("node-a");
    expect(entry.routingRevision).toBe(0);
    expect(entry.requestCount).toBe(1);
    expect(entry.lastSeenAt).toBe(now());
    expect(entry.ref).toStrictEqual({
      runtimeEpoch: balancer.runtimeEpoch,
      groupId: "lb-1",
      bindingId: entry.ref.bindingId,
      routingRevision: 0,
      incarnation: entry.ref.incarnation,
    });
    expect(firstRead?.runtimeEpoch).toBe(balancer.runtimeEpoch);
    expect(firstRead?.groupId).toBe("lb-1");
    expect(firstRead?.groupRevision).toBe(1);

    // Contrast: the lookup path a plan takes does touch. The projection above did not.
    planned(balancer, "session-1", "one", now()).release();
    expect(entryOf(balancer, "lb-1").requestCount).toBe(2);
    expect(balancer.tableFor("lb-1")).toBe(table);
  });

  it("TRI-02 a binding without reservations projects the zero activity state", () => {
    const { balancer } = balancerOnClock();
    balancer.tableFor("lb-1")?.bind(identity("session-1", "one"), "node-a");
    expect(activityOf(balancer, "lb-1")).toStrictEqual({
      inFlight: 0,
      lastRequestStartedAt: undefined,
      lastResponseEndedAt: undefined,
      recentRequestStarts: [],
      lastRequestBytes: undefined,
      lastUsage: undefined,
      manualProtection: undefined,
    });
  });
});

describe("TRI-02 late releases against evicted bindings", () => {
  it("TRI-02 a late release after TTL eviction never goes negative or writes a new binding", () => {
    const { balancer, now, advance } = balancerOnClock({ ttlMs: 1_000 });
    const reservation = planned(balancer, "session-1", "one", now());

    // The binding ages out while the request is still running.
    advance(2_000);
    expect(balancer.tableFor("lb-1")?.sweepExpired()).toBe(1);
    expect(balancer.bindingSnapshot("lb-1")?.entries).toStrictEqual([]);

    reservation.release();
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
    // The ledger was dropped by the release itself: nothing is left for the sweep to find.
    expect(balancer.sweepBindingActivity()).toBe(0);
    // A second, late release still finds nothing to decrement.
    reservation.release();
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
    expect(balancer.bindingSnapshot("lb-1")?.entries).toStrictEqual([]);
  });

  it("TRI-02 the ledger of an evicted binding survives only while something is in flight", () => {
    const { balancer, now, advance } = balancerOnClock({ ttlMs: 1_000 });
    // A reservation that already ended leaves a zero-count ledger on the live binding.
    planned(balancer, "session-1", "one", now()).release();
    advance(2_000);
    expect(balancer.tableFor("lb-1")?.sweepExpired()).toBe(1);
    // The binding is gone and nothing is in flight, so the sweep collects the stale entry.
    expect(balancer.sweepBindingActivity()).toBe(1);
    expect(balancer.sweepBindingActivity()).toBe(0);
  });

  it("TRI-02 eviction keeps the ledger of a live reservation until the late release lands", () => {
    const { balancer, now, advance } = balancerOnClock({ ttlMs: 1_000 });
    const reservation = planned(balancer, "session-1", "one", now());
    advance(2_000);
    expect(balancer.tableFor("lb-1")?.sweepExpired()).toBe(1);

    // Still in flight: the sweep must keep the ledger so the release can find it.
    expect(balancer.sweepBindingActivity()).toBe(0);
    reservation.release();
    expect(balancer.sweepBindingActivity()).toBe(0);
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
  });

  it("TRI-02 a late release cannot touch the binding that reused the number", () => {
    const { balancer, now } = balancerOnClock();
    const old = planned(balancer, "session-1", "one", now());

    // The group leaves the configuration and comes back: a brand new table that numbers
    // its first binding with the same integer.
    balancer.reconfigure(pair(CONFIG.targets, []));
    balancer.reconfigure(CONFIG);
    const newcomer = planned(balancer, "session-2", "two", now());
    expect(newcomer.bindingRef.bindingId).toBe(old.bindingRef.bindingId);
    expect(newcomer.bindingRef.incarnation).not.toBe(old.bindingRef.incarnation);

    old.release();
    const entry = entryOf(balancer, "lb-1");
    expect(entry.ref.incarnation).toBe(newcomer.bindingRef.incarnation);
    expect(entry.activity.inFlight).toBe(1);
    expect(entry.activity.lastResponseEndedAt).toBeUndefined();
    expect(balancer.inFlight(old.decision.targetId)).toBe(0);

    newcomer.release();
    expect(entryOf(balancer, "lb-1").activity.inFlight).toBe(0);
  });

  it("TRI-02 eviction by the group cap releases exactly like eviction by TTL", () => {
    const { balancer, now } = balancerOnClock({ maxBindingsPerGroup: 1 });
    const first = planned(balancer, "session-1", "one", now());
    // A second task at the cap evicts the least recently used binding - the first one.
    const second = planned(balancer, "session-2", "two", now());
    expect(balancer.tableFor("lb-1")?.size).toBe(1);

    first.release();
    expect(balancer.sweepBindingActivity()).toBe(0);
    expect(balancer.inFlight(first.decision.targetId)).toBe(0);
    const entry = entryOf(balancer, "lb-1");
    expect(entry.ref.incarnation).toBe(second.bindingRef.incarnation);
    expect(entry.activity.inFlight).toBe(1);
    second.release();
    expect(entryOf(balancer, "lb-1").activity.inFlight).toBe(0);
  });
});

describe("TRI-02 ledger cleanup across reload, stop and group removal", () => {
  it("TRI-02 removing the group leaves in-flight ledgers until their releases land", () => {
    const { balancer, now } = balancerOnClock();
    const running = planned(balancer, "session-1", "one", now());
    const finished = planned(balancer, "session-2", "two", now());
    finished.release();

    balancer.reconfigure(pair(CONFIG.targets, []));
    expect(balancer.bindingSnapshot("lb-1")).toBeUndefined();

    // Nothing is in flight for the finished one and the table is gone: sweep collects it.
    expect(balancer.sweepBindingActivity()).toBe(1);
    // The running one survives the sweep because its request still counts.
    running.release();
    expect(balancer.sweepBindingActivity()).toBe(0);
    expect(balancer.inFlight(running.decision.targetId)).toBe(0);
  });

  it("TRI-02 clearing on stop drops every ledger and late releases become no-ops", () => {
    const { balancer, now } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    balancer.clear();
    expect(balancer.bindingSnapshot("lb-1")).toBeUndefined();
    expect(balancer.sweepBindingActivity()).toBe(0);

    reservation.release();
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
    expect(balancer.sweepBindingActivity()).toBe(0);
  });
});

describe("TRI-02 usage backfill and the coarse cost signal", () => {
  it("TRI-02 usage backfill stores normalized tokens with their endpoint and time", () => {
    const { balancer, now, advance } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    advance(2_000);
    balancer.recordBindingUsage(reservation.bindingRef, {
      status: "complete",
      endpoint: "responses",
      inputTokens: 1_500,
      cacheReadTokens: 256,
    });

    expect(activityOf(balancer, "lb-1").lastUsage).toStrictEqual({
      observedAt: 3_000,
      costSource: "normalized_usage",
      endpoint: "responses",
      inputTokens: 1_500,
      cacheReadTokens: 256,
    });
    reservation.release();
  });

  it("TRI-02 missing usage falls back to the recorded body size and never invents tokens", () => {
    const { balancer, now, advance } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    balancer.noteBindingRequestBytes(reservation.bindingRef, 512);
    advance(2_000);
    balancer.recordBindingUsage(reservation.bindingRef, { status: "unavailable" });

    const activity = activityOf(balancer, "lb-1");
    expect(activity.lastRequestBytes).toBe(512);
    expect(activity.lastUsage).toStrictEqual({
      observedAt: 3_000,
      costSource: "request_bytes",
      endpoint: undefined,
      inputTokens: undefined,
      cacheReadTokens: undefined,
    });
    reservation.release();
  });

  it("TRI-02 with neither usage nor bytes the cost signal stays none", () => {
    const { balancer, now, advance } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    advance(2_000);
    balancer.recordBindingUsage(reservation.bindingRef, { status: "unavailable" });

    const activity = activityOf(balancer, "lb-1");
    expect(activity.lastRequestBytes).toBeUndefined();
    expect(activity.lastUsage?.costSource).toBe("none");
    expect(activity.lastUsage?.inputTokens).toBeUndefined();
    reservation.release();
  });

  it("TRI-02 writes against an evicted binding teach nothing and resurrect nothing", () => {
    const { balancer, now, advance } = balancerOnClock({ ttlMs: 1_000 });
    const reservation = planned(balancer, "session-1", "one", now());
    advance(2_000);
    expect(balancer.tableFor("lb-1")?.sweepExpired()).toBe(1);

    balancer.noteBindingRequestBytes(reservation.bindingRef, 4_096);
    balancer.recordBindingUsage(reservation.bindingRef, { status: "unavailable" });
    balancer.setManualProtection(reservation.bindingRef);
    // If any of those writes had recreated a ledger entry, the sweep would now find it.
    expect(balancer.sweepBindingActivity()).toBe(0);

    reservation.release();
    expect(balancer.sweepBindingActivity()).toBe(0);
    expect(balancer.inFlight(reservation.decision.targetId)).toBe(0);
  });
});

describe("TRI-02 the manual protection carrier", () => {
  it("TRI-02 protection is set on a live binding and cleared by reference", () => {
    const { balancer, now, advance } = balancerOnClock();
    const reservation = planned(balancer, "session-1", "one", now());
    reservation.release();

    advance(500);
    balancer.setManualProtection(reservation.bindingRef);
    expect(entryOf(balancer, "lb-1").activity.manualProtection).toStrictEqual({ setAt: 1_500 });

    balancer.clearManualProtection(reservation.bindingRef);
    expect(entryOf(balancer, "lb-1").activity.manualProtection).toBeUndefined();
    // The history of the finished request stayed where it was.
    expect(entryOf(balancer, "lb-1").activity.lastResponseEndedAt).toBe(1_000);
  });

  it("TRI-02 protection on an evicted binding is refused like every other write", () => {
    const { balancer, advance } = balancerOnClock({ ttlMs: 1_000 });
    const table = balancer.tableFor("lb-1");
    if (table === undefined) {
      throw new Error("An enabled group must have an affinity table.");
    }
    const binding = table.bind(identity("session-1", "one"), "node-a");
    const ref = balancer.bindingRefFor("lb-1", binding);
    advance(2_000);
    expect(table.sweepExpired()).toBe(1);

    balancer.setManualProtection(ref);
    balancer.clearManualProtection(ref);
    // Had the carrier accepted either write, a ledger entry for the dead binding would
    // exist here and the sweep would report it.
    expect(balancer.sweepBindingActivity()).toBe(0);
  });
});
