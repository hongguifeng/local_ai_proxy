import { isRecord } from "../shared/index.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
        if (mapping.listen === requestModel) {
          return {
            target,
            requestModel,
            upstreamModel: mapping.upstream === "" ? undefined : mapping.upstream,
          };
        }
      }
    }
  }
  return { target: defaultTarget, requestModel, upstreamModel: undefined };
}
