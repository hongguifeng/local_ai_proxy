import { describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import {
  AtomicRuntimeConfig,
  type PreparedRuntimeChange,
  type RuntimeConfigChange,
} from "../src/runtime/atomic-config.js";

describe("AtomicRuntimeConfig", () => {
  it("diffs changes, reuses unchanged proxies, and commits after persistence", async () => {
    const events: string[] = [];
    const prepared: RuntimeConfigChange[] = [];
    const coordinator = new AtomicRuntimeConfig(
      config([proxy("one", 1001), proxy("old", 1002)]),
      {
        save: () => {
          events.push("save");
          return Promise.resolve();
        },
      },
      {
        prepare: (change) => {
          events.push("prepare");
          prepared.push(change);
          return Promise.resolve(transaction(events));
        },
      },
    );
    const next = persisted([proxy("one", 1001), proxy("two", 2002)]);
    await expect(coordinator.replace(next)).resolves.toEqual({
      changed: true,
      proxies: [
        { id: "old", action: "removed" },
        { id: "one", action: "unchanged" },
        { id: "two", action: "added" },
      ],
    });
    expect(events).toEqual(["prepare", "save", "commit"]);
    expect(prepared[0]).toMatchObject({
      added: [{ id: "two" }],
      changed: [],
      removed: [{ id: "old" }],
      unchanged: [{ id: "one" }],
    });
    expect(coordinator.snapshot.proxies.map((value) => value.id)).toEqual(["one", "two"]);
  });

  it("rolls back prepared runtimes and retains memory when persistence fails", async () => {
    const events: string[] = [];
    const initial = config([proxy("one", 1001)]);
    const coordinator = new AtomicRuntimeConfig(
      initial,
      {
        save: () => Promise.reject(new Error("disk full")),
      },
      {
        prepare: () => Promise.resolve(transaction(events)),
      },
    );
    await expect(coordinator.replace(persisted([proxy("one", 2001)]))).rejects.toThrow("disk full");
    expect(events).toEqual(["rollback"]);
    expect(coordinator.snapshot).toBe(initial);
  });

  it("does not persist or replace memory when prepare fails", async () => {
    let saves = 0;
    const initial = config([proxy("one", 1001)]);
    const coordinator = new AtomicRuntimeConfig(
      initial,
      {
        save: () => {
          saves += 1;
          return Promise.resolve();
        },
      },
      {
        prepare: () => Promise.reject(new Error("listen conflict")),
      },
    );
    await expect(coordinator.replace(persisted([proxy("two", 1002)]))).rejects.toThrow("listen conflict");
    expect(saves).toBe(0);
    expect(coordinator.snapshot).toBe(initial);
  });

  it("skips no-op prepares and serializes concurrent replacements", async () => {
    const events: string[] = [];
    const coordinator = new AtomicRuntimeConfig(
      config([proxy("one", 1001)]),
      {
        save: async (value) => {
          events.push(`save:${value.proxies[0]?.name ?? "none"}`);
          await Promise.resolve();
        },
      },
      {
        prepare: async (change) => {
          events.push(`prepare:${change.next.proxies[0]?.name ?? "none"}`);
          await Promise.resolve();
          return transaction(events);
        },
      },
    );
    await expect(coordinator.replace(persisted([proxy("one", 1001)]))).resolves.toMatchObject({ changed: false });
    await Promise.all([
      coordinator.replace(persisted([proxy("one", 1001, "first")])),
      coordinator.replace(persisted([proxy("one", 1001, "second")])),
    ]);
    expect(events).toEqual(["prepare:first", "save:first", "commit", "prepare:second", "save:second", "commit"]);
    expect(coordinator.snapshot.proxies[0]?.name).toBe("second");
  });
});

function transaction(events: string[]): PreparedRuntimeChange {
  return {
    commit: () => {
      events.push("commit");
    },
    rollback: () => {
      events.push("rollback");
      return Promise.resolve();
    },
  };
}

function config(proxies: ReturnType<typeof proxy>[]) {
  return createRuntimeConfigSnapshot(persisted(proxies));
}

function persisted(proxies: ReturnType<typeof proxy>[]) {
  return { version: 1 as const, proxies };
}

function proxy(id: string, listenPort: number, name = id) {
  return {
    id,
    name,
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort,
    defaultTargetId: `target-${id}`,
    targets: [{ id: `target-${id}`, name: "Target", url: "http://127.0.0.1:1" }],
  };
}
