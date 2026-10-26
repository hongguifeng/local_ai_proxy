import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

import type { LoadBalancerGroup } from "../config/index.js";
import { loadBalancerMemberModelId, loadBalancerMemberTargetIds } from "../config/index.js";
import {
  completeRequestPricing,
  freezeRequestPricing,
  pendingRequestPricing,
  resolveUsage,
} from "../pricing/index.js";
import { ActiveRequestRegistry } from "./active-requests.js";
import {
  collectBody,
  RequestBodyTooLargeError,
  type BodyCollectorOptions,
} from "./body-collector.js";
import { bytesPayload } from "./protocol/payload.js";
import {
  createResponseBodyDecoder,
  type ResponseBodyDecoder,
  type ResponseBodySink,
} from "./response-decoder.js";
import {
  buildForwardHeaders,
  HOP_BY_HOP_HEADERS,
  replaceContentLength,
  type HeaderEntry,
} from "./headers.js";
import type { ProxyRequestContext } from "./proxy-listener.js";
import { transformRequestJsonFields } from "./request-transform.js";
import type { RequestTransformResult } from "./request-transform.js";
import {
  ResponseLogCapture,
  type ResponseLogCaptureOptions,
  type ResponseLogPayload,
} from "./response-log-capture.js";
import { endpointKind, responseIdsFromBody } from "./protocol/analysis.js";
import { requestModelFromBody, rewriteRequestModel, selectTargetByModel } from "./routing.js";
import type { BindingUsageObservation } from "./binding-activity.js";
import type { LoadBalancer, LoadBalancerReservation, LoadSample } from "./load-balancer.js";
import { taskIdentity, type TaskIdentity } from "./protocol/task-identity.js";
import {
  finishedEvent,
  pendingResponseEvent,
  receivedEvent,
  type TrafficModelRoute,
  type TrafficRecordEvent,
  type TrafficRequestDraft,
} from "./traffic-event.js";
import { joinTargetPath } from "./target.js";
import { openUpstreamResponse } from "./upstream-forwarder.js";

export interface TrafficLogWriter {
  write(record: Readonly<TrafficRecordEvent>): Promise<void>;
  update(record: Readonly<TrafficRecordEvent>): Promise<void>;
}

export interface ProxyPipelineTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly modelMappings: readonly { readonly listen: string; readonly upstream: string }[];
  readonly modelPrices?: readonly {
    readonly model_pattern: string;
    readonly price_multiplier?: string | undefined;
    readonly input_per_million: string;
    readonly output_per_million: string;
    readonly cache_read_per_million: string;
    readonly cache_write_per_million: string;
  }[];
  readonly name: string;
  readonly rejectUnauthorized?: boolean;
  readonly injectRequestFields?: Readonly<Record<string, unknown>>;
  readonly stripRequestFields?: ReadonlySet<string>;
  readonly targetScheme: "http" | "https";
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetBasePath: string;
  readonly targetApiKey?: string;
  readonly targetHeaders?: readonly HeaderEntry[];
  readonly trafficLog: TrafficLogWriter;
}

export interface ProxyRequestPipelineOptions {
  readonly activeRequests?: ActiveRequestRegistry;
  readonly bodyCollector?: BodyCollectorOptions;
  readonly defaultTargetId?: string;
  readonly pairId?: string;
  readonly pairName?: string;
  readonly responseCapture?: ResponseLogCaptureOptions;
  readonly targets: readonly ProxyPipelineTarget[];
  /** Per-pair load balancing state; absent means the classic model mapping routing. */
  readonly loadBalancer?: LoadBalancer | undefined;
  readonly loadSamples?: (() => ReadonlyMap<string, LoadSample>) | undefined;
}

interface LoadBalanceSelection {
  readonly group: LoadBalancerGroup;
  readonly reservation: LoadBalancerReservation;
  readonly identity: TaskIdentity;
}

interface PipelineTargetSelection {
  readonly target: ProxyPipelineTarget;
  readonly requestModel: string | undefined;
  readonly upstreamModel: string | undefined;
  readonly loadBalance: LoadBalanceSelection | undefined;
}

/** A matched group had no usable node. The caller must answer 503, never bypass the group. */
export class LoadBalancerExhaustedError extends Error {
  readonly group: LoadBalancerGroup;
  /** Where the refusal record is written: traffic logs live per target. */
  readonly logHost: ProxyPipelineTarget | undefined;

