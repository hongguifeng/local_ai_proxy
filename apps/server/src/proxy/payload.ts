import type { CapturedPayload } from "@llm-proxy/contracts";

import { redactHeaders, sanitizeJsonValue } from "./redaction.js";

export type SafeCapturedContent = Readonly<{
  headers: Record<string, string[]>;
  body: CapturedPayload;
}>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function createCapturedPayload(captured: Uint8Array, observedBytes: number): CapturedPayload {
  if (!Number.isSafeInteger(observedBytes) || observedBytes < captured.byteLength) {
    throw new RangeError("observedBytes must be a safe integer greater than or equal to captured bytes");
  }
  const metadata = {
    observedBytes,
    capturedBytes: captured.byteLength,
    truncated: observedBytes > captured.byteLength,
  };
  if (observedBytes === 0) {
    return { kind: "empty", ...metadata };
  }

  let text: string;
  try {
    text = UTF8_DECODER.decode(captured);
  } catch {
    return { kind: "binary", base64: Buffer.from(captured).toString("base64"), ...metadata };
  }

  try {
    const value: unknown = JSON.parse(text);
    return { kind: "json", value: sanitizeJsonValue(value), ...metadata };
  } catch {
    return { kind: "text", text, ...metadata };
  }
}

export function createSafeCapturedContent(
  headers: Readonly<Record<string, readonly string[]>>,
  captured: Uint8Array,
  observedBytes: number,
): SafeCapturedContent {
  return {
    headers: redactHeaders(headers),
    body: createCapturedPayload(captured, observedBytes),
  };
}
