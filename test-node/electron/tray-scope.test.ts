import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The login-startup wiring read out of the syntax tree instead of out of the text.
 *
 * `toContain("createAutoStartController")` passed when the name only appeared in a
 * comment or a string, and said nothing about whether the controller was created,
 * handed to the tray menu, or reached the operating system at all. These checks
 * look at import declarations and call expressions, so a wiring that was deleted
 * or left unused fails, while a reformat of the same code does not.
 */
async function parse(fileName: string): Promise<ts.SourceFile> {
  const text = await readFile(new URL(fileName, import.meta.url), "utf8");
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
}

/** Local specifiers this module imports, in source order, runtime and type-only alike. */
function importedSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    specifiers.push(statement.moduleSpecifier.text);
  }
  return specifiers;
}

/** Names called somewhere in this module, as plain calls or as property accesses. */
function calledNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        names.push(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        names.push(callee.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return names;
}

/** Arguments the named call was given, in order. */
function callArguments(sourceFile: ts.SourceFile, name: string): string[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const collected: string[] = [];
  for (const call of matches) {
    for (const argument of call.arguments) {
      collected.push(argument.getText());
    }
  }
  return collected;
}

describe("Windows tray auto start", () => {
  it("registers the packaged application for login startup from the tray menu", async () => {
    const trayEntry = await parse("../../electron/index.ts");
    expect(importedSpecifiers(trayEntry)).toContain("./auto-start.js");
    expect(calledNames(trayEntry)).toContain("createAutoStartController");
    // The controller is not only created: it is handed to the tray menu, which is
    // the only place a user can turn login startup on or off.
    expect(callArguments(trayEntry, "installOpenAdminActions")).toContain("autoStart");

    const autoStart = await parse("../../electron/auto-start.ts");
    expect(calledNames(autoStart)).toContain("setLoginItemSettings");
  });
});
