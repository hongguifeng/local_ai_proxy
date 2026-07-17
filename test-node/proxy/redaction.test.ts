import { describe, expect, it } from "vitest";

import { REDACTED, redactHeaders } from "../../src/proxy/redaction.js";

describe("redactHeaders", () => {
  it("redacts sensitive scalar and multi-value headers case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: ["Bearer first", "Bearer second"],
        "proxy-authorization": "Basic secret",
        "X-Api-Key": ["key-one"],
        "API-KEY": "key-two",
        "Content-Type": ["application/json"],
      }),
    ).toEqual({
      Authorization: [REDACTED, REDACTED],
      "proxy-authorization": REDACTED,
      "X-Api-Key": [REDACTED],
      "API-KEY": REDACTED,
      "Content-Type": ["application/json"],
    });
  });

  it("returns a separate header object", () => {
    const headers = { "X-Fixture": ["value"] };
    expect(redactHeaders(headers)).not.toBe(headers);
  });
});
