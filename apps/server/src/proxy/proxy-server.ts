import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";

import type { RuntimeProxy, RuntimeTarget } from "../config/schema.js";
import type { TrafficEvent } from "../storage/traffic-events.js";
import { CaptureTap, type CaptureTapResult, type StreamObserver } from "./capture-tap.js";
import { buildUpstreamRequestHeaders, rawHeadersToPairs, removeHopByHopHeaders, type HeaderPair } from "./headers.js";
import { routeAndTransformRequest, selectTargetByModel } from "./routing.js";
import { TargetAgentPool, type AgentPoolDiagnostics, type TargetAgentPoolOptions } from "./target-agent-pool.js";
import { joinTargetPath } from "./target-url.js";

export interface ProxyRequestContext {
  requestId: string;
  method: string;
  path: string;
  acceptedAt: string;
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  proxy: RuntimeProxy;
  maxRequestBodyBytes: number;
  requestCaptureBytes: number;
  responseCaptureBytes: number;
  totalRequestTimeoutMs: number;
  createRequestId?: () => string;
  onRequest?: (context: ProxyRequestContext) => void;
  createResponseObserver?: (context: ProxyRequestContext, contentType: string | undefined) => StreamObserver | null;
  onResponseCaptured?: (context: ProxyRequestContext, result: CaptureTapResult) => void;
  onRequestOutcome?: (context: ProxyRequestContext, outcome: ProxyRequestOutcome) => void;
  trafficSink?: TrafficEventSink;
  agentPool?: TargetAgentPool;
  agentOptions?: TargetAgentPoolOptions;
}

export interface TrafficEventSink {
  emit(event: TrafficEvent): void | Promise<void>;
}

export interface ProxyRequestOutcome {
  kind: "finished" | "aborted" | "timed_out" | "failed";
  code: string | null;
}

export class ProxyServer {
  readonly #options: ProxyServerOptions;
  readonly #server: http.Server;
  readonly #agentPool: TargetAgentPool;
  readonly #ownsAgentPool: boolean;
  #address: AddressInfo | null = null;

