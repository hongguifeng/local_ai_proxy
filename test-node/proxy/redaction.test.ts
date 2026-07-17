import { describe, expect, it } from "vitest";

import {
  REDACTED,
  redactHeaders,
  redactJsonValue,
  redactRecord,
} from "../../src/proxy/redaction.js";

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

describe("redactRecord", () => {
  it("redacts a deep log copy without changing the actual forwarding record", () => {
    const requestText = '{"model":"demo","api_key":"sk-secret","nested":[{"token":"value"}]}';
    const upstreamText = '{"authorization":"body-secret","stream":true}';
    const record = {
      request: {
        headers: { Authorization: ["Bearer secret-token"] },
        body: {
          size_bytes: Buffer.byteLength(requestText),
          base64: Buffer.from(requestText).toString("base64"),
          text: requestText,
        },
        upstream_body: {
          size_bytes: Buffer.byteLength(upstreamText),
          base64: Buffer.from(upstreamText).toString("base64"),
          text: upstreamText,
        },
      },
      response: { headers: { "Content-Type": ["application/json"] }, body: { text: "plain" } },
    };

    const redacted = redactRecord(record);

    expect(redacted).toMatchObject({
      request: {
        headers: { Authorization: [REDACTED] },
        body: {
          base64: "",
          text: `{"model":"demo","api_key":"${REDACTED}","nested":[{"token":"${REDACTED}"}]}`,
        },
        upstream_body: {
          base64: "",
          text: `{"authorization":"${REDACTED}","stream":true}`,
        },
      },
      response: { headers: { "Content-Type": ["application/json"] }, body: { text: "plain" } },
    });
    expect(record.request.headers.Authorization).toEqual(["Bearer secret-token"]);
    expect(record.request.body.text).toBe(requestText);
    expect(record.request.body.base64).not.toBe("");
    expect(record.request.upstream_body.text).toBe(upstreamText);

    const redactedRequest = redacted["request"] as Record<string, Record<string, string[]>>;
    redactedRequest["headers"]?.["Authorization"]?.push("mutated-copy");
    expect(record.request.headers.Authorization).toEqual(["Bearer secret-token"]);
  });
});
