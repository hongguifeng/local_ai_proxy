import type { RepositoryRecord } from "../persistence/index.js";
import type { EndpointKind } from "../proxy/index.js";

export interface TaskAssignment {
  readonly task: Readonly<RepositoryRecord>;
  readonly sequence: number;
  readonly kind: EndpointKind;
  readonly requestPayload: unknown;
  readonly responsePayload: unknown;
  readonly responseIds: readonly string[];
  readonly contextKeys: readonly string[];
}
