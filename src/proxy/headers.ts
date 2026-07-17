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

export function headersToDictionary(headers: Iterable<HeaderEntry>): Record<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const values = entries.get(name);
    if (values === undefined) {
      entries.set(name, [value]);
    } else {
      values.push(value);
    }
  }
  return Object.fromEntries(entries);
}

export function applyTargetHeaderSettings(
  headers: readonly HeaderEntry[],
  targetHeaders: readonly HeaderEntry[],
  targetApiKey: string,
): HeaderEntry[] {
  const overrideNames = new Set(targetHeaders.map(([name]) => name.toLowerCase()));
  let forwarded =
    overrideNames.size === 0
      ? [...headers]
      : headers.filter(([name]) => !overrideNames.has(name.toLowerCase()));
  forwarded.push(...targetHeaders);

  const apiKey = targetApiKey.trim();
  if (apiKey !== "") {
    forwarded = forwarded.filter(([name]) => name.toLowerCase() !== "authorization");
    forwarded.push([
      "Authorization",
      apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`,
    ]);
  }
  return forwarded;
}