  constructor(group: LoadBalancerGroup, logHost: ProxyPipelineTarget | undefined) {
    super(`Load balancing group ${group.id} has no usable node.`);
    this.name = "LoadBalancerExhaustedError";
    this.group = group;
    this.logHost = logHost;
  }
}

export class ProxyRequestPipeline {
  readonly #activeRequests: ActiveRequestRegistry;
  readonly #options: ProxyRequestPipelineOptions;

  constructor(options: ProxyRequestPipelineOptions) {
    if (options.targets.length === 0) {
      throw new TypeError("Proxy request pipeline requires at least one target.");
    }
    this.#activeRequests = options.activeRequests ?? new ActiveRequestRegistry();
    this.#options = options;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: ProxyRequestContext,
  ): Promise<void> {
    const signal = this.#activeRequests.begin(context);
    const activeRequest = this.#activeRequests.get(context.id);
    const abortForClient = (): void => {
      activeRequest?.controller.abort(new Error("Client disconnected"));
    };
    const abortForResponseClose = (): void => {
      if (!response.writableFinished) {
        abortForClient();
      }
    };
    request.once("aborted", abortForClient);
    response.once("close", abortForResponseClose);
    try {
      await this.#handleActiveRequest(request, response, context, signal);
    } finally {
      request.off("aborted", abortForClient);
      response.off("close", abortForResponseClose);
      this.#activeRequests.end(context.id);
    }
  }

