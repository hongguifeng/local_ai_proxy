export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type HeaderEntry = readonly [name: string, value: string];

export function parseHeaderOverrides(
  rawHeaders: readonly string[] | null | undefined,
): HeaderEntry[] {
  const parsed: HeaderEntry[] = [];
  for (const rawHeader of rawHeaders ?? []) {
    const separatorIndex = rawHeader.indexOf(":");
    if (separatorIndex < 0) {
      throw new TypeError(
        `Invalid header override ${JSON.stringify(rawHeader)}. Expected 'Name: value'.`,
      );
    }
    const name = rawHeader.slice(0, separatorIndex).trim();
    if (name === "") {
      throw new TypeError(
        `Invalid header override ${JSON.stringify(rawHeader)}. Header name is empty.`,
      );
    }
    parsed.push([name, rawHeader.slice(separatorIndex + 1).trim()]);
  }
  return parsed;
}
