import { isRecord } from "../shared/index.js";
import { parseTargetUrl } from "../proxy/target.js";

/**
 * Import of upstream model lists and models.dev pricing.
 *
 * The admin UI offers a per-target action that asks the upstream for its
 * model list (`GET /models`, or `GET /v1/models` for Anthropic-style
 * endpoints), looks every model up in the models.dev catalog, and returns
 * ready-to-paste price rules converted with the user's price rate. The
 * models themselves are never written into any model mapping: only the
 * price rules are, which the UI inserts into the target's model_prices.
 */

export interface ModelsDevCost {
  readonly input: string;
  readonly output: string;
  readonly cacheRead?: string;
  readonly cacheWrite?: string;
}

export interface ImportedPriceRule {
  readonly model_pattern: string;
  readonly input_per_million: string;
  readonly output_per_million: string;
  readonly cache_read_per_million: string;
  readonly cache_write_per_million: string;
}

export interface ModelPriceImportRequest {
  readonly targetUrl: string;
  readonly targetApiKey?: string;
  readonly priceRate?: string;
}

export interface ModelPriceImportResult {
  readonly models: string[];
  readonly rules: ImportedPriceRule[];
  readonly unmatched: string[];
  readonly catalog: { readonly source: string; readonly fetchedAt: number };
}