  async #handleActiveRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: ProxyRequestContext,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.#options.targets[0];
    if (target === undefined) {
      throw new Error("Proxy request pipeline lost its configured target.");
    }
    if (this.#options.targets.length === 1) {
      await target.trafficLog.write(receivedEvent(this.#initialRecord(request, context, target)));
    }
    let requestBody: Buffer;
    try {
      requestBody = await readRequestBody(request, this.#options.bodyCollector);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.writeHead(413, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
        response.end("Request body too large.");
        return;
      }
      throw error;
    }
    let selection: PipelineTargetSelection;
    try {
      selection = this.#selectTarget(request, requestBody);
    } catch (error) {
      if (error instanceof LoadBalancerExhaustedError) {
        respondLoadBalancerUnavailable(response, error.group.id);
        await this.#recordRejectedRequest(request, context, error, requestBody);
        return;
      }
      throw error;
    }
    let activeTarget = selection.target;
    let activeReservation = selection.loadBalance?.reservation;
    this.#noteRequestBytes(activeReservation, requestBody.byteLength);
    try {
      // A member with a model id rewrites the body once; a failover to another member
      // rewrites it again, because each node may answer under a different model name.
      let rewrittenBody = rewriteRequestModel(requestBody, selection.upstreamModel);
      let transformed = transformRequestJsonFields(
        rewrittenBody,
        activeTarget.stripRequestFields ?? new Set(),
        activeTarget.injectRequestFields ?? {},
      );
      const pricingContext = freezeRequestPricing(
        requestModelFromBody(transformed.body),
        activeTarget.modelPrices ?? [],
        {
          frozenAt: context.startedAt,
          targetId: activeTarget.id,
          targetName: activeTarget.name,
        },
      );
      const baseRecord: TrafficRequestDraft = {
        ...withRequestDetails(
          this.#initialRecord(request, context, activeTarget),
          requestBody,
          transformed.body,
          selection,
          transformed.strippedFields,
          transformed.injectedFields,
        ),
        pricing: pendingRequestPricing(pricingContext),
      };
      if (this.#options.targets.length > 1) {
        await activeTarget.trafficLog.write(receivedEvent(baseRecord));
      }
      await activeTarget.trafficLog.update(pendingResponseEvent(baseRecord));
      let responseCapture = new ResponseLogCapture(false, this.#options.responseCapture);
      let responseStatus: number;
      let responseHeaders: Record<string, string[]>;
      let firstTokenMs: number | undefined;
      let sseResponse = false;
      let generatedEvents = 0;
      let lastGeneratedMs: number | undefined;
      try {
        activeReservation?.markDispatched();
        let upstream: IncomingMessage;
        try {
          upstream = await openUpstreamResponse({
            target: activeTarget,
            method: request.method ?? "GET",
            path: joinTargetPath(activeTarget.targetBasePath, request.url ?? "/"),
            headers: upstreamRequestHeaders(request, activeTarget, transformed.body.byteLength),
            body: transformed.body,
            signal,
          });
        } catch (error) {
          const switched = this.#tryFailover({
            error,
            selection,
            request,
            body: transformed.body,
            signal,
            response,
          });
          if (switched === undefined) {
            throw error;
          }
          activeTarget = switched.target;
          activeReservation = switched.reservation;
          // The new reservation may belong to a binding the first attempt never touched -
          // the old binding can leave the table while its reservation is handed back, and
          // the failover plan then creates a fresh one. Its ledger knows nothing about this
          // request, so the coarse cost signal has to be recorded again for the node that
          // actually answers; without it a missing usage reports `none` instead of the
          // body size that was known at selection.
          this.#noteRequestBytes(activeReservation, requestBody.byteLength);
          activeReservation.markDispatched();
          const failoverModelId =
            loadBalancerMemberModelId(switched.group, activeTarget.id) ?? selection.requestModel;
          rewrittenBody = rewriteRequestModel(requestBody, failoverModelId);
          transformed = transformRequestJsonFields(
            rewrittenBody,
            activeTarget.stripRequestFields ?? new Set(),
            activeTarget.injectRequestFields ?? {},
          );
          applyFailoverRoute(baseRecord, activeTarget, switched.fromTargetId, selection, {
            upstreamModel: failoverModelId,
            transformed,
          });
          upstream = await openUpstreamResponse({
            target: activeTarget,
            method: request.method ?? "GET",
            path: joinTargetPath(activeTarget.targetBasePath, request.url ?? "/"),
            headers: upstreamRequestHeaders(request, activeTarget, transformed.body.byteLength),
            body: transformed.body,
            signal,
          });
        }
        responseStatus = upstream.statusCode ?? 502;
        // The connection came up and a status line arrived: that is the evidence that the node
        // this request was planned for actually received it, and it is the point where a planned
        // move becomes `observed`. A business status is not required - a 4xx or 5xx from this
        // engine is still a request that travelled to the destination the move wrote - and an
        // attempt whose connection never came up never reaches this line.
        this.#noteMigrationLanding(activeReservation, baseRecord);
        // A connection that came up ends the node's failure history and cooldown.
        if (selection.loadBalance !== undefined) {
          this.#options.loadBalancer?.noteSuccess(activeTarget.id);
        }
        responseHeaders = incomingHeaders(upstream);
        sseResponse = isSseResponse(upstream);
        responseCapture = new ResponseLogCapture(sseResponse, {
          ...this.#options.responseCapture,
          pricingEndpoint: endpointKind(request.url ?? "/"),
        });
        // The log records the decoded body: an upstream `content-encoding` is
        // transparent to the client but unreadable to the SSE observer, the usage
        // capture and the JSON pane.
        const observeResponseBody: ResponseBodySink = (chunk) => {
          responseCapture.addChunk(chunk);
          const count = responseCapture.generatedEvents;
          if (sseResponse && count > generatedEvents) {
            const now = elapsedMilliseconds(context);
            firstTokenMs ??= now;
            lastGeneratedMs = now;
          }
          generatedEvents = count;
        };
        response.writeHead(
          responseStatus,
          upstream.statusMessage ?? undefined,
          forwardedResponseHeaders(upstream),
        );
        await forwardResponseBody(
          upstream,
          response,
          request.method === "HEAD",
          createResponseBodyDecoder(upstream.headers["content-encoding"], observeResponseBody),
        );
      } catch (error) {
        // A second connection failure also cools the node down, but never triggers another
        // switch: one safe attempt is all a load balancing group gets. A client that went
        // away is not the node's fault, so the abort signal keeps the cooldown off.
        if (
          selection.loadBalance !== undefined &&
          !signal.aborted &&
          isConnectionPhaseError(error)
        ) {
          this.#options.loadBalancer?.markFailure(activeTarget.id, Date.now());
        }
        responseStatus = response.headersSent ? response.statusCode : 502;
        responseHeaders = response.headersSent
          ? {}
          : { "content-type": ["text/plain; charset=utf-8"] };
        if (response.headersSent) {
          response.destroy();
        } else {
          const badGatewayBody = Buffer.from("Bad Gateway", "utf8");
          responseCapture.addChunk(badGatewayBody);
          response.writeHead(502, {
            "content-type": "text/plain; charset=utf-8",
            connection: "close",
          });
          response.end(request.method === "HEAD" ? undefined : badGatewayBody);
        }
        baseRecord.error = formatUpstreamError(error);
      }
      // Freeze transport timing before parsing, disk spooling and pricing work.
      const durationMs = elapsedMilliseconds(context);
      baseRecord.decode_window_ms =
        firstTokenMs !== undefined && lastGeneratedMs !== undefined
          ? Math.max(0, lastGeneratedMs - firstTokenMs)
          : 0;
      const responseBody: ResponseLogPayload = await responseCapture.finalize();
      const responsePayload = responseJson(responseBody);
      baseRecord.pricing = completeRequestPricing(
        pricingContext,
        endpointKind(request.url ?? "/"),
        responsePayload,
        responseCapture.usageCapture,
      );
      this.#recordBindingUsage(activeReservation, request, responsePayload, responseCapture);
      await activeTarget.trafficLog.write(
        finishedEvent(
          baseRecord,
          {
            status: responseStatus,
            headers: responseHeaders,
            body: responseBody,
          },
          durationMs,
          firstTokenMs,
        ),
      );
      this.#noteResponseIds(selection, responsePayload);
    } finally {
      // The reservation covers the whole upstream response, including a long SSE decode,
      // and it fires for client aborts and upstream failures alike.
      activeReservation?.release();
    }
  }

