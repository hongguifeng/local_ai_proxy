import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("UI screenshots", () => {
  it("keeps all four reviewed visual baselines", async () => {
    await Promise.all(
      ["ui_proxy_cn.png", "ui_proxy_en.png", "ui_logs_cn.png", "ui_logs_en.png"].map((name) =>
        access(new URL(`../../doc/${name}`, import.meta.url)),
      ),
    );
    const assessment = await readFile(
      new URL("../../docs/ui-screenshot-assessment.md", import.meta.url),
      "utf8",
    );
    expect(assessment).toContain("No screenshot replacement is required");
  });
});
