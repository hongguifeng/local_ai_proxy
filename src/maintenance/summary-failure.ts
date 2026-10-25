import { ApplicationError } from "../shared/index.js";

/**
 * How a summary-model failure is reported. One place states the code, the status and
 * whether the message may be shown, so rewording a message cannot change an HTTP
 * status, and the internal log can still name what really happened.
 */

/**
 * A summary model call that produced no usable output. The message is a sentence written
 * here, never copied from the upstream body, so it is safe to show the user; the original
 * failure stays available as `cause` for the internal log.
 */
export function summaryModelFailure(
  message: string,
  cause?: unknown,
  details?: Readonly<Record<string, unknown>>,
): ApplicationError {
  return new ApplicationError(message, {
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
    code: "upstream_error",
    expose: true,
    statusCode: 502,
  });
}

/** The name of an error, or `UnknownError` when it is not an `Error`. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** The `cause` of an error when it carries one. */
export function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}