  /**
   * The reservation's binding learns how large this request was while the route is
   * still fresh, at selection time. Only the byte count is recorded; the body itself
   * never reaches the ledger, and a plain (non load balanced) selection has no
   * reservation to record on.
   */
  #noteRequestBytes(reservation: LoadBalancerReservation | undefined, requestBytes: number): void {
    if (reservation === undefined) {
      return;
    }
    this.#options.loadBalancer?.noteBindingRequestBytes(reservation.bindingRef, requestBytes);
  }

  /**
   * Write the move this request proved into the stored route, once the destination has answered
   * the connection. The keys come from the migration record, so a reader can confirm the
   * destination was really used after this process is gone, and none of them is request text, a
   * session key or an upstream key - the reason is the bounded audit label.
   *
   * A planned move is not written here, and a move that failed to land is never written at all:
   * the route names only what the request path confirmed. The earlier lifecycle records are left
   * as they were written, so the move appears exactly where the proof of it appears.
   */
  #noteMigrationLanding(
    reservation: LoadBalancerReservation | undefined,
    baseRecord: TrafficRequestDraft,
  ): void {
    if (reservation === undefined) {
      return;
    }
    const landed = reservation.confirmRouted();
    if (landed === undefined) {
      return;
    }
    const modelRoute = baseRecord.request.model_route;
    if (modelRoute === undefined) {
      return;
    }
    baseRecord.request = {
      ...baseRecord.request,
      model_route: {
        ...modelRoute,
        load_balance: {
          ...(modelRoute.load_balance ?? {}),
          move_operation_id: landed.operationId,
          moved_by: landed.movedBy,
          moved_from: landed.movedFrom,
          moved_to: landed.movedTo,
          move_routing_revision: landed.routingRevision,
          ...(landed.reason === "" ? {} : { move_reason: landed.reason }),
        },
      },
    };
  }

  /**
   * Backfill what this response produced for usage once pricing has resolved it. The
   * signal lands on the reservation that actually served the request - after a failover
   * that is the new one, never the attempt that failed. The pricing module's own
   * resolution is reused, so the ledger can never claim tokens the cost calculation
   * could not use; a missing usage leaves token counts absent and the ledger keeps the
   * coarse body-size signal recorded at selection time.
   */
  #recordBindingUsage(
    reservation: LoadBalancerReservation | undefined,
    request: IncomingMessage,
    responsePayload: unknown,
    responseCapture: ResponseLogCapture,
  ): void {
    const balancer = this.#options.loadBalancer;
    if (reservation === undefined || balancer === undefined) {
      return;
    }
    const normalization = resolveUsage(
      endpointKind(request.url ?? "/"),
      responsePayload,
      responseCapture.usageCapture,
    );
    const observation: BindingUsageObservation =
      normalization.status === "complete"
        ? {
            status: "complete",
            endpoint: normalization.usage.source,
            inputTokens: normalization.usage.totalInputTokens,
            cacheReadTokens: normalization.usage.cacheReadTokens,
          }
        : { status: "unavailable" };
    balancer.recordBindingUsage(reservation.bindingRef, observation);
  }

  /** Teach the binding which response ids this response produced. */
  #noteResponseIds(selection: PipelineTargetSelection, responsePayload: unknown): void {
    const loadBalance = selection.loadBalance;
    if (loadBalance === undefined) {
      return;
    }
    const responseIds = responseIdsFromBody(responsePayload);
    if (responseIds.length === 0) {
      return;
    }
    this.#options.loadBalancer
      ?.tableFor(loadBalance.group.id)
      ?.attachResponseIds(loadBalance.reservation.binding, responseIds);
  }

  /**
   * One safe switch. It only happens for a connection-phase error, before any response
   * header reached the client, and only when the group allows failover and still has
   * another usable node. A 4xx/5xx from the engine is not a connection error.
   */
  #tryFailover(input: {
    readonly error: unknown;
    readonly selection: PipelineTargetSelection;
    readonly request: IncomingMessage;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
    readonly response: ServerResponse;
  }):
    | {
        readonly target: ProxyPipelineTarget;
        readonly reservation: LoadBalancerReservation;
        readonly fromTargetId: string;
        readonly group: LoadBalancerGroup;
      }
    | undefined {
    const loadBalance = input.selection.loadBalance;
    const balancer = this.#options.loadBalancer;
    if (loadBalance === undefined || balancer === undefined) {
      return undefined;
    }
    if (!loadBalance.group.failover_enabled) {
      return undefined;
    }
    if (input.response.headersSent) {
      return undefined;
    }
    if (!isConnectionPhaseError(input.error)) {
      return undefined;
    }

    const fromTargetId = loadBalance.reservation.decision.targetId;
    balancer.markFailure(fromTargetId, Date.now());
    // The failed node stops carrying this request; the task then moves once, and only once.
    // A failover is an availability action and outranks any move that was waiting for this
    // binding, so those intents are called off before the release - otherwise this very release
    // would look like the boundary they were waiting for and the retry would be planned from a
    // route the migration service had just rewritten.
    balancer.invalidateMigrationsFor(loadBalance.reservation.bindingRef, "failover");
    loadBalance.reservation.release();
    const next = balancer.plan({
      group: loadBalance.group,
      identity: loadBalance.identity,
      samples: this.#options.loadSamples?.(),
      exclude: new Set([fromTargetId]),
    });
    if (next === undefined) {
      return undefined;
    }
    const target = this.#options.targets.find(({ id }) => id === next.decision.targetId);
    if (target === undefined) {
      // The plan established a reservation for a node this pipeline cannot reach, and only
      // this method would ever release it. Hand it straight back, same as at selection: the
      // target count and the binding ledger must not hang on a node nobody owns.
      next.release();
      return undefined;
    }
    return { target, reservation: next, fromTargetId, group: loadBalance.group };
  }

  /** A refusal is a finished request: it must show up in the history with its reason. */
  async #recordRejectedRequest(
    request: IncomingMessage,
    context: ProxyRequestContext,
    error: LoadBalancerExhaustedError,
    requestBody: Uint8Array,
  ): Promise<void> {
    const host = error.logHost;
    if (host === undefined) {
      return;
    }
    const requestPath = request.url ?? "/";
    const durationMs = elapsedMilliseconds(context);
    const requestModel = requestModelFromBody(requestBody);
    const text = `No usable node in load balancing group ${error.group.id} (${error.group.name}).`;
    const baseRecord: TrafficRequestDraft = {
      ...withRequestDetails(
        this.#initialRecord(request, context, host),
        requestBody,
        requestBody,
        {
          target: host,
          requestModel,
          upstreamModel: requestModel,
          loadBalance: undefined,
        },
        [],
        [],
      ),
      pricing: completeRequestPricing(
        freezeRequestPricing(requestModel, host.modelPrices ?? [], {
          frozenAt: context.startedAt,
          targetId: host.id,
          targetName: host.name,
        }),
        endpointKind(requestPath),
        {},
        undefined,
      ),
      error: text,
    };
    const requestBlock = baseRecord.request;
    requestBlock.model_route = {
      ...requestBlock.model_route,
      route_mode: "load_balance",
      load_balance: {
        group_id: error.group.id,
        group_name: error.group.name,
        decision: "no_healthy_node",
        strategy: error.group.strategy,
        load: 0,
        failover_from: null,
        // The record lives in the first configured member's log because traffic logs are
        // written per target and no node ever received this request.
        logged_by: host.id,
      },
    };
    await host.trafficLog.write(
      finishedEvent(
        baseRecord,
        {
          status: 503,
          headers: { "content-type": ["text/plain; charset=utf-8"] },
          body: bytesPayload(Buffer.from(text, "utf8")),
        },
        durationMs,
      ),
    );
  }

  #selectTarget(request: IncomingMessage, requestBody: Uint8Array): PipelineTargetSelection {
    const candidates = this.#options.targets.map((target) => ({
      id: target.id,
      enabled: target.enabled,
      model_mappings: target.modelMappings,
      target,
    }));
    const mapping = selectTargetByModel(
      candidates,
      this.#options.defaultTargetId ?? "",
      requestBody,
    );
    const plain: PipelineTargetSelection = {
      target: mapping.target.target,
      requestModel: mapping.requestModel,
      upstreamModel: mapping.upstreamModel,
      loadBalance: undefined,
    };
    const balancer = this.#options.loadBalancer;
    const requestModel = mapping.requestModel;
    if (balancer === undefined || requestModel === undefined || requestModel === "") {
      return plain;
    }
    const match = balancer.matchGroup(requestModel);
    if (match === undefined) {
      return plain;
    }

    const identity = taskIdentity({
      payload: parseRequestJson(requestBody),
      headers: incomingHeaders(request),
      path: request.url ?? "/",
    });
    const reservation = balancer.plan({
      group: match.group,
      identity,
      samples: this.#options.loadSamples?.(),
    });
    if (reservation === undefined) {
      throw new LoadBalancerExhaustedError(
        match.group,
        this.#options.targets.find(({ id }) =>
          loadBalancerMemberTargetIds(match.group).includes(id),
        ),
      );
    }
    const chosen = candidates.find(({ id }) => id === reservation.decision.targetId);
    if (chosen === undefined) {
      // The balancer named a target this pipeline does not know; keep the old route and
      // hand the reservation back. It was established inside `plan()`, so nothing else
      // would ever release it and both counts would hang where nobody can reclaim them.
      reservation.release();
      return plain;
    }
    // The chosen member's own model id wins; an empty id forwards the requested model.
    // The member card's model mappings still never apply to a group hit.
    const memberModelId = loadBalancerMemberModelId(match.group, chosen.target.id);
    return {
      target: chosen.target,
      requestModel,
      upstreamModel: memberModelId ?? requestModel,
      loadBalance: { group: match.group, reservation, identity },
    };
  }

  #initialRecord(
    request: IncomingMessage,
    context: ProxyRequestContext,
    target: ProxyPipelineTarget,
  ): TrafficRequestDraft {
    const requestPath = request.url ?? "/";
    return {
      id: context.id,
      timestamp: context.startedAt,
      started_timestamp: context.startedAt,
      client: {
        host: request.socket.remoteAddress ?? "",
        port: request.socket.remotePort ?? 0,
      },
      target: {
        id: target.id,
        name: target.name,
        scheme: target.targetScheme,
        host: target.targetHost,
        port: target.targetPort,
        path: joinTargetPath(target.targetBasePath, requestPath),
      },
      ...(this.#options.pairId === undefined
        ? {}
        : { proxy: { id: this.#options.pairId, name: this.#options.pairName ?? "" } }),
      request: {
        method: request.method ?? "",
        path: requestPath,
        headers: incomingHeaders(request),
        body: bytesPayload(new Uint8Array()),
        body_pending: true,
      },
    };
  }
}

function elapsedMilliseconds(context: ProxyRequestContext): number {
  return Math.max(0, performance.now() - context.startedMonotonicMs);
}

function formatUpstreamError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `UpstreamError: ${String(error)}`;
  }
  const code = errorCode(error);
  const cause = error.cause;
  return [
    `${error.name}: ${error.message}`,
    ...(code === undefined ? [] : [`code=${code}`]),
    ...(cause === undefined ? [] : [`cause=${formatErrorCause(cause)}`]),
  ].join("; ");
}

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function formatErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = errorCode(cause);
    return `${cause.name}: ${cause.message}${code === undefined ? "" : ` (${code})`}`;
  }
  return String(cause);
}

