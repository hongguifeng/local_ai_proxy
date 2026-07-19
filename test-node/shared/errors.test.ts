import { describe, expect, it } from "vitest";

import {
  ApplicationError,
  badRequest,
  notFound,
  toHttpError,
  upstreamError,
} from "../../src/shared/errors.js";

describe("application errors", () => {
  it("maps exposed application errors to JSON HTTP responses", () => {
    expect(toHttpError(badRequest("Invalid config.", { field: "port" }))).toEqual({
      body: {
        code: "bad_request",
        details: { field: "port" },
        error: "Invalid config.",
      },
      statusCode: 400,
    });
    expect(toHttpError(notFound("Pair missing."))).toEqual({
      body: { code: "not_found", error: "Pair missing." },
      statusCode: 404,
    });
  });

  it("hides upstream and unexpected internal details", () => {
    const cause = new Error("secret upstream detail");
    expect(toHttpError(upstreamError("sensitive", { cause }))).toEqual({
      body: { code: "upstream_error", error: "Bad Gateway" },
      statusCode: 502,
    });
    expect(toHttpError(cause)).toEqual({
      body: { code: "internal_error", error: "Internal Server Error" },
      statusCode: 500,
    });
  });

  it("preserves Error causes for internal diagnostics", () => {
    const cause = new Error("root cause");
    const error = new ApplicationError("wrapper", {
      cause,
      code: "internal_error",
      statusCode: 500,
    });

    expect(error.cause).toBe(cause);
    expect(error.expose).toBe(false);
  });
});
