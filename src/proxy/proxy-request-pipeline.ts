import type { IncomingMessage, ServerResponse } from "node:http";

import type { RepositoryRecord } from "../persistence/index.js";
import { bytesPayload } from "./payload.js";
import type { ProxyRequestContext } from "./proxy-listener.js";
import { selectTargetByModel } from "./routing.js";
import { joinTargetPath } from "./target.js";

export interface TrafficLogWriter {
  write(record: Readonly<RepositoryRecord>): Promise<void>;
  update(record: Readonly<RepositoryRecord>): Promise<void>;
}

export interface ProxyPipelineTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly modelMappings: readonly { readonly listen: string; readonly upstream: string }[];
  readonly name: string;
  readonly targetScheme: "http" | "https";
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetBasePath: string;
  readonly trafficLog: TrafficLogWriter;
}

export interface ProxyRequestPipelineOptions {
  readonly defaultTargetId?: string;
  readonly pairId?: string;
  readonly pairName?: string;
  readonly targets: readonly ProxyPipelineTarget[];
}

export class ProxyRequestPipeline {
  readonly #options: ProxyRequestPipelineOptions;

  constructor(options: ProxyRequestPipelineOptions) {
    if (options.targets.length === 0) {
      throw new TypeError("Proxy request pipeline requires at least one target.");
    }
    this.#options = options;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: ProxyRequestContext,
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
    const requestBody = await readRequestBody(request);
    const selectedTarget = this.#selectTarget(requestBody);
    const baseRecord = withRequestBody(
      this.#initialRecord(request, context, selectedTarget),
      requestBody,
    );
    if (this.#options.targets.length > 1) {
      await selectedTarget.trafficLog.write(eventRecord(baseRecord, "request_received", 0));
    }
    await selectedTarget.trafficLog.update(eventRecord(baseRecord, "request_pending_response", 0));
    const responseBody = Buffer.from("Proxy forwarding is not implemented yet.", "utf8");
    response.writeHead(501, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    response.end(responseBody);
    await selectedTarget.trafficLog.write(
      eventRecord(baseRecord, "request_finished", 0, {
        status: 501,
        headers: { "content-type": ["text/plain; charset=utf-8"] },
        body: bytesPayload(responseBody),
      }),
    );
  }

  #selectTarget(requestBody: Uint8Array): ProxyPipelineTarget {
    const candidates = this.#options.targets.map((target) => ({
      id: target.id,
      enabled: target.enabled,
      model_mappings: target.modelMappings,
      target,
    }));
    return selectTargetByModel(candidates, this.#options.defaultTargetId ?? "", requestBody).target
      .target;
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

export async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
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

function withRequestBody(
  record: Readonly<RepositoryRecord>,
  requestBody: Uint8Array,
): RepositoryRecord {
  const request = record["request"];
  return {
    ...record,
    request: {
      ...(typeof request === "object" && request !== null && !Array.isArray(request)
        ? request
        : {}),
      body: bytesPayload(requestBody),
      body_pending: false,
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