export async function readRequestBody(
  request: IncomingMessage,
  options: BodyCollectorOptions = {},
): Promise<Buffer> {
  const collected = await collectBody(request, options);
  try {
    return await collected.bytes();
  } finally {
    await collected.cleanup();
  }
}

function responseJson(payload: ResponseLogPayload): unknown {
  try {
    return JSON.parse(payload.text) as unknown;
  } catch {
    return undefined;
  }
}

function withRequestDetails(
  record: Readonly<TrafficRequestDraft>,
  requestBody: Uint8Array,
  upstreamBody: Uint8Array,
  selection: PipelineTargetSelection,
  strippedFields: readonly string[],
  injectedFields: readonly string[],
): TrafficRequestDraft {
  const transformed =
    selection.upstreamModel !== undefined || strippedFields.length > 0 || injectedFields.length > 0;
  return {
    ...record,
    request: {
      ...record.request,
      body: bytesPayload(requestBody),
      body_pending: false,
      ...(transformed ? { upstream_body: bytesPayload(upstreamBody) } : {}),
      ...(strippedFields.length > 0 ? { stripped_fields: strippedFields } : {}),
      ...(injectedFields.length > 0 ? { injected_fields: injectedFields } : {}),
      ...(selection.requestModel === undefined
        ? {}
        : {
            model_route: {
              requested_model: selection.requestModel,
              ...(selection.upstreamModel === undefined
                ? {}
                : { upstream_model: selection.upstreamModel }),
              target_id: selection.target.id,
              target_name: selection.target.name,
              ...loadBalanceRoute(selection.loadBalance),
            },
          }),
    },
  };
}

