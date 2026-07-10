import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ConfigValidationError, createRuntimeConfigSnapshot, parsePersistedConfig } from "../src/config/schema.js";

const validProxy = {
  id: "proxy-1",
  name: "Proxy",
  enabled: true,
  listenHost: "127.0.0.1",
  listenPort: 1234,
  targets: [
    {
      id: "target-1",
      name: "Target",
      url: "HTTPS://Example.COM:443/api/v1///",
      modelMappings: [{ listen: "demo", upstream: "upstream-demo" }],
    },
  ],
  defaultTargetId: "target-1",
};

describe("persisted configuration", () => {
  it("parses the checked-in default fixture", async () => {
    const fixture: unknown = JSON.parse(
      await readFile(new URL("./fixtures/default-config-v1.json", import.meta.url), "utf8"),
    );
    expect(parsePersistedConfig(fixture)).toEqual(fixture);
  });

  it("rejects unknown keys and returns field paths without input values", () => {
    const secret = "do-not-leak-this-value";
    try {
      parsePersistedConfig({ version: 1, proxies: [], unknown: secret });
      throw new Error("Expected configuration validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validationError = error as ConfigValidationError;
      expect(validationError.issues.some((issue) => issue.path.length === 0 && issue.message.includes("unknown"))).toBe(
        true,
      );
      expect(JSON.stringify(validationError.issues)).not.toContain(secret);
    }
  });

  it("reports URL, port, timeout, default target, and duplicate constraints", () => {
    const invalid = {
      version: 1,
      proxies: [
        {
          ...validProxy,
          id: "invalid-proxy",
          listenPort: 70_000,
          defaultTargetId: "missing",
          targets: [
            {
              ...validProxy.targets[0],
              url: "ftp://user:password@example.com/path?secret=value",
              timeouts: { connectMs: 1, responseHeadersMs: 60_000, idleMs: 600_000 },
            },
          ],
        },
        validProxy,
        { ...validProxy, id: "proxy-2", name: "Duplicate listener" },
      ],
    };
    expect(() => parsePersistedConfig(invalid)).toThrow(ConfigValidationError);
    try {
      parsePersistedConfig(invalid);
    } catch (error) {
      const paths = (error as ConfigValidationError).issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "proxies.0.listenPort",
          "proxies.0.defaultTargetId",
          "proxies.0.targets.0.url",
          "proxies.0.targets.0.timeouts.connectMs",
          "proxies.2.listenPort",
        ]),
      );
    }
  });
});

describe("runtime configuration snapshot", () => {
  it("normalizes target endpoints and freezes every nested object", () => {
    const snapshot = createRuntimeConfigSnapshot({ version: 1, proxies: [validProxy] });
    const target = snapshot.proxies[0]?.targets[0];
    expect(target?.endpoint).toEqual({
      protocol: "https:",
      hostname: "example.com",
      port: 443,
      origin: "https://example.com",
      basePath: "/api/v1",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.proxies)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target?.modelMappings)).toBe(true);
  });

  it("does not freeze or mutate the caller's input", () => {
    const input = { version: 1, proxies: [validProxy] };
    createRuntimeConfigSnapshot(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(input.proxies[0]?.targets[0]?.url).toContain("Example.COM");
  });
});
