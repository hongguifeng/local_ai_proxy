import http, { type IncomingMessage, type ServerResponse } from "node:http";

export type ProxyRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export interface ProxyListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly onRequest: ProxyRequestHandler;
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
    this.#server = http.createServer((request, response) => {
      void Promise.resolve(options.onRequest(request, response)).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end(error instanceof Error ? error.message : "Internal proxy error");
      });
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
}
