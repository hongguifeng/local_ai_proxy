import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";

import { createRequestId, localNowIso } from "../shared/index.js";

export interface ProxyRequestContext {
  readonly id: string;
  readonly startedAt: string;
  readonly startedMonotonicMs: number;
}

export type ProxyRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: ProxyRequestContext,
) => void | Promise<void>;

export interface ProxyListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly onRequest: ProxyRequestHandler;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

export interface ProxyListenerAddress {
  readonly host: string;
  readonly port: number;
}

export class ProxyListener {
  readonly #host: string;
  readonly #port: number;
  readonly #server: http.Server;

  constructor(options: ProxyListenerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    const createId = options.createId ?? createRequestId;
    const now = options.now ?? localNowIso;
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#server = http.createServer((request, response) => {
      const context: ProxyRequestContext = {
        id: createId(),
        startedAt: now(),
        startedMonotonicMs: monotonicNow(),
      };
      void Promise.resolve(options.onRequest(request, response, context)).catch(
        (error: unknown) => {
          if (!response.headersSent) {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          }
          response.end(error instanceof Error ? error.message : "Internal proxy error");
        },
      );
    });
  }

  async start(): Promise<ProxyListenerAddress> {
    if (this.#server.listening) {
      return this.address();
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
    return this.address();
  }

  address(): ProxyListenerAddress {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Proxy listener is not bound to a TCP address.");
    }
    const { address: host, port } = address;
    return { host, port };
  }

  async close(): Promise<void> {
    if (!this.#server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  closeAllConnections(): void {
    this.#server.closeAllConnections();
  }
}
