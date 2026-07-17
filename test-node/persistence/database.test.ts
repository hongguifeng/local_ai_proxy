import path from "node:path";

import { describe, expect, it } from "vitest";

import { TRAFFIC_DB_NAME, logDatabasePath } from "../../src/persistence/database.js";

describe("logDatabasePath", () => {
  it.each([undefined, null])("disables persistence for %s", (logRoot) => {
    expect(logDatabasePath(logRoot)).toBeUndefined();
  });

  it("places traffic.db directly below the configured log root", () => {
    expect(logDatabasePath(path.join("workspace", "日志"))).toBe(
      path.join("workspace", "日志", "traffic.db"),
    );
    expect(TRAFFIC_DB_NAME).toBe("traffic.db");
  });
});
