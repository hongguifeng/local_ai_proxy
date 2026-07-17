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

export interface ForwardHeaderOptions {
  readonly clientHost: string;
  readonly targetApiKey: string;
  readonly targetHeaders: readonly HeaderEntry[];
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetScheme: "http" | "https";
}

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

export function buildForwardHeaders(
  clientHeaders: readonly HeaderEntry[],
  options: ForwardHeaderOptions,
): HeaderEntry[] {
  const forwarded = clientHeaders.filter(([name]) => {
    const lowerName = name.toLowerCase();
    return lowerName !== "host" && !HOP_BY_HOP_HEADERS.has(lowerName);
  });
  const originalHost = clientHeaders.find(([name]) => name.toLowerCase() === "host")?.[1] ?? "";
  forwarded.push(
    ["Host", formatHostHeader(options.targetHost, options.targetPort, options.targetScheme)],
    ["X-Forwarded-For", options.clientHost],
    ["X-Forwarded-Host", originalHost],
  );
  return applyTargetHeaderSettings(forwarded, options.targetHeaders, options.targetApiKey);
}

function formatHostHeader(host: string, port: number, scheme: "http" | "https"): string {
  const defaultPort = scheme === "https" ? 443 : 80;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port === defaultPort ? formattedHost : `${formattedHost}:${port}`;
}
