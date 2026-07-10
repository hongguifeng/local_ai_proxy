import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";

import type { RuntimeProxy, RuntimeTarget } from "../config/schema.js";
import { CaptureTap, type CaptureTapResult, type StreamObserver } from "./capture-tap.js";
import { buildUpstreamRequestHeaders, rawHeadersToPairs, removeHopByHopHeaders, type HeaderPair } from "./headers.js";
import { routeAndTransformRequest, selectTargetByModel } from "./routing.js";
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
  responseCaptureBytes: number;
  createRequestId?: () => string;
  onRequest?: (context: ProxyRequestContext) => void;
  createResponseObserver?: (context: ProxyRequestContext, contentType: string | undefined) => StreamObserver | null;
  onResponseCaptured?: (context: ProxyRequestContext, result: CaptureTapResult) => void;
}

export class ProxyServer {
  readonly #options: ProxyServerOptions;
  readonly #server: http.Server;
  #address: AddressInfo | null = null;

  public constructor(options: ProxyServerOptions) {
    if (!Number.isSafeInteger(options.maxRequestBodyBytes) || options.maxRequestBodyBytes < 1)
      throw new RangeError("Invalid request body limit");
    if (!Number.isSafeInteger(options.responseCaptureBytes) || options.responseCaptureBytes < 0)
      throw new RangeError("Invalid response capture limit");
    this.#options = options;
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
    if (!this.#server.listening) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
    this.#address = null;
  }

  public get address(): AddressInfo | null {
    return this.#address;
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
    if (shouldBufferJson(request.headers)) {
      void this.#handleBuffered(request, response, context).catch(() => {
        if (!response.headersSent) response.writeHead(400).end();
        else response.destroy();
      });
      return;
    }
    const target = selectTargetByModel(this.#options.proxy, null).target;
    const upstream = this.#createUpstream(request, response, target, method, path, context);
    request.pipe(upstream);
  }

  async #handleBuffered(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    context: ProxyRequestContext,
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
    const upstream = this.#createUpstream(
      request,
      response,
      routed.target,
      context.method,
      context.path,
      context,
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
    const upstream = transport.request(targetUrl, { method, headers: flattenHeaders(headers) }, (upstreamResponse) => {
      const responseHeaders = removeHopByHopHeaders(rawHeadersToPairs(upstreamResponse.rawHeaders));
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        flattenHeaders(responseHeaders),
      );
      const contentType = upstreamResponse.headers["content-type"];
      const tap = new CaptureTap(
        this.#options.responseCaptureBytes,
        this.#options.createResponseObserver?.(context, contentType) ?? null,
      );
      void pipeline(upstreamResponse, tap, response).then(
        () => {
          this.#options.onResponseCaptured?.(context, tap.result());
        },
        () => {
          this.#options.onResponseCaptured?.(context, tap.result());
          response.destroy();
        },
      );
    });
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":"upstream_unavailable"}');
      } else response.destroy();
    });
    request.on("aborted", () => upstream.destroy());
    return upstream;
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

function flattenHeaders(headers: readonly HeaderPair[]): string[] {
  return headers.flatMap(([name, value]) => [name, value]);
}
