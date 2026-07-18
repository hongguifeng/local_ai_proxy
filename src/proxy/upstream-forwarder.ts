import http, { type IncomingMessage } from "node:http";
import https from "node:https";

import type { HeaderEntry } from "./headers.js";

export interface UpstreamTarget {
  readonly rejectUnauthorized?: boolean;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetScheme: "http" | "https";
  readonly timeoutMs?: number;
}

export interface OpenUpstreamResponseOptions {
  readonly body: Uint8Array;
  readonly headers: readonly HeaderEntry[];
  readonly method: string;
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly target: UpstreamTarget;
}

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream request timed out after ${timeoutMs} ms.`);
    this.name = "UpstreamTimeoutError";
  }
}

export function openUpstreamResponse(
  options: OpenUpstreamResponseOptions,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = options.target.targetScheme === "https" ? https : http;
    const request = transport.request(
      {
        host: options.target.targetHost,
        port: options.target.targetPort,
        method: options.method,
        path: options.path,
        headers: options.headers.flatMap(([name, value]) => [name, value]),
        signal: options.signal,
        rejectUnauthorized: options.target.rejectUnauthorized,
      },
      resolve,
    );
    if (options.target.timeoutMs !== undefined) {
      request.setTimeout(options.target.timeoutMs, () => {
        request.destroy(new UpstreamTimeoutError(options.target.timeoutMs ?? 0));
      });
    }
    request.once("error", reject);
    request.end(options.body);
  });
}