  public constructor(options: ProxyServerOptions) {
    if (!Number.isSafeInteger(options.maxRequestBodyBytes) || options.maxRequestBodyBytes < 1)
      throw new RangeError("Invalid request body limit");
    if (!Number.isSafeInteger(options.requestCaptureBytes) || options.requestCaptureBytes < 0)
      throw new RangeError("Invalid request capture limit");
    if (!Number.isSafeInteger(options.responseCaptureBytes) || options.responseCaptureBytes < 0)
      throw new RangeError("Invalid response capture limit");
    if (!Number.isSafeInteger(options.totalRequestTimeoutMs) || options.totalRequestTimeoutMs < 1)
      throw new RangeError("Invalid total request timeout");
    this.#options = options;
    this.#agentPool = options.agentPool ?? new TargetAgentPool(options.agentOptions);
    this.#ownsAgentPool = options.agentPool === undefined;
    this.#server = http.createServer((request, response) => {
      this.#handle(request, response);
    });
    this.#server.on("connect", (_request, socket) => {
      socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    this.#server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    this.#server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  }

  public async start(): Promise<AddressInfo> {
    if (this.#address) return this.#address;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        rejectPromise(error);
      };
      this.#server.once("error", onError);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off("error", onError);
        resolvePromise();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Proxy server has no TCP address");
    this.#address = address;
    return address;
  }

  public async stop(): Promise<void> {
    if (!this.#server.listening) {
      if (this.#ownsAgentPool) this.#agentPool.destroy();
      return;
    }
    this.#server.closeAllConnections();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
    this.#address = null;
    if (this.#ownsAgentPool) this.#agentPool.destroy();
  }

  public get address(): AddressInfo | null {
    return this.#address;
  }

  public agentDiagnostics(): AgentPoolDiagnostics {
    return this.#agentPool.diagnostics();
  }

  #handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    const context = {
      requestId: this.#options.createRequestId?.() ?? randomUUID(),
      method,
      path,
      acceptedAt: new Date().toISOString(),
    };
    this.#options.onRequest?.(context);
    const traffic = new RequestTraffic(context, request, this.#options.proxy, this.#options.trafficSink);
    const control = new RequestControl(this.#options.totalRequestTimeoutMs, (outcome) => {
      this.#options.onRequestOutcome?.(context, outcome);
      if (outcome.kind !== "finished") traffic.terminate(outcome);
      if (outcome.kind === "timed_out" && !response.headersSent && !response.destroyed) {
        respondUpstreamError(response, context.requestId, outcome.code ?? "REQUEST_TOTAL_TIMEOUT", 504);
      }
    });
    request.once("aborted", () => {
      control.terminate("aborted", "CLIENT_ABORTED");
    });
    response.once("close", () => {
      if (!response.writableFinished) control.terminate("aborted", "DOWNSTREAM_CLOSED");
    });
    if (shouldBufferJson(request.headers)) {
      void this.#handleBuffered(request, response, context, control, traffic).catch(() => {
        control.terminate("failed", "REQUEST_BODY_FAILED");
        if (!response.headersSent) response.writeHead(400).end();
        else response.destroy();
      });
      return;
    }
    const target = selectTargetByModel(this.#options.proxy, null).target;
    traffic.routed(target);
    const upstream = this.#createUpstream(request, response, target, method, path, context, control, traffic);
    const requestTap = new CaptureTap(this.#options.requestCaptureBytes);
    requestTap.once("finish", () => {
      const result = requestTap.result();
      traffic.body(rawHeadersToRecord(request.rawHeaders), result.captured, result.observedBytes);
    });
    request.pipe(requestTap).pipe(upstream);
  }

  async #handleBuffered(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    context: ProxyRequestContext,
    control: RequestControl,
    traffic: RequestTraffic,
  ): Promise<void> {
    const declared = parseContentLength(request.headers["content-length"]);
    if (declared !== null && declared > this.#options.maxRequestBodyBytes) {
      respondTooLarge(response);
      request.resume();
      return;
    }
    const body = await readBody(request, this.#options.maxRequestBodyBytes);
    if (body === null) {
      respondTooLarge(response);
      return;
    }
    const routed = routeAndTransformRequest(this.#options.proxy, body);
    traffic.body(
      rawHeadersToRecord(request.rawHeaders),
      body.subarray(0, this.#options.requestCaptureBytes),
      body.byteLength,
    );
    traffic.routed(routed.target);
    const upstream = this.#createUpstream(
      request,
      response,
      routed.target,
      context.method,
      context.path,
      context,
      control,
      traffic,
      routed.body.byteLength,
    );
    upstream.end(routed.body);
  }

  #createUpstream(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target: RuntimeTarget,
    method: string,
    path: string,
    context: ProxyRequestContext,
    control: RequestControl,
    traffic: RequestTraffic,
    bodyLength?: number,
  ): http.ClientRequest {
    const targetUrl = new URL(joinTargetPath(target.endpoint.basePath, path), target.endpoint.origin);
    const transport = targetUrl.protocol === "https:" ? https : http;
    let headers = buildUpstreamRequestHeaders(
      rawHeadersToPairs(request.rawHeaders),
      target.endpoint,
      { remoteAddress: request.socket.remoteAddress ?? "unknown", incomingProtocol: "http" },
      target.headers.map((header) => [header.name, header.value]),
      target.targetApiKey,
    );
    if (bodyLength !== undefined) {
      headers = headers.filter(([name]) => {
        const normalized = name.toLowerCase();
        return normalized !== "content-length" && normalized !== "transfer-encoding";
      });
      headers.push(["Content-Length", bodyLength.toString()]);
    }
    const upstream = transport.request(
      targetUrl,
      { method, headers: flattenHeaders(headers), signal: control.signal, agent: this.#agentPool.agentFor(target) },
      (upstreamResponse) => {
        clearTimeout(responseHeadersTimer);
        clearTimeout(connectTimer);
        const responseHeaders = removeHopByHopHeaders(rawHeadersToPairs(upstreamResponse.rawHeaders));
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          flattenHeaders(responseHeaders),
        );
        traffic.headers(upstreamResponse.statusCode ?? 502, rawHeadersToRecord(upstreamResponse.rawHeaders));
        const contentType = upstreamResponse.headers["content-type"];
        const tap = new CaptureTap(
          this.#options.responseCaptureBytes,
          this.#options.createResponseObserver?.(context, contentType) ?? null,
        );
        let idleTimer = setTimeout(() => {
          control.terminate("timed_out", "UPSTREAM_IDLE_TIMEOUT");
        }, target.timeouts.idleMs);
        const resetIdle = (): void => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            control.terminate("timed_out", "UPSTREAM_IDLE_TIMEOUT");
          }, target.timeouts.idleMs);
        };
        upstreamResponse.on("data", resetIdle);
        control.addCleanup(() => {
          clearTimeout(idleTimer);
          upstreamResponse.off("data", resetIdle);
        });
        void pipeline(upstreamResponse, tap, response).then(
          () => {
            this.#options.onResponseCaptured?.(context, tap.result());
            traffic.finished(upstreamResponse.statusCode ?? 502, tap.result());
            control.terminate("finished", null);
          },
          () => {
            this.#options.onResponseCaptured?.(context, tap.result());
            if (!control.terminated) control.terminate("failed", "UPSTREAM_BODY_FAILED");
            response.destroy();
          },
        );
      },
    );
    const connectTimer = setTimeout(() => {
      control.terminate("timed_out", "UPSTREAM_CONNECT_TIMEOUT");
    }, target.timeouts.connectMs);
    const responseHeadersTimer = setTimeout(() => {
      control.terminate("timed_out", "UPSTREAM_HEADERS_TIMEOUT");
    }, target.timeouts.responseHeadersMs);
    upstream.on("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else {
        const event = target.endpoint.protocol === "https:" ? "secureConnect" : "connect";
        const onConnect = (): void => {
          clearTimeout(connectTimer);
        };
        socket.once(event, onConnect);
        control.addCleanup(() => socket.off(event, onConnect));
      }
    });
    control.addCleanup(() => {
      clearTimeout(connectTimer);
      clearTimeout(responseHeadersTimer);
    });
    upstream.on("error", () => {
      if (!control.terminated) control.terminate("failed", "UPSTREAM_UNAVAILABLE");
      if (!response.headersSent && control.outcome?.kind !== "aborted") {
        const status = control.outcome?.kind === "timed_out" ? 504 : 502;
        respondUpstreamError(response, context.requestId, control.outcome?.code ?? "UPSTREAM_UNAVAILABLE", status);
      } else if (response.headersSent && !response.writableEnded) response.destroy();
    });
    return upstream;
  }
}

