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
        timeout: options.target.timeoutMs,
        rejectUnauthorized: options.target.rejectUnauthorized,
      },
      resolve,
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
