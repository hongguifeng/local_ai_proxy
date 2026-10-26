import { METRIC_FRESH_WINDOW_MS, type LoadBalancerNode, type LoadSample } from "./load-balancer.js";

/**
 * The evidence a routing judgement is allowed to act on, kept apart from the parser, the
 * monitor and the balancer so a future auto strategy (TRI-10) can reason about upstream load
 * without running anything: no clock of its own, no network, no database, only numbers that
 * were already measured. Nothing here makes a decision - it only says what is known.
 *
 * The rule this module exists to state is the one the request path has to keep straight:
 * `running: undefined` and `running: 0` are different facts. Only the second one may make a
 * node look idle. A missing field is never filled in, so a sample that answered only the KV
 * share, an answer that went stale, or an engine that said it is asleep cannot be read as an
 * idle node no matter how quiet it appears.
 */

/** How much of the load an engine answered. */
export type MetricCompleteness = "complete" | "partial" | "no_load_numbers";

/** Whether a sample still says anything about the present moment. */
export type SampleFreshness = "fresh" | "stale" | "never_sampled";

/** One engine answer, classified. Every field is what the engine said or nothing at all. */
export interface LoadSampleAssessment {
  readonly freshness: SampleFreshness;
  readonly completeness: MetricCompleteness;
  /** Which read of the physical engine this was, or nothing when there is no sample. */
  readonly sampleSequence: number | undefined;
  readonly sampledAt: number | undefined;
  readonly running: number | undefined;
  readonly waiting: number | undefined;
  readonly kvUsage: number | undefined;
  /** False only when the engine said it is asleep. */
  readonly awake: boolean | undefined;
  readonly source: string | undefined;
  /**
   * The gate an auto strategy reads: a fresh answer that gave both load numbers and did not
   * report a sleep. KV alone, a stale answer or an explicit sleep never qualifies, so an
   * unmeasured node cannot be called idle and an old number cannot be counted as evidence.
   */
  readonly usableForLoadJudgement: boolean;
}

/** One physical engine, seen through the answer its targets share. */
export interface EngineLoadView {
  readonly canonicalKey: string;
  /** Every pair target that spells this engine; they share one metric, not two capacities. */
  readonly targetIds: readonly string[];
  /** The answer of the engine itself, taken from whichever alias carries it. */
  readonly assessment: LoadSampleAssessment;
  /** Per-target serving state: the engine is one node, but a move is still made per target. */
  readonly targets: readonly EngineTargetState[];
}

/** What a candidate target has to be judged by besides the engine's numbers. */
export interface EngineTargetState {
  readonly targetId: string;
  readonly enabled: boolean;
  readonly cooldownRemainingMs: number;
  /** Enabled and past its cooldown. Serving anyway while all nodes cool is the balancer's policy. */
  readonly inRotation: boolean;
}

/**
 * Classify one sample against one moment. `freshWindowMs` is a parameter so a caller can
 * prove what a shorter or longer window would do; the default is the window the balancer
 * already uses, which is a description of the current sampling, not an auto threshold.
 */
export function assessLoadSample(
  sample: LoadSample | undefined,
  now: number,
  freshWindowMs: number = METRIC_FRESH_WINDOW_MS,
): LoadSampleAssessment {
  if (sample === undefined) {
    return {
      awake: undefined,
      completeness: "no_load_numbers",
      freshness: "never_sampled",
      kvUsage: undefined,
      running: undefined,
      sampleSequence: undefined,
      sampledAt: undefined,
      source: undefined,
      usableForLoadJudgement: false,
      waiting: undefined,
    };
  }
  const freshness: SampleFreshness = now - sample.sampledAt > freshWindowMs ? "stale" : "fresh";
  const completeness = completenessOf(sample);
  return {
    awake: sample.awake,
    completeness,
    freshness,
    kvUsage: sample.kvUsage,
    running: sample.running,
    sampleSequence: sample.sampleSequence,
    sampledAt: sample.sampledAt,
    source: sample.source,
    usableForLoadJudgement:
      freshness === "fresh" && completeness === "complete" && sample.awake !== false,
    waiting: sample.waiting,
  };
}

/**
 * Group the pair's nodes by physical engine. Two targets of the same GPU are one node: the
 * engine's numbers are read once and shared, so a second spelling of the same address cannot
 * double the metric traffic or add up to extra capacity. The fresher of the aliases' samples
 * carries the view, because a disabled alias is not sampled and would otherwise report
 * nothing for an engine that is in fact answering.
 */
export function engineLoadViews(
  nodes: readonly LoadBalancerNode[],
  now: number,
): readonly EngineLoadView[] {
  const grouped = new Map<string, { assessment: LoadSampleAssessment; targetIds: string[] }>();
  for (const node of nodes) {
    const view = { assessment: assessLoadSample(node.sample, now), targetIds: [node.targetId] };
    const existing = grouped.get(node.canonicalKey);
    if (existing === undefined) {
      grouped.set(node.canonicalKey, view);
      continue;
    }
    existing.targetIds.push(node.targetId);
    if (isFresherEvidence(view.assessment, existing.assessment)) {
      existing.assessment = view.assessment;
    }
  }
  return [...grouped.entries()].map(([canonicalKey, group]) => ({
    canonicalKey,
    assessment: group.assessment,
    targetIds: group.targetIds,
    targets: nodes
      .filter((node) => node.canonicalKey === canonicalKey)
      .map((node) => targetState(node, now)),
  }));
}

function completenessOf(sample: LoadSample): MetricCompleteness {
  if (sample.running === undefined && sample.waiting === undefined) {
    return "no_load_numbers";
  }
  if (sample.running === undefined || sample.waiting === undefined) {
    return "partial";
  }
  return "complete";
}

function targetState(node: LoadBalancerNode, now: number): EngineTargetState {
  const cooldownRemainingMs =
    node.cooldownUntil === undefined ? 0 : Math.max(0, node.cooldownUntil - now);
  return {
    cooldownRemainingMs,
    enabled: node.enabled,
    inRotation: node.enabled && cooldownRemainingMs === 0,
    targetId: node.targetId,
  };
}

/** A sample that answers the engine beats one that does not, and a later read beats an earlier. */
function isFresherEvidence(
  candidate: LoadSampleAssessment,
  current: LoadSampleAssessment,
): boolean {
  if (candidate.sampleSequence === undefined) {
    return false;
  }
  if (current.sampleSequence === undefined) {
    return true;
  }
  return candidate.sampleSequence > current.sampleSequence;
}