/**
 * Short load balancing fields for `request.model_route`; candidate detail stays in runtime state.
 *
 * A move is not written here. The `move_*` keys are added later, by `#noteMigrationLanding`, once
 * the destination answered the connection: what the plan chose is not evidence of where the
 * request went, and a route that named a destination and then failed to reach it must not leave
 * a record claiming the move took effect.
 */
function loadBalanceRoute(loadBalance: LoadBalanceSelection | undefined): TrafficModelRoute {
  if (loadBalance === undefined) {
    return {};
  }
  const decision = loadBalance.reservation.decision;
  return {
    route_mode: "load_balance",
    load_balance: {
      group_id: decision.groupId,
      group_name: decision.groupName,
      decision: decision.decision,
      strategy: decision.strategy,
      matched_by: decision.matchedBy,
      load: decision.load,
      ...(decision.kvUsage === undefined ? {} : { kv_usage: decision.kvUsage }),
      ...(decision.metricsSource === undefined ? {} : { metrics_source: decision.metricsSource }),
      failover_from: null,
    },
  };
}

function parseRequestJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return undefined;
  }
}

function respondLoadBalancerUnavailable(response: ServerResponse, groupId: string): void {
  response.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "retry-after": "1",
    connection: "close",
  });
  response.end(`No load balancing node is available for group ${groupId}.`);
}