class RequestControl {
  readonly #controller = new AbortController();
  readonly #cleanups: (() => void)[] = [];
  readonly #onOutcome: (outcome: ProxyRequestOutcome) => void;
  #outcome: ProxyRequestOutcome | null = null;

  public constructor(totalTimeoutMs: number, onOutcome: (outcome: ProxyRequestOutcome) => void) {
    this.#onOutcome = onOutcome;
    const timer = setTimeout(() => {
      this.terminate("timed_out", "REQUEST_TOTAL_TIMEOUT");
    }, totalTimeoutMs);
    this.#cleanups.push(() => {
      clearTimeout(timer);
    });
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get terminated(): boolean {
    return this.#outcome !== null;
  }

  public get outcome(): ProxyRequestOutcome | null {
    return this.#outcome;
  }

  public addCleanup(cleanup: () => void): void {
    if (this.terminated) cleanup();
    else this.#cleanups.push(cleanup);
  }

  public terminate(kind: ProxyRequestOutcome["kind"], code: string | null): void {
    if (this.#outcome) return;
    this.#outcome = { kind, code };
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    if (kind !== "finished") this.#controller.abort();
    this.#onOutcome(this.#outcome);
  }
}

class RequestTraffic {
  readonly #context: ProxyRequestContext;
  readonly #sink: TrafficEventSink | undefined;
  readonly #startedAt = performance.now();
  #status = 502;
  #terminal = false;

