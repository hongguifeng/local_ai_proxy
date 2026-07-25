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
  // Node 原生 HTTP 客户端是事件/回调风格；这里包装成 Promise，
  // 调用方即可用 await 把“拿到响应头”和后续流式读取串成清晰的控制流。
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
    if (options.target.timeoutMs !== undefined) {
      // setTimeout 只通知超时，必须 destroy 请求才能真正终止 socket 并触发 error。
      request.setTimeout(options.target.timeoutMs, () => {
        request.destroy(new UpstreamTimeoutError(options.target.timeoutMs ?? 0));
      });
    }
    request.once("error", reject);
    request.end(options.body);
  });
}
