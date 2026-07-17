export type ApplicationErrorCode =
  "bad_request" | "conflict" | "internal_error" | "not_found" | "upstream_error";

export interface ApplicationErrorOptions extends ErrorOptions {
  readonly code: ApplicationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly expose?: boolean;
  readonly statusCode: number;
}

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly expose: boolean;
  readonly statusCode: number;

  constructor(message: string, options: ApplicationErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ApplicationError";
    this.code = options.code;
    this.details = options.details;
    this.expose = options.expose ?? options.statusCode < 500;
    this.statusCode = options.statusCode;
  }
}

export interface HttpErrorBody {
  readonly code: ApplicationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly error: string;
}

export interface HttpErrorResponse {
  readonly body: HttpErrorBody;
  readonly statusCode: number;
}

export function badRequest(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ApplicationError {
  return new ApplicationError(message, {
    code: "bad_request",
    ...(details === undefined ? {} : { details }),
    statusCode: 400,
  });
}

export function notFound(message: string): ApplicationError {
  return new ApplicationError(message, { code: "not_found", statusCode: 404 });
}

export function conflict(message: string): ApplicationError {
  return new ApplicationError(message, { code: "conflict", statusCode: 409 });
}

export function upstreamError(message: string, options: ErrorOptions = {}): ApplicationError {
  return new ApplicationError(message, {
    cause: options.cause,
    code: "upstream_error",
    expose: false,
    statusCode: 502,
  });
}

export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof ApplicationError) {
    const body: HttpErrorBody = {
      code: error.code,
      error: error.expose ? error.message : publicMessage(error.statusCode),
      ...(error.expose && error.details !== undefined ? { details: error.details } : {}),
    };
    return { body, statusCode: error.statusCode };
  }
  return {
    body: { code: "internal_error", error: "Internal Server Error" },
    statusCode: 500,
  };
}

function publicMessage(statusCode: number): string {
  if (statusCode === 502) {
    return "Bad Gateway";
  }
  return "Internal Server Error";
}
