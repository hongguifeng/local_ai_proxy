import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("built admin static assets", () => {
  it("has a build step that copies every browser entry asset", async () => {
    const script = await import("../../scripts/copy_static_assets.js");
    expect(script).toBeDefined();
    await Promise.all(
      ["index.html", "app.css", "app.js"].map((name) =>
        access(new URL(`../../dist-node/src/admin/static/${name}`, import.meta.url)),
      ),
    );
  });
});
