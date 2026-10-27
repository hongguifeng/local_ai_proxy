import { describe, expect, it } from "vitest";

import type { BindingActivity, BindingUsageSignal } from "../../src/proxy/binding-activity.js";
import { engineLoadViews, type EngineLoadView } from "../../src/proxy/load-evidence.js";
import {
  ADVISE_OBSERVATION_POLICY,
  AUTO_NOT_CALIBRATED,
  AUTO_REBALANCE_CALIBRATED,
  RebalanceAdvisor,
  type RebalanceBindingCandidate,
  type RebalanceGroupView,
  type RebalancePolicy,
  type RebalanceSuggestion,
  type RebalanceTickInput,
} from "../../src/proxy/load-rebalance.js";
import type {
  LoadBalancerMoveDestinationGate,
  LoadBalancerMoveGates,
} from "../../src/proxy/load-balancer.js";
import type { LoadBalancerNode, LoadSample } from "../../src/proxy/load-balancer.js";
import type { BindingRef } from "../../src/proxy/load-migration-contract.js";

/**
 * [TRI-10] The pure advisor, driven entirely with hand-built data. Nothing in this file
 * opens a socket, a database or a LoadBalancer - which is the contract the module promises.
 * The real wiring (the monitor's tick, the stop lifecycle, "auto never moves anything") is
 * proven in `load-monitor.test.ts`; this file proves the judgement itself.
 *
 * A suggestion needs the same source/destination combination across two *distinct* sample
 * sequences, so most tests tick twice ("settle") before they assert the advice.
 */

const EPOCH = "epoch-test-a";
const GROUP = "lb-1";
const START = 1_000_000;

const TEST_POLICY: RebalancePolicy = {
  ...ADVISE_OBSERVATION_POLICY,
  antiFlapBlockedMs: 60_000,
  bindingSuggestionCooldownMs: 10_000,
  budgetWindowMs: 60_000,
  candidateActivityWindowMs: 60_000,
  destinationCommitmentCap: 2,
  groupSuggestionBudget: 4,
  maxSuggestionsPerGroup: 8,
  suggestionRetentionMs: 30_000,
};

const BUSY = { running: 3, waiting: 2 };
const IDLE = { running: 0, waiting: 0 };

function sample(
  sampleSequence: number,
  overrides: Partial<LoadSample> = {},
  sampledAt = START - 1_000,
): LoadSample {
  return {
    kvUsage: 0.4,
    running: 3,
    sampleSequence,
    sampledAt,
    source: "vllm",
    waiting: 2,
    ...overrides,
  };
}

function node(targetId: string, canonicalKey: string, sampleValue?: LoadSample): LoadBalancerNode {
  return {
    apiKey: "",
    canonicalKey,
    cooldownUntil: undefined,
    enabled: true,
    failures: 0,
    lastDispatchedAt: undefined,
    sample: sampleValue,
    targetId,
    targetUrl: `http://${canonicalKey}`,
  };
}

/** A busy engine on A, quiet engines on B and C. `sampledAt` lets a test make answers stale. */
function engineTrio(
  sequence: number,
  busy: { running: number | undefined; waiting: number | undefined },
  idle: { running: number | undefined; waiting: number | undefined },
  sampledAt = START - 1_000,
) {
  return engineLoadViews(
    [
      node("target-a", "http://engine-a", sample(sequence, busy, sampledAt)),
      node("target-b", "http://engine-b", sample(sequence, idle, sampledAt)),
      node("target-c", "http://engine-c", sample(sequence, idle, sampledAt)),
    ],
    START,
  );
}

/** A and B busy, C quiet or busy: one destination, so the picker has no ordering wiggle. */
function engineDuo(sequence: number, cQuiet: boolean, sampledAt = START - 1_000) {
  return engineLoadViews(
    [
      node("target-a", "http://engine-a", sample(sequence, BUSY, sampledAt)),
      node("target-b", "http://engine-b", sample(sequence, BUSY, sampledAt)),
      node("target-c", "http://engine-c", sample(sequence, cQuiet ? IDLE : BUSY, sampledAt)),
    ],
    START,
  );
}

