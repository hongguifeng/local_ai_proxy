import { describe, expect, it } from "vitest";

import {
  REDACTED,
  redactEvent,
  redactHeaders,
  redactJsonValue,
} from "../../src/proxy/redaction.js";
import type { TrafficFinishedEvent } from "../../src/proxy/traffic-event.js";

describe("redactHeaders", () => {
  it("redacts sensitive multi-value headers case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: ["Bearer first", "Bearer second"],
        "proxy-authorization": ["Basic secret"],
        "X-Api-Key": ["key-one"],
        "API-KEY": ["key-two"],
        "Content-Type": ["application/json"],
      }),
    ).toEqual({
      Authorization: [REDACTED, REDACTED],
      "proxy-authorization": [REDACTED],
      "X-Api-Key": [REDACTED],
      "API-KEY": [REDACTED],
      "Content-Type": ["application/json"],
    });
  });

  it("returns a separate header object with separate value lists", () => {
    const headers = { "X-Fixture": ["value"] };
    const redacted = redactHeaders(headers);

    expect(redacted).not.toBe(headers);
    expect(redacted["X-Fixture"]).not.toBe(headers["X-Fixture"]);
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

describe("redactEvent", () => {
  it("[AI-06] redacts a deep copy without touching the record still being forwarded", () => {
    const requestText = '{"model":"demo","api_key":"sk-secret","nested":[{"token":"value"}]}';
    const upstreamText = '{"authorization":"body-secret","stream":true}';
    const record: TrafficFinishedEvent = {
      event: "request_finished",
      id: "record-1",
      timestamp: "2026-07-18T10:00:02.000+08:00",
      started_timestamp: "2026-07-18T10:00:00.000+08:00",
      duration_ms: 2_000,
      client: { host: "127.0.0.1", port: 54_321 },
      target: {
        id: "target-1",
        name: "Target",
        scheme: "https",
        host: "api.example.com",
        port: 443,
        path: "/v1/responses",
      },
      request: {
        method: "POST",
        path: "/v1/responses",
        body_pending: false,
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
      response: {
        status: 200,
        headers: { "Content-Type": ["application/json"] },
        body: {
          size_bytes: 5,
          base64: Buffer.from("plain").toString("base64"),
          text: "plain",
        },
      },
    };

    const redacted = redactEvent(record);
    if (redacted.event !== "request_finished") {
      throw new Error("A finished event should stay finished.");
    }

    expect(redacted.request.headers["Authorization"]).toEqual([REDACTED]);
    expect(redacted.request.body).toMatchObject({
      base64: "",
      text: `{"model":"demo","api_key":"${REDACTED}","nested":[{"token":"${REDACTED}"}]}`,
    });
    expect(redacted.request.upstream_body).toMatchObject({
      base64: "",
      text: `{"authorization":"${REDACTED}","stream":true}`,
    });
    expect(redacted.response.headers).toEqual({ "Content-Type": ["application/json"] });
    expect(redacted.response.body.text).toBe("plain");

    // The live record keeps its own credentials and bytes.
    expect(record.request.headers["Authorization"]).toEqual(["Bearer secret-token"]);
    expect(record.request.body.text).toBe(requestText);
    expect(record.request.body.base64).not.toBe("");
    expect(record.request.upstream_body?.text).toBe(upstreamText);
    // The redacted form shares nothing with the live record, so a later edit cannot reach it.
    expect(redacted.request).not.toBe(record.request);
    expect(redacted.request.headers).not.toBe(record.request.headers);
    expect(redacted.request.body).not.toBe(record.request.body);
  });

  it("[AI-06] leaves a body that is not JSON as it stands", () => {
    const record: TrafficFinishedEvent = {
      event: "request_finished",
      id: "record-2",
      timestamp: "2026-07-18T10:00:02.000+08:00",
      started_timestamp: "2026-07-18T10:00:00.000+08:00",
      duration_ms: 2_000,
      client: { host: "127.0.0.1", port: 54_321 },
      target: {
        id: "target-1",
        name: "Target",
        scheme: "https",
        host: "api.example.com",
        port: 443,
        path: "/v1/responses",
      },
      request: {
        method: "POST",
        path: "/v1/responses",
        body_pending: false,
        headers: {},
        body: { size_bytes: 5, base64: "", text: "plain text" },
      },
      response: {
        status: 200,
        headers: {},
        body: { size_bytes: 5, base64: "", text: "plain text" },
      },
    };

    const redacted = redactEvent(record);
    if (redacted.event !== "request_finished") {
      throw new Error("A finished event should stay finished.");
    }

    expect(redacted.request.body.text).toBe("plain text");
    expect(redacted.response.body.text).toBe("plain text");
  });
});
