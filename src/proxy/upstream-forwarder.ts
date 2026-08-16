import http, { type IncomingMessage } from "node:http";
import https from "node:https";

import type { HeaderEntry } from "./headers.js";

export interface UpstreamTarget {
  readonly rejectUnauthorized?: boolean;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetScheme: "http" | "https";
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
    const headers = options.headers.filter(([name]) => name.toLowerCase() !== "connection");
    headers.push(["Connection", "close"]);
    const request = transport.request(
      {
        agent: false,
        host: options.target.targetHost,
        port: options.target.targetPort,
        method: options.method,
        path: options.path,
        headers: headers.flatMap(([name, value]) => [name, value]),
        signal: options.signal,
        rejectUnauthorized: options.target.rejectUnauthorized,
      },
      resolve,
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
