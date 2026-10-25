import { describe, expect, it } from "vitest";

import { TRAFFIC_EVENT_NAMES } from "../../src/proxy/index.js";
import type { TrafficFinishedEvent, TrafficRecordEvent } from "../../src/proxy/traffic-event.js";

function finishedEvent(id: string): TrafficFinishedEvent {
  return {
    event: "request_finished",
    id,
    timestamp: "2026-07-18T10:00:00.000+08:00",
    started_timestamp: "2026-07-18T10:00:00.000+08:00",
    duration_ms: 0,
    client: { host: "127.0.0.1", port: 1 },
    target: { id: "t", name: "T", scheme: "https", host: "h", port: 443, path: "/v1" },
    request: {
      method: "POST",
      path: "/v1/responses",
      body_pending: false,
      headers: {},
      body: { size_bytes: 0, base64: "", text: "" },
    },
    response: { status: 200, headers: {}, body: { size_bytes: 0, base64: "", text: "" } },
  };
}

/**
 * These checks exist so the compiler, not a reviewer, notices a lifecycle name, a missing
 * field or a wrong unit. An `@ts-expect-error` that stops being an error fails the build,
 * which is how this file keeps its value.
 */
describe("traffic event model", () => {
  it("[AI-06] names exactly the three lifecycle states", () => {
    expect(TRAFFIC_EVENT_NAMES).toEqual([
      "request_received",
      "request_pending_response",
      "request_finished",
    ]);
  });

  it("[AI-06] rejects a misspelled lifecycle state at compile time", () => {
    const misspelled: TrafficRecordEvent = {
      ...finishedEvent("record-1"),
      // @ts-expect-error the lifecycle name is not one of the three states
      event: "request_finised",
    };
    expect(misspelled).toBeDefined();
  });

  it("[AI-06] rejects a finished event without the client that asked", () => {
    // @ts-expect-error a finished event has to say which socket asked
    const missingClient: TrafficRecordEvent = {
      event: "request_finished",
      id: "record-1",
      timestamp: "2026-07-18T10:00:00.000+08:00",
      started_timestamp: "2026-07-18T10:00:00.000+08:00",
      duration_ms: 0,
      target: { id: "t", name: "T", scheme: "https", host: "h", port: 443, path: "/v1" },
      request: {
        method: "POST",
        path: "/v1/responses",
        body_pending: false,
        headers: {},
        body: { size_bytes: 0, base64: "", text: "" },
      },
      response: { status: 200, headers: {}, body: { size_bytes: 0, base64: "", text: "" } },
    };
    expect(missingClient).toBeDefined();
  });

  it("[AI-06] rejects a duration that is not a number of milliseconds", () => {
    const wrongUnit: TrafficRecordEvent = {
      ...finishedEvent("record-1"),
      // @ts-expect-error duration_ms holds milliseconds, not a duration written as text
      duration_ms: "1s",
    };
    expect(wrongUnit).toBeDefined();
  });

  it("[AI-06] keeps an answer without a status readable", () => {
    const event: TrafficRecordEvent = {
      ...finishedEvent("record-1"),
      response: {
        status: null,
        headers: {},
        body: { size_bytes: 0, base64: "", text: "" },
      },
    };
    expect(event.response.status).toBeNull();
  });

  it("[AI-06] separates what the client sent from what the answering node received", () => {
    const event: TrafficRecordEvent = {
      ...finishedEvent("record-2"),
      request: {
        method: "POST",
        path: "/v1/responses",
        body_pending: false,
        headers: {},
        body: { size_bytes: 2, base64: "e30=", text: "{}" },
        upstream_body: { size_bytes: 7, base64: "eyJhIjoxfQ==", text: '{"a":1}' },
      },
    };
    expect(event.request.body.text).toBe("{}");
    expect(event.request.upstream_body?.text).toBe('{"a":1}');
  });

  it("[AI-06] carries the pricing snapshot the request was frozen with", () => {
    const event: TrafficRecordEvent = {
      ...finishedEvent("record-3"),
      pricing: {
        pricing_status: "priced",
        pricing_reason: null,
        billing_model: "gpt-5",
        pricing_snapshot: { input_per_million: "5" },
        usage: { inputUncachedTokens: 10, outputTokens: 5 },
        cost_nano_cny: "123",
      },
    };
    expect(event.pricing?.pricing_status).toBe("priced");
    expect(event.pricing?.cost_nano_cny).toBe("123");
  });
});
