import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { startHeadlessElectronMain } from "../../electron/headless-main.js";

/**
 * The startup contract read out of the syntax tree instead of out of the text.
 *
 * The tray entry must not block ESM evaluation while it waits for Electron, so
 * the top of `electron/index.ts` has to keep two properties: nothing is awaited
 * at module level, and the call that starts the application is deferred and
 * carries a rejection handler. A substring search proved neither. It failed on a
 * reformat (measured: splitting `void start()` and `.catch(...)` over two lines
 * made `toContain("void start().catch")` fail while the behaviour was unchanged),
 * and it passed when the text only appeared in a comment or a string.
 */
function topLevelAwaits(sourceFile: ts.SourceFile): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = [];
  const visit = (node: ts.Node): void => {
    // Awaiting inside a function is the whole point of the async startup.
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isAwaitExpression(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    visit(statement);
  }
  return found;
}

/** The module-level `start()` calls, with how each one was deferred and handled. */
function moduleLevelStartCalls(sourceFile: ts.SourceFile): {
  readonly deferred: number;
  readonly rejectionHandled: number;
} {
  let deferred = 0;
  let rejectionHandled = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isVoidExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression)
    ) {
      const callee = node.expression.expression.expression;
      // `void start()` and `void start().catch(handler)` both defer the startup
      // instead of blocking module evaluation; only the second one reports a failure.
      if (leftmostCalleeName(callee) === "start") {
        deferred += 1;
      }
      if (calleeChainContains(callee, "catch")) {
        rejectionHandled += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    visit(statement);
  }
  return { deferred, rejectionHandled };
}

/** The function a call expression ultimately invokes, past any `.member(...)` chain. */
function leftmostCalleeName(callee: ts.Expression): string | undefined {
  let node = callee;
  for (;;) {
    if (ts.isIdentifier(node)) {
      return node.text;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      node = node.expression;
      continue;
    }
    return undefined;
  }
}

/** Whether a callee chain reaches through a member with this name. */
function calleeChainContains(callee: ts.Expression, name: string): boolean {
  let node = callee;
  for (;;) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      return true;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      node = node.expression;
      continue;
    }
    return false;
  }
}

describe("startHeadlessElectronMain", () => {
  it("does not block ESM evaluation while waiting for Electron readiness", async () => {
    const source = await readFile(new URL("../../electron/index.ts", import.meta.url), "utf8");
    const sourceFile = ts.createSourceFile(
      "electron/index.ts",
      source,
      ts.ScriptTarget.ES2024,
      true,
      ts.ScriptKind.TS,
    );
    expect(topLevelAwaits(sourceFile)).toEqual([]);
    expect(moduleLevelStartCalls(sourceFile)).toEqual({ deferred: 1, rejectionHandled: 1 });
  });

  it("waits for readiness without creating a visible window", async () => {
    const on = vi.fn();
    const whenReady = vi.fn(() => Promise.resolve());

    await startHeadlessElectronMain({ on, whenReady });

    expect(whenReady).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("window-all-closed", expect.any(Function));
  });
});
