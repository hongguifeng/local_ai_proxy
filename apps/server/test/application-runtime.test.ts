import { describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot } from "../src/config/schema.js";
import { OrderedApplicationRuntime, type ApplicationRuntimeComponents } from "../src/runtime/application-runtime.js";

const config = createRuntimeConfigSnapshot({ version: 1 });

describe("OrderedApplicationRuntime", () => {
  it("becomes ready only after ordered startup and shuts down storage last", async () => {
    const events: string[] = [];
    const runtime = new OrderedApplicationRuntime(components(events));
    const controller = new AbortController();
    await runtime.start(controller.signal);
    expect(events).toEqual(["config.load", "storage.start", "proxies.start", "admin.start"]);
    const waiting = runtime.wait(controller.signal);
    controller.abort();
    await waiting;
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(events).toEqual([
      "config.load",
      "storage.start",
      "proxies.start",
      "admin.start",
      "admin.stop",
      "proxies.stop",
      "storage.drain",
      "storage.close",
      "config.close",
    ]);
  });

  it("rolls back already-started components when startup fails", async () => {
    const events: string[] = [];
    const values = components(events);
    values.admin.start = () => Promise.reject(new Error("admin bind failed"));
    const runtime = new OrderedApplicationRuntime(values);
    await expect(runtime.start(new AbortController().signal)).rejects.toThrow("admin bind failed");
    expect(events).toEqual([
      "config.load",
      "storage.start",
      "proxies.start",
      "proxies.stop",
      "storage.drain",
      "storage.close",
      "config.close",
    ]);
  });

  it("continues shutdown after individual component failures", async () => {
    const events: string[] = [];
    const values = components(events);
    values.admin.stop = () => {
      events.push("admin.stop");
      return Promise.reject(new Error("failed"));
    };
    const runtime = new OrderedApplicationRuntime(values);
    await runtime.start(new AbortController().signal);
    await runtime.stop();
    expect(events.slice(-5)).toEqual(["admin.stop", "proxies.stop", "storage.drain", "storage.close", "config.close"]);
  });
});

function components(events: string[]): ApplicationRuntimeComponents {
  const event = (name: string) => () => {
    events.push(name);
    return Promise.resolve();
  };
  return {
    config: {
      load: () => {
        events.push("config.load");
        return Promise.resolve(config);
      },
      close: event("config.close"),
    },
    storage: {
      start: () => {
        events.push("storage.start");
        return Promise.resolve();
      },
      drain: event("storage.drain"),
      close: event("storage.close"),
    },
    proxies: {
      start: () => {
        events.push("proxies.start");
        return Promise.resolve();
      },
      stop: event("proxies.stop"),
    },
    admin: {
      start: () => {
        events.push("admin.start");
        return Promise.resolve();
      },
      stop: event("admin.stop"),
    },
  };
}
