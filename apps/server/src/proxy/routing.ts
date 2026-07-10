import type { RuntimeProxy, RuntimeTarget } from "../config/schema.js";
import {
  parseRequestJsonObject,
  requestModelFromParsedBody,
  transformParsedRequestBody,
  type RequestJsonParseState,
} from "./request-transform.js";

export type TargetSelection = Readonly<{
  target: RuntimeTarget;
  requestedModel: string | null;
  upstreamModel: string | null;
}>;

export type RequestTransformMetadata = Readonly<{
  parseState: RequestJsonParseState;
  selectedTargetId: string;
  requestedModel: string | null;
  upstreamModel: string | null;
  strippedFields: readonly string[];
  injectedFields: readonly string[];
  bodyChanged: boolean;
}>;

export type RoutedRequest = Readonly<{
  target: RuntimeTarget;
  body: Uint8Array;
  metadata: RequestTransformMetadata;
}>;

export function selectTargetByModel(proxy: RuntimeProxy, requestedModel: string | null): TargetSelection {
  const defaultTarget = proxy.targets.find((target) => target.id === proxy.defaultTargetId);
  if (!defaultTarget) {
    throw new TypeError(`Default target does not exist: ${proxy.defaultTargetId}`);
  }

  if (requestedModel !== null && requestedModel.length > 0) {
    for (const target of proxy.targets) {
      if (!target.enabled) {
        continue;
      }
      const mapping = target.modelMappings.find((candidate) => candidate.listen === requestedModel);
      if (mapping) {
        return { target, requestedModel, upstreamModel: mapping.upstream };
      }
    }
  }
  return { target: defaultTarget, requestedModel, upstreamModel: null };
}

export function routeAndTransformRequest(proxy: RuntimeProxy, body: Uint8Array): RoutedRequest {
  const parsed = parseRequestJsonObject(body);
  const selection = selectTargetByModel(proxy, requestModelFromParsedBody(parsed));
  const transformed = transformParsedRequestBody(
    body,
    parsed,
    selection.target.stripRequestFields,
    selection.target.injectRequestFields,
    selection.upstreamModel,
  );
  return {
    target: selection.target,
    body: transformed.body,
    metadata: {
      parseState: parsed.state,
      selectedTargetId: selection.target.id,
      requestedModel: selection.requestedModel,
      upstreamModel: selection.upstreamModel,
      strippedFields: transformed.strippedFields,
      injectedFields: transformed.injectedFields,
      bodyChanged: transformed.bodyChanged,
    },
  };
}
