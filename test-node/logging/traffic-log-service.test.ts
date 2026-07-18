import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TrafficLogService } from "../../src/logging/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TrafficLogService redaction", () => {
  it.each([
    [true, "[redacted]", "[redacted]"],
    [false, "secret-api-key", "Bearer secret-api-key"],
  ])(
    "applies redaction only when enabled (%s)",
    async (redactLogs, expectedApiKey, expectedHeader) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-log-redaction-"));
      temporaryDirectories.push(root);
      const service = new TrafficLogService(root, { redactLogs });
      service.write(trafficRecord("redaction-request"));
      service.close();

      const repository = new TrafficRepository(root);
      expect(repository.getRecord("redaction-request")).toMatchObject({
        request_headers: { Authorization: expectedHeader },
        request_body: { model: "gpt-5", api_key: expectedApiKey },
        response_body: { id: "resp-redaction", token: expectedApiKey },
      });
      repository.close();
    },
  );
});

function trafficRecord(id: string) {
  return {
    id,
    timestamp: "2026-07-18T11:00:00.000+08:00",
    started_timestamp: "2026-07-18T10:59:59.000+08:00",
    event: "request_finished",
    duration_ms: 1_000,
    request: {
      method: "POST",
      path: "/v1/responses",
      headers: { Authorization: "Bearer secret-api-key" },
      body: {
        size_bytes: 0,
        base64: "",
        text: JSON.stringify({ model: "gpt-5", api_key: "secret-api-key" }),
      },
    },
    response: {
      status: 200,
      headers: {},
      body: {
        size_bytes: 0,
        base64: "",
        text: JSON.stringify({ id: "resp-redaction", token: "secret-api-key" }),
      },
    },
  };
}
