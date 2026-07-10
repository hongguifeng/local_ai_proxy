import { validateHeaderName, validateHeaderValue } from "node:http";

import type { RuntimeTargetEndpoint } from "../config/schema.js";
import { targetHostHeader } from "./target-url.js";

export type HeaderPair = readonly [name: string, value: string];

export type ForwardedRequestContext = Readonly<{
  remoteAddress: string;
  incomingProtocol: "http" | "https";
}>;

const FIXED_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_HEADERS = new Set(["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

export function rawHeadersToPairs(rawHeaders: readonly string[]): HeaderPair[] {
  if (rawHeaders.length % 2 !== 0) {
    throw new TypeError("Raw header array must contain name/value pairs");
  }
  const pairs: HeaderPair[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) {
      throw new TypeError("Raw header array must contain name/value pairs");
    }
    pairs.push([name, value]);
  }
  return pairs;
}

export function removeHopByHopHeaders(headers: readonly HeaderPair[]): HeaderPair[] {
  const connectionTokens = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) {
        const normalized = token.trim().toLowerCase();
        if (normalized) {
          connectionTokens.add(normalized);
        }
      }
    }
  }
  return headers.filter(([name]) => {
    const normalized = name.toLowerCase();
    return !FIXED_HOP_BY_HOP_HEADERS.has(normalized) && !connectionTokens.has(normalized);
  });
}

export function buildUpstreamRequestHeaders(
  clientHeaders: readonly HeaderPair[],
  endpoint: RuntimeTargetEndpoint,
  context: ForwardedRequestContext,
  targetHeaders: readonly HeaderPair[],
  targetApiKey: string,
): HeaderPair[] {
  assertValidHeaderPairs(targetHeaders);
  const originalHost = clientHeaders.find(([name]) => name.toLowerCase() === "host")?.[1];
  let forwarded = removeHopByHopHeaders(clientHeaders).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== "host" && !FORWARDED_HEADERS.has(normalized);
  });
  forwarded.push(["Host", targetHostHeader(endpoint)]);
  forwarded.push(["X-Forwarded-For", context.remoteAddress]);
  if (originalHost) {
    forwarded.push(["X-Forwarded-Host", originalHost]);
  }
  forwarded.push(["X-Forwarded-Proto", context.incomingProtocol]);
  forwarded = applyOverrides(forwarded, targetHeaders);

  const apiKey = targetApiKey.trim();
  if (apiKey) {
    const authorization = apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`;
    forwarded = applyOverrides(forwarded, [["Authorization", authorization]]);
  }
  assertValidHeaderPairs(forwarded);
  return forwarded;
}

export function assertValidHeaderPairs(headers: readonly HeaderPair[]): void {
  for (const [name, value] of headers) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
  }
}

function applyOverrides(headers: readonly HeaderPair[], overrides: readonly HeaderPair[]): HeaderPair[] {
  if (overrides.length === 0) {
    return [...headers];
  }
  const overriddenNames = new Set(overrides.map(([name]) => name.toLowerCase()));
  return [...headers.filter(([name]) => !overriddenNames.has(name.toLowerCase())), ...overrides];
}
