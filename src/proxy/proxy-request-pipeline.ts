import type { IncomingMessage, ServerResponse } from "node:http";

import type { RepositoryRecord } from "../persistence/index.js";
import { ActiveRequestRegistry } from "./active-requests.js";
import {
  collectBody,
  RequestBodyTooLargeError,
  type BodyCollectorOptions,
} from "./body-collector.js";
import { bytesPayload } from "./payload.js";
import {
  buildForwardHeaders,
  HOP_BY_HOP_HEADERS,
  replaceContentLength,
  type HeaderEntry,
} from "./headers.js";
import type { ProxyRequestContext } from "./proxy-listener.js";
import { transformRequestJsonFields } from "./request-transform.js";
import { rewriteRequestModel, selectTargetByModel } from "./routing.js";
import { joinTargetPath } from "./target.js";
import { openUpstreamResponse } from "./upstream-forwarder.js";

export interface TrafficLogWriter {
  write(record: Readonly<RepositoryRecord>): Promise<void>;
  update(record: Readonly<RepositoryRecord>): Promise<void>;
}

export interface ProxyPipelineTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly modelMappings: readonly { readonly listen: string; readonly upstream: string }[];
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
  readonly timeoutMs?: number;
  readonly trafficLog: TrafficLogWriter;
}

export interface ProxyRequestPipelineOptions {
  readonly activeRequests?: ActiveRequestRegistry;
  readonly bodyCollector?: BodyCollectorOptions;
  readonly defaultTargetId?: string;
  readonly pairId?: string;
  readonly pairName?: string;
  readonly targets: readonly ProxyPipelineTarget[];
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
    try {
      await this.#handleActiveRequest(request, response, context, signal);
    } finally {
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
      await target.trafficLog.write(
        eventRecord(this.#initialRecord(request, context, target), "request_received", 0),
      );
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
    const selection = this.#selectTarget(requestBody);
    const selectedTarget = selection.target;
    const rewrittenBody = rewriteRequestModel(requestBody, selection.upstreamModel);
    const transformed = transformRequestJsonFields(
      rewrittenBody,
      selectedTarget.stripRequestFields ?? new Set(),
      selectedTarget.injectRequestFields ?? {},
    );
    const baseRecord = withRequestDetails(
      this.#initialRecord(request, context, selectedTarget),
      requestBody,
      transformed.body,
      selection,
      transformed.strippedFields,
      transformed.injectedFields,
    );
    if (this.#options.targets.length > 1) {
      await selectedTarget.trafficLog.write(eventRecord(baseRecord, "request_received", 0));
    }
    await selectedTarget.trafficLog.update(eventRecord(baseRecord, "request_pending_response", 0));
    let responseBody: Buffer;
    let responseStatus: number;
    let responseHeaders: Record<string, string[]>;
    try {
      const upstream = await openUpstreamResponse({
        target: selectedTarget,
        method: request.method ?? "GET",
        path: joinTargetPath(selectedTarget.targetBasePath, request.url ?? "/"),
        headers: upstreamRequestHeaders(request, selectedTarget, transformed.body.byteLength),
        body: transformed.body,
        signal,
      });
      responseStatus = upstream.statusCode ?? 502;
      responseHeaders = incomingHeaders(upstream);
      const chunks: Buffer[] = [];
      for await (const chunk of upstream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      responseBody = Buffer.concat(chunks);
      response.writeHead(responseStatus, forwardedResponseHeaders(upstream));
      response.end(request.method === "HEAD" ? undefined : responseBody);
    } catch (error) {
      responseStatus = 502;
      responseHeaders = { "content-type": ["text/plain; charset=utf-8"] };
      responseBody = Buffer.from("Bad Gateway", "utf8");
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end(request.method === "HEAD" ? undefined : responseBody);
      baseRecord["error"] = error instanceof Error ? error.name : "UpstreamError";
    }
    await selectedTarget.trafficLog.write(
      eventRecord(baseRecord, "request_finished", 0, {
        status: responseStatus,
        headers: responseHeaders,
        body: bytesPayload(responseBody),
      }),
    );
  }

  #selectTarget(requestBody: Uint8Array): {
    readonly target: ProxyPipelineTarget;
    readonly requestModel: string | undefined;
    readonly upstreamModel: string | undefined;
  } {
    const candidates = this.#options.targets.map((target) => ({
      id: target.id,
      enabled: target.enabled,
      model_mappings: target.modelMappings,
      target,
    }));
    const selection = selectTargetByModel(
      candidates,
      this.#options.defaultTargetId ?? "",
      requestBody,
    );
    return {
      target: selection.target.target,
      requestModel: selection.requestModel,
      upstreamModel: selection.upstreamModel,
    };
  }

  #initialRecord(
    request: IncomingMessage,
    context: ProxyRequestContext,
    target: ProxyPipelineTarget,
  ): RepositoryRecord {
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

function eventRecord(
  baseRecord: Readonly<RepositoryRecord>,
  event: string,
  durationMs: number,
  response: Readonly<RepositoryRecord> = {
    status: null,
    headers: {},
    body: bytesPayload(new Uint8Array()),
  },
): RepositoryRecord {
  return {
    ...baseRecord,
    event,
    duration_ms: durationMs,
    response,
  };
}

function withRequestDetails(
  record: Readonly<RepositoryRecord>,
  requestBody: Uint8Array,
  upstreamBody: Uint8Array,
  selection: {
    readonly target: ProxyPipelineTarget;
    readonly requestModel: string | undefined;
    readonly upstreamModel: string | undefined;
  },
  strippedFields: readonly string[],
  injectedFields: readonly string[],
): RepositoryRecord {
  const request = record["request"];
  const transformed =
    selection.upstreamModel !== undefined || strippedFields.length > 0 || injectedFields.length > 0;
  return {
    ...record,
    request: {
      ...(typeof request === "object" && request !== null && !Array.isArray(request)
        ? request
        : {}),
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
            },
          }),
    },
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
  return incomingHeaderEntries(upstream)
    .filter(([name]) => {
      const lowerName = name.toLowerCase();
      return lowerName !== "content-length" && !HOP_BY_HOP_HEADERS.has(lowerName);
    })
    .map(([name, value]) => [name, value]);
}
