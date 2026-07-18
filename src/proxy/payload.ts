export interface BytePayload {
  readonly size_bytes: number;
  readonly base64: string;
  readonly text: string;
  readonly stream_summary?: Readonly<Record<string, unknown>>;
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
  body: Pick<BytePayload, "size_bytes" | "stream_summary" | "text">,
): unknown {
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
