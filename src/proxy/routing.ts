import { isRecord } from "../shared/index.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export interface RoutingTarget {
  readonly id: string;
  readonly enabled: boolean;
  readonly model_mappings: readonly {
    readonly listen: string;
    readonly upstream: string;
  }[];
}

export interface TargetSelection<TTarget extends RoutingTarget = RoutingTarget> {
  readonly target: TTarget;
  readonly requestModel: string | undefined;
  readonly upstreamModel: string | undefined;
}

export function requestModelFromBody(requestBody: Uint8Array): string | undefined {
  let loaded: unknown;
  try {
    loaded = JSON.parse(UTF8_DECODER.decode(requestBody));
  } catch {
    return undefined;
  }
  if (!isRecord(loaded)) {
    return undefined;
  }
  const model = loaded["model"];
  return typeof model === "string" ? model : undefined;
}

export function selectTargetByModel<TTarget extends RoutingTarget>(
  targets: readonly TTarget[],
  defaultTargetId: string,
  requestBody: Uint8Array,
): TargetSelection<TTarget> {
  const firstTarget = targets[0];
  if (firstTarget === undefined) {
    throw new TypeError("ProxyServer config must include at least one target.");
  }
  const defaultTarget = targets.find(({ id }) => id === defaultTargetId) ?? firstTarget;
  const requestModel = requestModelFromBody(requestBody);
  if (requestModel !== undefined && requestModel !== "") {
    for (const target of targets) {
      if (target !== defaultTarget && !target.enabled) {
        continue;
      }
      for (const mapping of target.model_mappings) {
        if (modelPatternMatches(mapping.listen, requestModel)) {
          const upstreamModel =
            mapping.listen.includes("*") && mapping.upstream === mapping.listen
              ? requestModel
              : mapping.upstream;
          return {
            target,
            requestModel,
            upstreamModel: upstreamModel === "" ? undefined : upstreamModel,
          };
        }
      }
    }
  }
  return { target: defaultTarget, requestModel, upstreamModel: undefined };
}

export function modelPatternMatches(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === model;
  }

  let patternIndex = 0;
  let modelIndex = 0;
  let lastStarIndex = -1;
  let modelIndexAfterStar = -1;

  while (modelIndex < model.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === model[modelIndex]) {
      patternIndex += 1;
      modelIndex += 1;
      continue;
    }
    if (pattern[patternIndex] === "*") {
      lastStarIndex = patternIndex;
      patternIndex += 1;
      modelIndexAfterStar = modelIndex;
      continue;
    }
    if (lastStarIndex === -1) {
      return false;
    }
    patternIndex = lastStarIndex + 1;
    modelIndexAfterStar += 1;
    modelIndex = modelIndexAfterStar;
  }

  while (pattern[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

export function rewriteRequestModel(
  requestBody: Uint8Array,
  upstreamModel: string | undefined,
): Uint8Array {
  if (upstreamModel === undefined || upstreamModel === "") {
    return requestBody;
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(UTF8_DECODER.decode(requestBody));
  } catch {
    return requestBody;
  }
  if (!isRecord(loaded)) {
    return requestBody;
  }
  loaded["model"] = upstreamModel;
  return UTF8_ENCODER.encode(JSON.stringify(loaded));
}
