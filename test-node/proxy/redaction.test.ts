import { describe, expect, it } from "vitest";

import { REDACTED, redactHeaders, redactJsonValue } from "../../src/proxy/redaction.js";

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

describe("redactJsonValue", () => {
  it("recursively redacts sensitive object keys inside arrays and objects", () => {
    expect(
      redactJsonValue({
        model: "demo",
        api_key: "sk-secret",
        nested: {
          Password: "password",
          children: [
            { access_token: "access" },
            { refresh_token: "refresh", token_count: 42 },
            "plain",
          ],
        },
        APIKEY: "another-secret",
        authorization_hint: "not an exact sensitive key",
      }),
    ).toEqual({
      model: "demo",
      api_key: REDACTED,
      nested: {
        Password: REDACTED,
        children: [
          { access_token: REDACTED },
          { refresh_token: REDACTED, token_count: 42 },
          "plain",
        ],
      },
      APIKEY: REDACTED,
      authorization_hint: "not an exact sensitive key",
    });
  });
});
