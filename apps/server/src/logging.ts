import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const REDACT_PATHS = [
  "apiKey",
  "targetApiKey",
  "authorization",
  "headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "request.headers.authorization",
  "config.proxies[*].targets[*].targetApiKey",
];

export type RuntimeLogger = Pick<Logger, "child" | "debug" | "info" | "warn" | "error">;

export interface RuntimeLoggerOptions {
  level?: string;
  development?: boolean;
  stream?: DestinationStream;
}

export function createRuntimeLogger(options: RuntimeLoggerOptions = {}): Logger {
  const base: LoggerOptions = {
    level: options.level ?? "info",
    base: null,
    messageKey: "message",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
  if (options.stream) return pino(base, options.stream);
  if (options.development) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, singleLine: true, translateTime: "SYS:standard" },
      },
    });
  }
  return pino(base);
}

export class RateLimitedLogger {
  readonly #logger: RuntimeLogger;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #last = new Map<string, number>();

  public constructor(logger: RuntimeLogger, intervalMs = 30_000, now: () => number = Date.now) {
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  public warn(code: string, fields: Record<string, unknown>, message: string): boolean {
    const current = this.#now();
    const previous = this.#last.get(code);
    if (previous !== undefined && current - previous < this.#intervalMs) return false;
    this.#last.set(code, current);
    this.#logger.warn({ ...fields, code, event: "component_fault" }, message);
    return true;
  }
}
