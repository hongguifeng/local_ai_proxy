const DEFAULT_PORTS = {
  http: 80,
  https: 443,
} as const;

export interface ParsedTargetUrl {
  readonly scheme: keyof typeof DEFAULT_PORTS;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly displayUrl: string;
}

export function parseTargetUrl(rawTargetUrl: string): ParsedTargetUrl {
  const schemeMatch = /^(https?):\/\//i.exec(rawTargetUrl);
  if (schemeMatch === null) {
    throw invalidTargetUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(rawTargetUrl);
  } catch {
    throw invalidTargetUrl();
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if ((scheme !== "http" && scheme !== "https") || parsed.hostname === "") {
    throw invalidTargetUrl();
  }

  return {
    scheme,
    host: stripIpv6Brackets(parsed.hostname),
    port: parsed.port === "" ? DEFAULT_PORTS[scheme] : parsePort(parsed.port),
    basePath: parsed.pathname.replace(/\/+$/, ""),
    displayUrl: rawTargetUrl.replace(/\/+$/, ""),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw invalidTargetUrl();
  }
  return port;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function invalidTargetUrl(): TypeError {
  return new TypeError(
    "target_url must look like http://host[:port][/base-path] or https://host[:port][/base-path].",
  );
}
