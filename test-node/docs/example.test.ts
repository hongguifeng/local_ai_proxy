import { access, readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseModuleReferences } from "../../scripts/module-edges.js";

/**
 * The example read as a program instead of as a string.
 *
 * `toContain('import OpenAI from "openai"')` passed on a commented-out import line and
 * failed when that import was merely reformatted. These checks read the syntax tree, so
 * they ask what the example actually does: which module it loads at runtime, and which URL
 * and key it hands the client. The instruction the author wrote in prose is still checked
 * as text, because a comment is exactly where such an instruction lives.
 */
async function readExample(): Promise<{ readonly text: string; readonly source: ts.SourceFile }> {
  const text = await readFile(
    new URL("../../examples/responses_client.mjs", import.meta.url),
    "utf8",
  );
  return {
    text,
    source: ts.createSourceFile(
      "examples/responses_client.mjs",
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    ),
  };
}

/** Object literal properties of the `new OpenAI(...)` call, as name and initializer text. */
function clientConfiguration(
  sourceFile: ts.SourceFile,
): { readonly name: string; readonly value: string }[] {
  const entries: { name: string; value: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "OpenAI"
    ) {
      const constructorArguments = node.arguments ?? [];
      for (const argument of constructorArguments) {
        if (!ts.isObjectLiteralExpression(argument)) {
          continue;
        }
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property)) {
            entries.push({ name: property.name.getText(), value: property.initializer.getText() });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return entries;
}

/** The text of every callee the module calls. */
function calledCallees(sourceFile: ts.SourceFile): string[] {
  const callees: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      callees.push(node.expression.getText());
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return callees;
}

describe("Responses SDK example", () => {
  it("uses the Node OpenAI SDK and the configured local proxy", async () => {
    const { text, source } = await readExample();
    // A runtime import, not a mention: a commented-out line no longer counts here.
    expect(
      parseModuleReferences(source.getFullText(), "examples/responses_client.mjs").filter(
        (reference) => !reference.typeOnly,
      ),
    ).toEqual([{ specifier: "openai", kind: "import", typeOnly: false }]);

    expect(clientConfiguration(source)).toEqual([
      { name: "baseURL", value: '"http://127.0.0.1:1234/v1"' },
      { name: "apiKey", value: '"sk-no-key-required"' },
    ]);

    // The example reaches the Responses API through the proxy.
    expect(calledCallees(source)).toContain("client.responses.create");

    // The target is configured in the web console, so the example must not tell anyone
    // to set it with a command-line flag - including in its prose comments.
    expect(text).not.toContain("--target-url");

    await expect(
      access(new URL("../../examples/responses_client.py", import.meta.url)),
    ).rejects.toThrow();
  });
});