interface CatalogEntry {
  readonly cost: ModelsDevCost;
  readonly provider: string;
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const pricePattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;

let cachedCatalog:
  { readonly fetchedAt: number; readonly entries: Map<string, CatalogEntry[]> } | undefined;

/** Test hook: forget the in-memory catalog cache. */
export function resetCatalogCache(): void {
  cachedCatalog = undefined;
}

function assertPricePattern(value: string): void {
  if (!pricePattern.test(value)) {
    throw new RangeError(
      `Price "${value}" must be a non-negative decimal string with at most 6 decimal places.`,
    );
  }
}

function decimalToMicros(value: string): bigint {
  assertPricePattern(value);
  const [integer, fraction = ""] = value.split(".");
  if (integer === undefined) {
    throw new RangeError(`Price "${value}" is missing its integer component.`);
  }
  return BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function microsToDecimalString(value: bigint): string {
  const integer = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction === "" ? integer.toString() : `${integer}.${fraction}`;
}

/**
 * Multiplies a USD-per-million price by the user's rate using exact integer
 * arithmetic, rounding half-up to six decimal places.
 */
export function convertUsdPrice(usdPerMillion: string, rate: string): string {
  assertPricePattern(usdPerMillion);
  assertPricePattern(rate);
  const product = decimalToMicros(usdPerMillion) * decimalToMicros(rate);
  const rounded = (product + 500_000n) / 1_000_000n;
  if (rounded > 1_000_000_000n) {
    throw new RangeError(`Price ${usdPerMillion} × ${rate} exceeds the 1000000 per-million limit.`);
  }
  return microsToDecimalString(rounded);
}

/** Converts a JSON number to its shortest decimal literal without exponent form. */
export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Price ${value} must be a non-negative finite number.`);
  }
  const text = String(value);
  const exponent = /^(\d)(?:\.(\d+))?e([+-])(\d+)$/u.exec(text);
  if (exponent === null) {
    return text;
  }
  const digits = `${exponent[1]}${exponent[2] ?? ""}`;
  const point = digits.length + (exponent[3] === "+" ? 1 : -1) * Number(exponent[4]);
  if (point <= 0) {
    return `0.${"0".repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${digits}${"0".repeat(point - digits.length)}`;
  }
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new Error(
      `Request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}.`);
  }
  const body = await readLimitedBody(response);
  if (body === undefined) {
    throw new Error(`${new URL(url).host} returned no body.`);
  }
  return body;
}

async function readLimitedBody(response: Response): Promise<string | undefined> {
  if (response.body === null) {
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response body exceeded ${MAX_BODY_BYTES} bytes.`);
    }
  }
  const text = new TextDecoder("utf-8").decode(concatChunks(chunks));
  return text === "" ? undefined : text;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseCost(raw: Record<string, unknown>): ModelsDevCost | undefined {
  const number = (value: unknown): string | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? numberToDecimalString(value)
      : undefined;
  const input = number(raw["input"]);
  const output = number(raw["output"]);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  const cacheRead = number(raw["cache_read"]);
  const cacheWrite = number(raw["cache_write"]);
  return {
    input: input ?? "0",
    output: output ?? "0",
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

/** Fetches and caches the models.dev catalog; a stale copy wins over failure. */
export async function fetchModelsDevCatalog(
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<{ readonly fetchedAt: number; readonly entries: Map<string, CatalogEntry[]> }> {
  if (cachedCatalog !== undefined && Date.now() - cachedCatalog.fetchedAt < CATALOG_TTL_MS) {
    return cachedCatalog;
  }
  let fetched: { fetchedAt: number; entries: Map<string, CatalogEntry[]> };
  try {
    const text = await fetchText(MODELS_DEV_URL, {}, timeoutMs);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const entries = new Map<string, CatalogEntry[]>();
    for (const [providerId, providerRaw] of Object.entries(parsed)) {
      if (!isRecord(providerRaw) || !isRecord(providerRaw["models"])) {
        continue;
      }
      const providerName =
        typeof providerRaw["name"] === "string" ? providerRaw["name"] : providerId;
      for (const [modelId, modelRaw] of Object.entries(providerRaw["models"])) {
        if (!isRecord(modelRaw) || !isRecord(modelRaw["cost"])) {
          continue;
        }
        const cost = parseCost(modelRaw["cost"]);
        if (cost === undefined) {
          continue;
        }
        const list = entries.get(modelId) ?? [];
        list.push({ cost, provider: providerName });
        entries.set(modelId, list);
      }
    }
    fetched = { fetchedAt: Date.now(), entries };
  } catch (error) {
    if (cachedCatalog !== undefined) {
      return cachedCatalog;
    }
    throw error;
  }
  cachedCatalog = fetched;
  return fetched;
}

function parseModelIds(text: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The upstream model list is not valid JSON.");
  }
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? Array.isArray(payload["data"])
        ? payload["data"]
        : Array.isArray(payload["models"])
          ? payload["models"]
          : []
      : [];
  const ids = new Set<string>();
  for (const item of candidates) {
    const id =
      typeof item === "string"
        ? item
        : isRecord(item) && typeof item["id"] === "string"
          ? item["id"]
          : "";
    if (id !== "") {
      ids.add(id);
    }
  }
  if (ids.size === 0) {
    throw new Error("The upstream model list did not contain any model ids.");
  }
  return [...ids].sort();
}

/**
 * Fetches the upstream's model list. Tries the OpenAI-style `{base}/models`
 * path first, then the Anthropic-style `{base}/v1/models` path when the base
 * does not already end in `/v1`. Authentication: the target's key is sent as
 * both `Authorization: Bearer` and `x-api-key` (with an `anthropic-version`
 * header) because extra headers are ignored by the endpoint that does not
 * expect them.
 */
export async function fetchUpstreamModelIds(
  targetUrl: string,
  targetApiKey?: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string[]> {
  const parsed = parseTargetUrl(targetUrl);
  const headers: Record<string, string> = {};
  if (targetApiKey !== undefined && targetApiKey !== "") {
    headers["authorization"] = `Bearer ${targetApiKey}`;
    headers["x-api-key"] = targetApiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  const paths = [`${parsed.basePath}/models`];
  const anthropicPath = `${parsed.basePath.replace(/\/v1$/u, "")}/v1/models`;
  if (anthropicPath !== paths[0]) {
    paths.push(anthropicPath);
  }
  let lastStatus: number | undefined;
  for (const path of paths) {
    const url = `${parsed.scheme}://${parsed.host}:${parsed.port}${path}`;
    const response = await fetchWithTimeout(url, headers, timeoutMs);
    if (response.ok) {
      const body = await readLimitedBody(response);
      if (body === undefined) {
        throw new Error("The upstream model list was empty.");
      }
      return parseModelIds(body);
    }
    lastStatus = response.status;
    if (response.status !== 404 && response.status !== 405) {
      throw new Error(`The upstream answered ${response.status} for ${path}.`);
    }
  }
  throw new Error(`The upstream has no model list endpoint (last status ${lastStatus ?? "?"}).`);
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new Error(
      `Request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converts every upstream model with a models.dev price into an imported
 * rule, scaled by the user's price rate. Models the catalog does not price
 * come back in `unmatched`. When several providers list the same model id,
 * the one whose name matches the upstream host wins.
 */
export function buildImportedPriceRules(
  models: readonly string[],
  catalog: { readonly entries: Map<string, CatalogEntry[]> },
  rate: string,
  host: string,
): { readonly rules: ImportedPriceRule[]; readonly unmatched: string[] } {
  assertPricePattern(rate);
  const byLower = new Map<string, CatalogEntry[]>();
  for (const [key, value] of catalog.entries) {
    const lower = key.toLowerCase();
    if (!byLower.has(lower)) {
      byLower.set(lower, value);
    }
  }
  const rules: ImportedPriceRule[] = [];
  const unmatched: string[] = [];
  for (const model of models) {
    const list = catalog.entries.get(model) ?? byLower.get(model.toLowerCase());
    let chosen: CatalogEntry | undefined;
    if (list !== undefined && list.length > 0) {
      chosen = list[0];
      const hostLower = host.toLowerCase();
      if (list.length > 1) {
        const preferred = list.find(
          (entry) =>
            entry.provider.toLowerCase() === hostLower ||
            hostLower.includes(entry.provider.toLowerCase()) ||
            entry.provider.toLowerCase().includes(hostLower),
        );
        if (preferred !== undefined) {
          chosen = preferred;
        }
      }
    }
    if (chosen === undefined) {
      unmatched.push(model);
      continue;
    }
    try {
      const cacheRead = chosen.cost.cacheRead ?? "0";
      const cacheWrite = chosen.cost.cacheWrite ?? "0";
      rules.push({
        model_pattern: model,
        input_per_million: convertUsdPrice(chosen.cost.input, rate),
        output_per_million: convertUsdPrice(chosen.cost.output, rate),
        cache_read_per_million: convertUsdPrice(cacheRead, rate),
        cache_write_per_million: convertUsdPrice(cacheWrite, rate),
      });
    } catch {
      // A price that cannot be represented with six decimal places cannot be
      // stored; treat the model as unmatched instead of failing the batch.
      unmatched.push(model);
    }
  }
  return { rules, unmatched };
}

/** Fetches the upstream's models and models.dev prices, and builds the rules. */
export async function importModelPrices(
  request: ModelPriceImportRequest,
): Promise<ModelPriceImportResult> {
  const parsed = parseTargetUrl(request.targetUrl);
  const rate = request.priceRate ?? "1";
  assertPricePattern(rate);
  const [models, catalog] = await Promise.all([
    fetchUpstreamModelIds(request.targetUrl, request.targetApiKey),
    fetchModelsDevCatalog(),
  ]);
  const { rules, unmatched } = buildImportedPriceRules(models, catalog, rate, parsed.host);
  return {
    models,
    rules,
    unmatched,
    catalog: { source: "models.dev", fetchedAt: catalog.fetchedAt },
  };
}
