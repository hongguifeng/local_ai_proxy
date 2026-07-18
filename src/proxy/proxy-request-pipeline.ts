import type { IncomingMessage, ServerResponse } from "node:http";

import type { RepositoryRecord } from "../persistence/index.js";
import { bytesPayload } from "./payload.js";
import type { ProxyRequestContext } from "./proxy-listener.js";
import { joinTargetPath } from "./target.js";

export interface TrafficLogWriter {
  write(record: Readonly<RepositoryRecord>): Promise<void>;
  update(record: Readonly<RepositoryRecord>): Promise<void>;
}

export interface ProxyPipelineTarget {
  readonly id: string;
  readonly name: string;
  readonly targetScheme: "http" | "https";
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetBasePath: string;
  readonly trafficLog: TrafficLogWriter;
}

export interface ProxyRequestPipelineOptions {
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
    response.writeHead(501, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    response.end("Proxy forwarding is not implemented yet.");
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

function eventRecord(
  baseRecord: Readonly<RepositoryRecord>,
  event: string,
  durationMs: number,
): RepositoryRecord {
  return {
    ...baseRecord,
    event,
    duration_ms: durationMs,
    response: { status: null, headers: {}, body: bytesPayload(new Uint8Array()) },
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
