export interface BytePayload {
  readonly size_bytes: number;
  readonly base64: string;
  readonly text: string;
  readonly stream_summary?: Readonly<Record<string, unknown>>;
  readonly captured_bytes?: number;
  readonly sha256?: string;
  readonly truncated?: boolean;
  readonly truncation_reason?: string;
}

const UTF8_DECODER = new TextDecoder("utf-8");

export function bytesPayload(data: Uint8Array): BytePayload {
  return {
    size_bytes: data.byteLength,
    base64: Buffer.from(data).toString("base64"),
    text: UTF8_DECODER.decode(data),
  };
}

export function bodyJsonValue(
  body: Pick<
    BytePayload,
    | "captured_bytes"
    | "sha256"
    | "size_bytes"
    | "stream_summary"
    | "text"
    | "truncated"
    | "truncation_reason"
  >,
): unknown {
  if (body.truncated === true) {
    return {
      text: body.text,
      size_bytes: body.size_bytes,
      captured_bytes: body.captured_bytes ?? Buffer.byteLength(body.text),
      sha256: body.sha256 ?? "",
      truncated: true,
      truncation_reason: body.truncation_reason ?? "log_body_limit",
      ...(body.stream_summary === undefined ? {} : { stream_summary: body.stream_summary }),
    };
  }
  if (body.stream_summary !== undefined) {
    return { stream_summary: body.stream_summary };
  }
  if (body.text === "") {
    return null;
  }
  const compacted = compactSseValue(body.text);
  if (compacted !== undefined) {
    return compacted;
  }
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    return { text: body.text, size_bytes: body.size_bytes };
  }
}
import { compactSseValue } from "./streams.js";
