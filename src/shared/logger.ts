import type { Writable } from "node:stream";

export type LogLevel = "debug" | "error" | "info" | "warn";
export type LogContext = Readonly<Record<string, unknown>>;

export interface StructuredLoggerOptions {
  readonly clock?: () => Date;
  readonly destination?: Writable;
  readonly minimumLevel?: LogLevel;
  readonly service?: string;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "authorization",
  "body",
  "original_request_body",
  "password",
  "proxy-authorization",
  "refresh_token",
  "request_body",
  "response_body",
  "secret",
  "target_api_key",
  "token",
  "upstream_body",
  "x-api-key",
]);

export class StructuredLogger {
  readonly #clock: () => Date;
  readonly #destination: Writable;
  readonly #minimumLevel: LogLevel;
  readonly #service: string;

  constructor(options: StructuredLoggerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#destination = options.destination ?? process.stderr;
    this.#minimumLevel = options.minimumLevel ?? "info";
    this.#service = options.service ?? "llm-proxy";
  }

  debug(message: string, context: LogContext = {}): void {
    this.#write("debug", message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.#write("info", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.#write("warn", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.#write("error", message, context);
  }

  #write(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#minimumLevel]) {
      return;
    }
    const entry = {
      timestamp: this.#clock().toISOString(),
      level,
      service: this.#service,
      message,
      ...redactLogContext(context),
    };
    this.#destination.write(`${JSON.stringify(entry)}\n`);
  }
}

export function redactLogContext(context: LogContext): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const redacted = redactValue(context, seen);
  return isPlainRecord(redacted) ? redacted : {};
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactValue(item, seen);
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
