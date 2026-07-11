import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Vite production build", () => {
  it("emits an HTML entry and hashed assets without production source maps", async () => {
    const dist = new URL("../dist/", import.meta.url);
    const html = await readFile(new URL("index.html", dist), "utf8");
    const assets = await readdir(new URL("assets/", dist));
    expect(html).toContain("LLM Proxy");
    expect(assets.some((name) => /index-[A-Za-z0-9_-]+\.js$/u.test(name))).toBe(true);
    expect(assets.some((name) => /index-[A-Za-z0-9_-]+\.css$/u.test(name))).toBe(true);
    expect(assets.every((name) => !name.endsWith(".map"))).toBe(true);
  });
});