/** Errors that mean the upstream connection never came up, so switching is still safe. */
const CONNECTION_ERROR_CODES: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
];

function isConnectionPhaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = errorCode(current);
    if (code !== undefined && CONNECTION_ERROR_CODES.includes(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Point the stored route and target at the node that served the request after a switch. */
function applyFailoverRoute(
  baseRecord: TrafficRequestDraft,
  servedTarget: ProxyPipelineTarget,
  fromTargetId: string,
  selection: PipelineTargetSelection,
  forwarded: {
    readonly upstreamModel: string | undefined;
    readonly transformed: RequestTransformResult;
  },
): void {
  const loadBalance = selection.loadBalance;
  if (loadBalance === undefined) {
    return;
  }
  const requestPath = baseRecord.request.path;
  baseRecord.target = {
    ...baseRecord.target,
    id: servedTarget.id,
    name: servedTarget.name,
    scheme: servedTarget.targetScheme,
    host: servedTarget.targetHost,
    port: servedTarget.targetPort,
    path: joinTargetPath(servedTarget.targetBasePath, requestPath),
  };
  const modelRoute = baseRecord.request.model_route;
  const decision = loadBalance.reservation.decision;
  baseRecord.request = {
    ...baseRecord.request,
    model_route: {
      ...modelRoute,
      target_id: servedTarget.id,
      target_name: servedTarget.name,
      // The answering node may forward under another model name than the planned one.
      ...(forwarded.upstreamModel === undefined ? {} : { upstream_model: forwarded.upstreamModel }),
      // Written from the decision rather than carried over from the stored block on purpose:
      // a failover is not the move taking effect. The node that answered is not the destination
      // the migration service moved to, and `invalidateMigrationsFor` has already called that
      // intent off, so a record that kept the `move_*` keys here would claim a landing that
      // never happened. The group, the strategy and how the task was matched are the same
      // facts the plan recorded, restated from the decision that produced them.
      load_balance: {
        group_id: decision.groupId,
        group_name: decision.groupName,
        decision: "failover",
        strategy: decision.strategy,
        matched_by: decision.matchedBy,
        load: decision.load,
        ...(decision.kvUsage === undefined ? {} : { kv_usage: decision.kvUsage }),
        ...(decision.metricsSource === undefined ? {} : { metrics_source: decision.metricsSource }),
        failover_from: fromTargetId,
      },
    },
    // The retry sent its own body: what was written is what the answering node received.
    upstream_body: bytesPayload(forwarded.transformed.body),
    ...(forwarded.transformed.strippedFields.length > 0
      ? { stripped_fields: forwarded.transformed.strippedFields }
      : {}),
    ...(forwarded.transformed.injectedFields.length > 0
      ? { injected_fields: forwarded.transformed.injectedFields }
      : {}),
  };
}

function incomingHeaders(request: IncomingMessage): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name === undefined || value === undefined) {
      continue;
    }
    (headers[name] ??= []).push(value);
  }
  return headers;
}

