import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Responses SDK example", () => {
  it("uses the Node OpenAI SDK and the configured local proxy", async () => {
    const example = await readFile(
      new URL("../../examples/responses_client.mjs", import.meta.url),
      "utf8",
    );
    expect(example).toContain('import OpenAI from "openai"');
    expect(example).toContain('baseURL: "http://127.0.0.1:1234/v1"');
    expect(example).not.toContain("--target-url");
    await expect(
      access(new URL("../../examples/responses_client.py", import.meta.url)),
    ).rejects.toThrow();
  });
});
