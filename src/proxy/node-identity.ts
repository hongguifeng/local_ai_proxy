import { parseTargetUrl } from "./target.js";

/**
 * A physical upstream identity, used for metric sampling, single-flight sampling and
 * aggregating load across replicas. Affinity still uses the stable `targetId` inside a
 * pair; this key exists so two spellings of the same engine are recognised as one node
 * without ever resolving DNS or rewriting a name into an address.
 */

const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 };
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface CanonicalNodeKeyOptions {
  /** Hosts that must collapse onto the same loopback identity. */
  readonly loopbackHosts?: ReadonlySet<string> | undefined;
}

export function canonicalNodeKey(
  rawTargetUrl: string,
  options: CanonicalNodeKeyOptions = {},
): string {
  return canonicalNodeKeyFromParsed(parseTargetUrl(rawTargetUrl), options);
}

/** Same key without throwing on an unparseable URL, for background sampling. */
export function tryCanonicalNodeKey(
  rawTargetUrl: string,
  options: CanonicalNodeKeyOptions = {},
): string | undefined {
  try {
    return canonicalNodeKey(rawTargetUrl, options);
  } catch {
    return undefined;
  }
}

function canonicalNodeKeyFromParsed(
  parsed: ReturnType<typeof parseTargetUrl>,
  options: CanonicalNodeKeyOptions,
): string {
  const scheme = parsed.scheme.toLowerCase();
  const host = normalizeHost(parsed.host.toLowerCase(), options.loopbackHosts);
  const defaultPort = DEFAULT_PORTS[scheme] ?? 0;
  const port = parsed.port === defaultPort ? "" : `:${parsed.port}`;
  const basePath = normalizeBasePath(parsed.basePath);
  return `${scheme}://${host}${port}${basePath}`;
}

function normalizeHost(host: string, loopbackHosts: ReadonlySet<string> | undefined): string {
  const loopback = loopbackHosts ?? LOOPBACK_HOSTS;
  if (loopback.has(host)) {
    return "127.0.0.1";
  }
  // A raw IPv6 literal needs its brackets to stay unambiguous inside an authority.
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}