function incomingHeaderEntries(request: IncomingMessage): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      entries.push([name, value]);
    }
  }
  return entries;
}

function upstreamRequestHeaders(
  request: IncomingMessage,
  target: ProxyPipelineTarget,
  bodySize: number,
): HeaderEntry[] {
  const clientHeaders = incomingHeaderEntries(request);
  return replaceContentLength(
    buildForwardHeaders(clientHeaders, {
      clientHost: request.socket.remoteAddress ?? "",
      targetApiKey: target.targetApiKey ?? "",
      targetHeaders: target.targetHeaders ?? [],
      targetHost: target.targetHost,
      targetPort: target.targetPort,
      targetScheme: target.targetScheme,
    }),
    bodySize,
    clientHeaders.some(([name]) => name.toLowerCase() === "content-length"),
  );
}

function forwardedResponseHeaders(upstream: IncomingMessage): [string, string][] {
  const forwarded = incomingHeaderEntries(upstream)
    .filter(([name]) => {
      const lowerName = name.toLowerCase();
      return lowerName !== "content-length" && !HOP_BY_HOP_HEADERS.has(lowerName);
    })
    .map(([name, value]): [string, string] => [name, value]);
  forwarded.push(["Connection", "close"]);
  return forwarded;
}

async function forwardResponseBody(
  upstream: IncomingMessage,
  response: ServerResponse,
  headRequest: boolean,
  decoder: ResponseBodyDecoder,
): Promise<void> {
  try {
    for await (const chunkValue of upstream) {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue as Uint8Array);
      // The client receives the bytes exactly as the upstream sent them,
      // `content-encoding` and all; only the traffic log sees decoded chunks.
      decoder.push(chunk);
      if (!headRequest && !response.write(chunk)) {
        await once(response, "drain");
      }
    }
    response.end();
  } finally {
    await decoder.finish();
  }
}

function isSseResponse(upstream: IncomingMessage): boolean {
  const contentType = upstream.headers["content-type"];
  const value = Array.isArray(contentType) ? contentType.join(",") : (contentType ?? "");
  return value.toLowerCase().includes("text/event-stream");
}
