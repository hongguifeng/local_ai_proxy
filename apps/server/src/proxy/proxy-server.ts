import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

export interface ProxyRequestContext {
  requestId: string;
  method: string;
  path: string;
  acceptedAt: string;
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  upstream: URL;
  createRequestId?: () => string;
  onRequest?: (context: ProxyRequestContext) => void;
}

export class ProxyServer {
  readonly #options: ProxyServerOptions;
  readonly #server: http.Server;
  #address: AddressInfo | null = null;

  public constructor(options: ProxyServerOptions) {
    if (options.upstream.protocol !== "http:" && options.upstream.protocol !== "https:")
      throw new TypeError("Proxy upstream must use HTTP or HTTPS");
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
    const target = new URL(path, this.#options.upstream);
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, { method, headers: request.headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":"upstream_unavailable"}');
      } else response.destroy();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }
}
