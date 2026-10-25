import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function uiConfig(): ts.ParsedCommandLine {
  const filename = path.resolve("tsconfig.ui.json");
  const config = ts.readConfigFile(filename, (file) => ts.sys.readFile(file));
  if (config.error !== undefined)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(filename));
}

describe("UI strict type contracts", () => {
  it("checks every browser module with null checking enabled", () => {
    const config = uiConfig();
    expect(config.errors).toEqual([]);
    expect(config.options.strictNullChecks).toBe(true);
    expect(config.options.exactOptionalPropertyTypes).toBe(true);
    const actual = config.fileNames.filter((file) => file.endsWith(".js")).sort();
    const expected = ts.sys.readDirectory(path.resolve("src/admin/static"), [".js"]).sort();
    expect(actual).toEqual(expected);
  });

  it("rejects nullable lookups, wrong controls, API field mistakes and invalid async state", () => {
    const config = uiConfig();
    const filename = path.resolve(".ui-contract-probe.ts");
    const source = `
import { qs, requiredTyped } from "./src/admin/static/modules/dom.js";
import type { ApiClient, SharedUiState } from "./src/admin/ui-contracts.js";
declare const api: ApiClient;
declare const state: SharedUiState;
qs("#optional").focus();
requiredTyped("#input", HTMLInputElement).showModal();
api("/api/pairs").then(data => data.notAResponseField);
api("/api/not-a-route");
state.selected = 12;
state.taskPricing = {id: "task", loading: false, error: false, data: {wrong: true}};
`;
    const host = ts.createCompilerHost(config.options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      path.resolve(name) === filename
        ? ts.createSourceFile(name, source, languageVersion)
        : original(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], config.options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (error) => error.file !== undefined && path.resolve(error.file.fileName) === filename,
      );
    expect(diagnostics.map((error) => error.code).sort()).toEqual(
      [2531, 2339, 2339, 2345, 2322, 2353].sort(),
    );
  });
});