function usage(overrides: Partial<BindingUsageSignal> = {}): BindingUsageSignal {
  return {
    cacheReadTokens: 900,
    costSource: "normalized_usage",
    endpoint: "responses",
    inputTokens: 1_840,
    observedAt: START - 2_000,
    ...overrides,
  };
}

function activity(overrides: Partial<BindingActivity> = {}): BindingActivity {
  return {
    inFlight: 0,
    lastRequestBytes: 2_048,
    lastRequestStartedAt: START - 5_000,
    lastResponseEndedAt: START - 3_000,
    lastUsage: usage(),
    manualProtection: undefined,
    recentRequestStarts: [START - 5_000],
    ...overrides,
  };
}

function ref(bindingId: number, routingRevision = 0, incarnation = bindingId * 10): BindingRef {
  return {
    bindingId,
    groupId: GROUP,
    incarnation,
    routingRevision,
    runtimeEpoch: EPOCH,
  };
}

function gates(destinations: LoadBalancerMoveGates["destinations"]): LoadBalancerMoveGates {
  return { blocking: [], destinations };
}

const TO_C: readonly LoadBalancerMoveDestinationGate[] = [
  { eligible: true, code: undefined, targetId: "target-c" },
];
const TO_BC: readonly LoadBalancerMoveDestinationGate[] = [
  { eligible: true, code: undefined, targetId: "target-b" },
  { eligible: true, code: undefined, targetId: "target-c" },
];
/** Only target-c is eligible; target-b is disabled, so the picker must skip it. */
const TO_C_ONLY: readonly LoadBalancerMoveDestinationGate[] = [
  { eligible: false, code: "target_disabled", targetId: "target-b" },
  { eligible: true, code: undefined, targetId: "target-c" },
];

function candidate(
  bindingId: number,
  targetId: string,
  destinations = TO_BC,
  activityOverrides: Partial<BindingActivity> = {},
  routingRevision = 0,
): RebalanceBindingCandidate {
  return {
    activity: activity(activityOverrides),
    gates: gates(destinations),
    ref: ref(bindingId, routingRevision),
    targetId,
  };
}

function tickInput(
  options: {
    now?: number;
    views?: readonly EngineLoadView[];
    candidates?: readonly RebalanceBindingCandidate[];
    targetInFlight?: ReadonlyMap<string, number>;
    policy?: RebalancePolicy;
    runtimeEpoch?: string;
    groupRevision?: number;
  } = {},
): RebalanceTickInput {
  return {
    candidates: options.candidates ?? [candidate(1, "target-a")],
    engineViews: options.views ?? engineTrio(1, BUSY, IDLE),
    groupId: GROUP,
    groupRevision: options.groupRevision ?? 1,
    memberOrder: ["target-a", "target-b", "target-c"],
    now: options.now ?? START,
    policy: options.policy ?? TEST_POLICY,
    runtimeEpoch: options.runtimeEpoch ?? EPOCH,
    targetInFlight:
      options.targetInFlight ??
      new Map([
        ["target-a", 0],
        ["target-b", 0],
        ["target-c", 0],
      ]),
  };
}

/** Run the two distinct sample sequences an advise suggestion needs. */
function settle(advisor: RebalanceAdvisor, options: Parameters<typeof tickInput>[0] = {}): void {
  advisor.tick(tickInput(options));
  advisor.tick(
    tickInput({
      ...options,
      views: options.views ?? engineTrio(2, BUSY, IDLE, START),
    }),
  );
}

function states(view: RebalanceGroupView): string[] {
  return view.suggestions.map(
    (suggestion) => `${suggestion.state}:${suggestion.stateReason ?? "-"}`,
  );
}

function only(created: readonly RebalanceSuggestion[]): RebalanceSuggestion {
  const first = created[0];
  if (first === undefined || created.length !== 1) {
    throw new Error(`expected exactly one suggestion, got ${created.length}`);
  }
  return first;
}