  public constructor(
    context: ProxyRequestContext,
    request: http.IncomingMessage,
    proxy: RuntimeProxy,
    sink: TrafficEventSink | undefined,
  ) {
    this.#context = context;
    this.#sink = sink;
    this.#emit({
      kind: "accepted",
      requestId: context.requestId,
      timestamp: context.acceptedAt,
      method: context.method,
      path: context.path,
      client: { host: request.socket.remoteAddress ?? "unknown", port: request.socket.remotePort ?? 0 },
      proxy: { id: proxy.id, name: proxy.name },
      requestHeaders: rawHeadersToRecord(request.rawHeaders),
    });
  }

  public body(headers: Readonly<Record<string, string[]>>, captured: Uint8Array, observedBytes: number): void {
    this.#emit({
      kind: "body_read",
      requestId: this.#context.requestId,
      timestamp: now(),
      headers,
      captured,
      observedBytes,
    });
  }

  public routed(target: RuntimeTarget): void {
    this.#emit({
      kind: "routed",
      requestId: this.#context.requestId,
      timestamp: now(),
      target: { id: target.id, name: target.name, url: target.url },
    });
  }

  public headers(status: number, headers: Readonly<Record<string, string[]>>): void {
    this.#status = status;
    this.#emit({
      kind: "headers",
      requestId: this.#context.requestId,
      timestamp: now(),
      status,
      headers,
    });
  }

  public finished(status: number, result: CaptureTapResult): void {
    if (this.#terminal) return;
    this.#terminal = true;
    const counts = summaryCounts(result.summary);
    this.#emit({
      kind: "finished",
      requestId: this.#context.requestId,
      timestamp: now(),
      status,
      captured: result.captured,
      observedBytes: result.observedBytes,
      durationMs: this.#duration(),
      ...counts,
    });
  }

  public terminate(outcome: ProxyRequestOutcome): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#emit({
      kind: "error",
      requestId: this.#context.requestId,
      timestamp: now(),
      code: outcome.code ?? "UPSTREAM_FAILED",
      stage: stageFromCode(outcome.code),
      safeMessage: outcome.kind === "timed_out" ? "Upstream timed out" : "Proxy request did not complete",
      outcome: outcome.kind === "finished" ? "failed" : outcome.kind,
      durationMs: this.#duration(),
      status: this.#status,
    });
  }

  #duration(): number {
    return Math.max(0, performance.now() - this.#startedAt);
  }

  #emit(event: TrafficEvent): void {
    try {
      const pending = this.#sink?.emit(event);
      if (pending && typeof pending.then === "function") void pending.catch(() => undefined);
    } catch {
      // Traffic logging is best-effort and must not affect proxying.
    }
  }
}

function shouldBufferJson(headers: http.IncomingHttpHeaders): boolean {
  const encoding = headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return false;
  const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || Boolean(contentType?.endsWith("+json"));
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function respondTooLarge(response: http.ServerResponse): void {
  response.writeHead(413, { "content-type": "application/json", connection: "close" });
  response.end('{"error":"request_body_too_large"}');
}

function respondUpstreamError(response: http.ServerResponse, requestId: string, code: string, status: 502 | 504): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: { code, message: status === 504 ? "Upstream timed out" : "Upstream unavailable" },
      requestId,
    }),
  );
}

function flattenHeaders(headers: readonly HeaderPair[]): string[] {
  return headers.flatMap(([name, value]) => [name, value]);
}

function rawHeadersToRecord(rawHeaders: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, value] of rawHeadersToPairs(rawHeaders)) {
    const normalized = name.toLowerCase();
    (result[normalized] ??= []).push(value);
  }
  return result;
}

function summaryCounts(summary: unknown): { messageCount?: number; tokenCount?: number } {
  if (!summary || typeof summary !== "object") return {};
  const messageCount =
    "messageCount" in summary && typeof summary.messageCount === "number" ? summary.messageCount : null;
  const tokenCount = "tokenCount" in summary && typeof summary.tokenCount === "number" ? summary.tokenCount : null;
  return { ...(messageCount === null ? {} : { messageCount }), ...(tokenCount === null ? {} : { tokenCount }) };
}

function stageFromCode(code: string | null): string {
  if (!code) return "unknown";
  if (code.includes("CONNECT")) return "connect";
  if (code.includes("HEADERS")) return "response_headers";
  if (code.includes("IDLE") || code.includes("BODY")) return "response_body";
  if (code.includes("CLIENT") || code.includes("DOWNSTREAM")) return "downstream";
  return "request";
}

function now(): string {
  return new Date().toISOString();
}
