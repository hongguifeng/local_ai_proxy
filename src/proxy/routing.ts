import { isRecord } from "../shared/index.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function requestModelFromBody(requestBody: Uint8Array): string | undefined {
  let loaded: unknown;
  try {
    loaded = JSON.parse(UTF8_DECODER.decode(requestBody));
  } catch {
    return undefined;
  }
  if (!isRecord(loaded)) {
    return undefined;
  }
  const model = loaded["model"];
  return typeof model === "string" ? model : undefined;
}