describe("[TRI-10] the pure rebalance advisor", () => {
  it("refuses to evaluate a group whose targets all share one physical engine", () => {
    const advisor = new RebalanceAdvisor();
    const oneEngineViews = (sequence: number) =>
      engineLoadViews(
        [
          node("target-a", "http://engine-a", sample(sequence, BUSY)),
          node("target-a2", "http://engine-a", sample(sequence, BUSY)),
        ],
        START,
      );

    for (const sequence of [1, 2, 3, 4]) {
      const result = advisor.tick(
        tickInput({
          candidates: [
            candidate(1, "target-a", [{ eligible: true, code: undefined, targetId: "target-a2" }]),
          ],
          views: oneEngineViews(sequence),
        }),
      );
      expect(result.created).toEqual([]);
    }
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);
  });

  it("needs the same combination across distinct sample sequences, not re-reads", () => {
    const advisor = new RebalanceAdvisor();

    // First fresh read: the combination holds, but one sequence is not a pattern yet.
    expect(advisor.tick(tickInput()).created).toEqual([]);

    // The very same sample read again adds no evidence: stability must not grow.
    expect(advisor.tick(tickInput()).created).toEqual([]);

    // A new read of both engines makes it the second distinct sequence: advise speaks.
    const second = advisor.tick(tickInput({ views: engineTrio(2, BUSY, IDLE, START) }));
    const suggestion = only(second.created);
    expect(suggestion.stableSamples).toBe(2);
    expect(suggestion.sourceTargetId).toBe("target-a");
    expect(suggestion.destinationTargetId).toBe("target-b");
    expect(suggestion.state).toBe("suggested");
    expect(suggestion.stateReason).toBeUndefined();
    expect(suggestion.runtimeEpoch).toBe(EPOCH);
    expect(suggestion.groupRevision).toBe(1);
    expect(suggestion.routingRevision).toBe(0);
    expect(suggestion.costEstimated).toBe(false);
    expect(suggestion.inputTokens).toBe(1_840);
    expect(suggestion.suggestionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never reads a stale answer as load evidence", () => {
    const advisor = new RebalanceAdvisor();
    for (const sequence of [1, 2, 3, 4]) {
      const result = advisor.tick(
        tickInput({ views: engineTrio(sequence, BUSY, IDLE, START - 15_001) }),
      );
      expect(result.created).toEqual([]);
    }
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);
  });

  it("never reads a partial answer as load evidence", () => {
    const advisor = new RebalanceAdvisor();
    for (const sequence of [1, 2, 3]) {
      const partial = engineLoadViews(
        [
          // The source answered the queue but not the running number.
          node("target-a", "http://engine-a", sample(sequence, { running: undefined })),
          // The destination answered running but not the queue.
          node("target-b", "http://engine-b", sample(sequence, { waiting: undefined })),
          node("target-c", "http://engine-c", sample(sequence, IDLE)),
        ],
        START,
      );
      expect(advisor.tick(tickInput({ views: partial })).created).toEqual([]);
    }
  });

  it("never calls a KV-only engine idle", () => {
    const advisor = new RebalanceAdvisor();
    for (const sequence of [1, 2, 3]) {
      const kvOnly = engineLoadViews(
        [
          node("target-a", "http://engine-a", sample(sequence, BUSY)),
          node(
            "target-b",
            "http://engine-b",
            sample(sequence, { running: undefined, waiting: undefined }),
          ),
          node(
            "target-c",
            "http://engine-c",
            sample(sequence, { running: undefined, waiting: undefined }),
          ),
        ],
        START,
      );
      expect(advisor.tick(tickInput({ views: kvOnly })).created).toEqual([]);
    }
  });

  it("never trusts an engine that says it is asleep", () => {
    const advisor = new RebalanceAdvisor();
    for (const sequence of [1, 2, 3]) {
      const sleeping = engineLoadViews(
        [
          node("target-a", "http://engine-a", sample(sequence, { ...BUSY, awake: false })),
          node("target-b", "http://engine-b", sample(sequence, { ...IDLE, awake: false })),
          node("target-c", "http://engine-c", sample(sequence, IDLE)),
        ],
        START,
      );
      expect(advisor.tick(tickInput({ views: sleeping })).created).toEqual([]);
    }
  });

  it("does not call a destination idle while it still has a local reservation", () => {
    const advisor = new RebalanceAdvisor();
    const targetInFlight = new Map([
      ["target-a", 0],
      ["target-b", 1],
      ["target-c", 0],
    ]);
    settle(advisor, { targetInFlight });
    // target-b was skipped although the engine reports 0/0: target-c got the advice.
    const view = advisor.viewFor(GROUP, "advise");
    const suggestion = view.suggestions[0];
    expect(suggestion?.state).toBe("suggested");
    expect(suggestion?.destinationTargetId).toBe("target-c");
  });

  it("skips a binding that has a request in flight", () => {
    const advisor = new RebalanceAdvisor();
    settle(advisor, {
      candidates: [candidate(1, "target-a", TO_BC, { inFlight: 1 }), candidate(2, "target-a")],
    });
    const suggested = advisor
      .viewFor(GROUP, "advise")
      .suggestions.filter((suggestion) => suggestion.state === "suggested")
      .map((suggestion) => suggestion.bindingId);
    expect(suggested).toEqual([2]);
  });

  it("spares a binding a human protected", () => {
    const advisor = new RebalanceAdvisor();
    const options = {
      candidates: [candidate(1, "target-a", TO_BC, { manualProtection: { setAt: START - 9_000 } })],
    };
    settle(advisor, options);
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);
  });

  it("honours the write gate's own refusals: state risk and an ineligible target", () => {
    const advisor = new RebalanceAdvisor();
    const stateRisk = candidate(1, "target-a", TO_BC, {}, 0);
    settle(advisor, {
      candidates: [
        {
          ...stateRisk,
          gates: { blocking: ["response_state_dependency"], destinations: TO_BC },
        },
      ],
    });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);

    settle(advisor, {
      candidates: [
        {
          activity: activity(),
          gates: { blocking: ["state_unknown"], destinations: TO_BC },
          ref: ref(2),
          targetId: "target-a",
        },
      ],
    });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);

    // Every destination refused by the gates: no eligible candidate, so nothing to advise.
    settle(advisor, {
      candidates: [
        {
          activity: activity(),
          gates: gates([
            { eligible: false, code: "target_disabled", targetId: "target-b" },
            { eligible: false, code: "model_mismatch", targetId: "target-c" },
          ]),
          ref: ref(3),
          targetId: "target-a",
        },
      ],
    });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);
  });

  it("refuses a binding whose cost signal is nothing", () => {
    const advisor = new RebalanceAdvisor();
    settle(advisor, {
      candidates: [candidate(1, "target-a", TO_BC, { lastUsage: undefined })],
    });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);

    settle(advisor, {
      candidates: [
        candidate(2, "target-a", TO_BC, {
          lastRequestBytes: undefined,
          lastUsage: usage({ costSource: "none", inputTokens: undefined }),
        }),
      ],
    });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toEqual([]);
  });

  it("carries a body-size cost as an estimate, never as a token claim", () => {
    const advisor = new RebalanceAdvisor();
    settle(advisor, {
      candidates: [
        candidate(1, "target-a", TO_BC, {
          lastUsage: usage({ costSource: "request_bytes", inputTokens: undefined }),
        }),
      ],
    });
    const suggestion = advisor.viewFor(GROUP, "advise").suggestions[0];
    expect(suggestion?.state).toBe("suggested");
    expect(suggestion?.costEstimated).toBe(true);
    expect(suggestion?.costSource).toBe("request_bytes");
    expect(suggestion?.requestBytes).toBe(2_048);
    expect(suggestion?.inputTokens).toBeNull();
  });

  it("ranks by cost first, then multi-turn evidence, then the longer wait, then order", () => {
    const advisor = new RebalanceAdvisor();
    const policy: RebalancePolicy = { ...TEST_POLICY, destinationCommitmentCap: 10 };
    const candidates = [
      // Same turn shape as binding 3 but a costlier context than binding 2.
      candidate(1, "target-a", TO_BC, {
        lastRequestStartedAt: START - 1_000,
        recentRequestStarts: [START - 1_000],
      }),
      // Cheapest cost and the most turns inside the window: this one goes first.
      candidate(2, "target-a", TO_BC, {
        lastRequestStartedAt: START - 500,
        recentRequestStarts: [START - 9_000, START - 5_000, START - 500],
        lastUsage: usage({ inputTokens: 1_500 }),
      }),
      // The dearest context: reached only once the cheaper ones are spoken for.
      candidate(3, "target-a", TO_BC, {
        lastRequestStartedAt: START - 20_000,
        recentRequestStarts: [START - 20_000],
        lastUsage: usage({ inputTokens: 9_000 }),
      }),
    ];

    // One suggestion per tick, in rank order, as the evidence accumulates.
    const first = advisor.tick(tickInput({ candidates, policy }));
    expect(first.created).toEqual([]);
    const second = advisor.tick(
      tickInput({ candidates, policy, views: engineTrio(2, BUSY, IDLE, START) }),
    );
    expect(only(second.created).bindingId).toBe(2);

    // Binding 2 is inside its live episode; the next tick offers the next-ranked binding
    // and remembers, once, why the cheapest one was passed over.
    const third = advisor.tick(
      tickInput({ candidates, policy, views: engineTrio(3, BUSY, IDLE, START) }),
    );
    expect(only(third.created).bindingId).toBe(1);
    expect(states(advisor.viewFor(GROUP, "advise"))).toContain("rejected:episode_live");

    const fourth = advisor.tick(
      tickInput({ candidates, policy, views: engineTrio(4, BUSY, IDLE, START) }),
    );
    expect(only(fourth.created).bindingId).toBe(3);
    const refusalsForTwo = advisor
      .viewFor(GROUP, "advise")
      .suggestions.filter((s) => s.state === "rejected" && s.bindingId === 2);
    expect(refusalsForTwo).toHaveLength(1);
  });

  it("applies the binding suggestion cooldown after the episode ends", () => {
    const advisor = new RebalanceAdvisor();
    const policy: RebalancePolicy = { ...TEST_POLICY, bindingSuggestionCooldownMs: 10_000 };
    settle(advisor, { candidates: [candidate(1, "target-a", TO_C)], policy });
    expect(advisor.viewFor(GROUP, "advise").suggestions[0]?.state).toBe("suggested");

    // A manual move ends the suggestion; the cooldown refuses a new episode in the same
    // tick, and the reason stays in the store next to the expired record.
    const moved = advisor.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_C, {}, 1)],
        policy,
        views: engineDuo(3, true, START),
      }),
    );
    expect(only(moved.expired).stateReason).toBe("route_changed");
    expect(only(moved.rejected).stateReason).toBe("binding_cooldown");
    expect(states(advisor.viewFor(GROUP, "advise")).sort()).toEqual([
      "expired:route_changed",
      "rejected:binding_cooldown",
    ]);

    // Still inside the cooldown and quiet again: the refusal is not re-recorded.
    const refused = advisor.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_C, {}, 1)],
        now: START + 3_000,
        policy,
        views: engineDuo(4, true, START + 2_000),
      }),
    );
    expect(refused.created).toEqual([]);
    expect(refused.rejected).toEqual([]);
  });

  it("bounds how many suggestions a group may create inside one budget window", () => {
    const advisor = new RebalanceAdvisor();
    const policy: RebalancePolicy = { ...TEST_POLICY, groupSuggestionBudget: 2 };
    const candidates = [candidate(1, "target-a", TO_C), candidate(2, "target-a", TO_C)];
    settle(advisor, { candidates: candidates.slice(0, 1), policy });
    expect(
      advisor.viewFor(GROUP, "advise").suggestions.filter((s) => s.state === "suggested"),
    ).toHaveLength(1);

    const seen = { seq: 2 };
    advisor.tick(tickInput({ candidates, policy, views: engineDuo(seen.seq + 1, true, START) }));
    expect(
      advisor.viewFor(GROUP, "advise").suggestions.filter((s) => s.state === "suggested"),
    ).toHaveLength(2);

    const third = advisor.tick(
      tickInput({
        candidates: [...candidates, candidate(3, "target-a", TO_C)],
        policy,
        views: engineDuo(seen.seq + 2, true, START),
      }),
    );
    expect(third.created).toEqual([]);
    const reasons = third.rejected.map((record) => record.stateReason);
    expect(reasons).toContain("episode_live");
    expect(reasons).toContain("group_budget");
  });

  it("caps how many live suggestions may chase the same destination", () => {
    const advisor = new RebalanceAdvisor();
    const candidates = [
      candidate(1, "target-a", TO_C),
      candidate(2, "target-a", TO_C),
      candidate(3, "target-a", TO_C),
    ];
    settle(advisor, { candidates });
    advisor.tick(tickInput({ candidates, views: engineDuo(3, true, START) }));

    const fourth = advisor.tick(tickInput({ candidates, views: engineDuo(4, true, START) }));
    expect(fourth.created).toEqual([]);
    const reasons = fourth.rejected.map((record) => record.stateReason);
    expect(reasons).toContain("episode_live");
    expect(reasons).toContain("destination_commitment");
    expect(
      advisor.viewFor(GROUP, "advise").suggestions.filter((s) => s.state === "suggested"),
    ).toHaveLength(2);
  });

  it("blocks the automatic reverse of a suggestion inside the anti-flap window", () => {
    const advisor = new RebalanceAdvisor();
    const policy: RebalancePolicy = { ...TEST_POLICY, bindingSuggestionCooldownMs: 0 };
    settle(advisor, { candidates: [candidate(1, "target-a", TO_C)], policy });
    expect(advisor.viewFor(GROUP, "advise").suggestions[0]?.state).toBe("suggested");

    // The load picture flips and the same binding now sits on C (a human moved it; the
    // advisor moves nothing itself). A tick would suggest C→A; anti-flap must refuse it.
    const flipped = engineLoadViews(
      [
        node("target-a", "http://engine-a", sample(3, IDLE, START + 2_000)),
        node("target-b", "http://engine-b", sample(3, IDLE, START + 2_000)),
        node("target-c", "http://engine-c", sample(3, BUSY, START + 2_000)),
      ],
      START + 3_000,
    );
    const movedBinding: RebalanceBindingCandidate = {
      activity: activity({ lastRequestStartedAt: START + 1_000 }),
      gates: gates([
        { eligible: true, code: undefined, targetId: "target-a" },
        { eligible: false, code: "same_physical_key", targetId: "target-c" },
      ]),
      ref: ref(1, 1),
      targetId: "target-c",
    };

    advisor.tick(
      tickInput({
        candidates: [movedBinding],
        now: START + 3_000,
        policy,
        views: flipped,
      }),
    );
    const second = advisor.tick(
      tickInput({
        candidates: [movedBinding],
        now: START + 4_000,
        policy,
        views: engineLoadViews(
          [
            node("target-a", "http://engine-a", sample(4, IDLE, START + 3_000)),
            node("target-b", "http://engine-b", sample(4, IDLE, START + 3_000)),
            node("target-c", "http://engine-c", sample(4, BUSY, START + 3_000)),
          ],
          START + 4_000,
        ),
      }),
    );
    expect(second.created).toEqual([]);
    expect(only(second.rejected).stateReason).toBe("anti_flap");
  });

  it("expires a suggestion when the picture under it changes, naming each cause", () => {
    // One advisor per cause: a suggestion's death must not inherit another scenario's store.
    const scenario = (options: Parameters<typeof tickInput>[0]) => {
      const advisor = new RebalanceAdvisor();
      settle(advisor, { candidates: [candidate(1, "target-a", TO_C)] });
      expect(advisor.viewFor(GROUP, "advise").suggestions[0]?.state).toBe("suggested");
      return advisor.tick(tickInput(options));
    };
    const quiet = engineDuo(3, true, START);

    expect(only(scenario({ views: engineDuo(3, false, START) }).expired).stateReason).toBe(
      "target_busy",
    );

    expect(
      only(
        scenario({
          candidates: [
            {
              activity: activity(),
              gates: gates([{ eligible: false, code: "target_disabled", targetId: "target-c" }]),
              ref: ref(1),
              targetId: "target-a",
            },
          ],
          views: quiet,
        }).expired,
      ).stateReason,
    ).toBe("target_unavailable");

    expect(only(scenario({ candidates: [], views: quiet }).expired).stateReason).toBe(
      "binding_gone",
    );

    expect(
      only(scenario({ candidates: [candidate(1, "target-a", TO_C, {}, 1)], views: quiet }).expired)
        .stateReason,
    ).toBe("route_changed");

    expect(
      only(
        scenario({
          candidates: [candidate(1, "target-a", TO_C)],
          runtimeEpoch: "epoch-after-restart",
          views: quiet,
        }).expired,
      ).stateReason,
    ).toBe("runtime_changed");

    expect(
      only(
        scenario({
          candidates: [candidate(1, "target-a", TO_C)],
          groupRevision: 2,
          views: quiet,
        }).expired,
      ).stateReason,
    ).toBe("group_changed");

    expect(
      only(
        scenario({
          candidates: [
            {
              activity: activity(),
              gates: { blocking: ["state_unknown"], destinations: TO_C },
              ref: ref(1),
              targetId: "target-a",
            },
          ],
          views: quiet,
        }).expired,
      ).stateReason,
    ).toBe("state_risk");

    expect(
      only(
        scenario({
          candidates: [candidate(1, "target-a", TO_C)],
          views: engineDuo(3, true, START - 15_001),
        }).expired,
      ).stateReason,
    ).toBe("source_metrics_lost");

    // Only the quiet destination went silent while the source still answers. That is not the
    // imbalance disappearing - it is "nobody still knows the target is idle", so it must not
    // be reported with the source's reason.
    expect(
      only(
        scenario({
          candidates: [candidate(1, "target-a", TO_C)],
          views: engineLoadViews(
            [
              node("target-a", "http://engine-a", sample(3, BUSY)),
              node("target-b", "http://engine-b", sample(3, BUSY)),
              node("target-c", "http://engine-c", sample(3, IDLE, START - 15_001)),
            ],
            START,
          ),
        }).expired,
      ).stateReason,
    ).toBe("destination_metrics_lost");
  });

  it("ages an untouched suggestion out as unused, telling whether a request came", () => {
    const advisor = new RebalanceAdvisor();
    settle(advisor);
    // No later request: the suggestion simply aged out. No candidate is offered at the
    // ageing tick, so nothing competes with the unused transition.
    const aged = advisor.tick(
      tickInput({ candidates: [], now: START + 30_001, views: engineTrio(2, BUSY, IDLE, START) }),
    );
    expect(aged.expired).toEqual([]);
    const unused = advisor.viewFor(GROUP, "advise").suggestions[0];
    expect(unused?.state).toBe("unused");
    expect(unused?.stateReason).toBe("no_next_request");

    // Same again, but the binding started a request while the suggestion waited.
    const advisor2 = new RebalanceAdvisor();
    settle(advisor2);
    advisor2.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_BC, { lastRequestStartedAt: START + 50 })],
        views: engineTrio(3, BUSY, IDLE, START),
      }),
    );
    advisor2.tick(
      tickInput({ candidates: [], now: START + 30_001, views: engineTrio(3, BUSY, IDLE, START) }),
    );
    const sawOne = advisor2
      .viewFor(GROUP, "advise")
      .suggestions.find((suggestion) => suggestion.state === "unused");
    expect(sawOne?.state).toBe("unused");
    expect(sawOne?.stateReason).toBe("no_action_permitted");
  });

  it("never rewrites a terminal suggestion, and drops it after its own retention", () => {
    const advisor = new RebalanceAdvisor();
    settle(advisor);
    advisor.tick(
      tickInput({ candidates: [], now: START + 30_001, views: engineTrio(2, BUSY, IDLE, START) }),
    );
    expect(advisor.viewFor(GROUP, "advise").suggestions[0]?.state).toBe("unused");

    // Later drift cannot relabel an unused suggestion as expired.
    advisor.tick(
      tickInput({ candidates: [], now: START + 31_000, views: engineTrio(3, BUSY, IDLE, START) }),
    );
    const after = advisor.viewFor(GROUP, "advise").suggestions[0];
    expect(after?.state).toBe("unused");
    expect(after?.stateReason).toBe("no_next_request");

    // Once the terminal record itself ages out of the store, it is gone.
    advisor.tick(
      tickInput({
        candidates: [candidate(2, "target-a", TO_C)],
        now: START + 60_002,
        views: engineDuo(4, true, START),
      }),
    );
    expect(
      advisor
        .viewFor(GROUP, "advise")
        .suggestions.filter((suggestion) => suggestion.bindingId === 1),
    ).toEqual([]);
  });

  it("refuses to remember a refusal when every stored suggestion is still live", () => {
    const policy: RebalancePolicy = { ...TEST_POLICY, maxSuggestionsPerGroup: 1 };
    const advisor = new RebalanceAdvisor();
    settle(advisor, { candidates: [candidate(1, "target-a", TO_C_ONLY)], policy });
    expect(advisor.viewFor(GROUP, "advise").suggestions).toHaveLength(1);

    const refused = advisor.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_C_ONLY), candidate(2, "target-a", TO_C_ONLY)],
        policy,
        views: engineDuo(3, true, START),
      }),
    );
    expect(refused.created).toEqual([]);
    expect(refused.rejected).toEqual([]);
    expect(advisor.viewFor(GROUP, "advise").suggestions).toHaveLength(1);
  });

  it("drops the oldest terminal record to make room for a new suggestion", () => {
    const policy: RebalancePolicy = { ...TEST_POLICY, maxSuggestionsPerGroup: 1 };
    const advisor = new RebalanceAdvisor();
    settle(advisor, { candidates: [candidate(1, "target-a", TO_C_ONLY)], policy });

    // The live one expires when its destination turns busy, leaving a terminal record.
    advisor.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_C_ONLY)],
        policy,
        views: engineDuo(3, false, START),
      }),
    );
    expect(states(advisor.viewFor(GROUP, "advise"))).toEqual(["expired:target_busy"]);
    // Quiet again, but the combination is only one sample old again: nothing new yet.
    advisor.tick(
      tickInput({
        candidates: [candidate(1, "target-a", TO_C_ONLY)],
        policy,
        views: engineDuo(4, true, START),
      }),
    );
    expect(states(advisor.viewFor(GROUP, "advise"))).toEqual(["expired:target_busy"]);

    const room = advisor.tick(
      tickInput({
        candidates: [candidate(2, "target-a", TO_C_ONLY)],
        policy,
        views: engineDuo(5, true, START),
      }),
    );
    expect(room.created).toHaveLength(1);
    expect(states(advisor.viewFor(GROUP, "advise"))).toEqual(["suggested:-"]);
  });

  it("reports auto as not calibrated while advise and off report no refusal", () => {
    expect(AUTO_REBALANCE_CALIBRATED).toBe(false);
    const advisor = new RebalanceAdvisor();
    expect(advisor.viewFor(GROUP, "auto").disabledReason).toBe(AUTO_NOT_CALIBRATED);
    expect(advisor.viewFor(GROUP, "advise").disabledReason).toBeNull();
    expect(advisor.viewFor(GROUP, "off").disabledReason).toBeNull();
    expect(advisor.viewFor(GROUP, "auto").calibrated).toBe(false);
  });

  it("keeps a large evaluation cheap and its bindings genuinely distinct", () => {
    const advisor = new RebalanceAdvisor();
    const candidates = Array.from({ length: 100 }, (_unused, index) =>
      candidate(index + 1, "target-a", TO_C, { lastRequestStartedAt: START - index * 10 }),
    );
    // The fixture must hold 100 distinct bindings, or the timing below means nothing.
    const ids = new Set(
      candidates.map((entry) => `${entry.ref.bindingId}:${entry.ref.incarnation}`),
    );
    expect(ids.size).toBe(100);

    const startedAt = performance.now();
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      advisor.tick(
        tickInput({
          candidates,
          views: engineDuo(sequence, true, START),
        }),
      );
    }
    const perTick = (performance.now() - startedAt) / 20;
    // A generous local ceiling: this only proves the advisor's own scan stays cheap next
    // to the 5 s sampling tick. It says nothing about real engine behaviour (that is TRI-11).
    expect(perTick).toBeLessThan(25);
  });
});
