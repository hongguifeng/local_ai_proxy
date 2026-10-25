import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findUnpackedPayload } from "../../scripts/payload_smoke.js";
import {
  createSmokeWorkspace,
  explainHealthFailure,
  requestedPorts,
  smokeChildEnvironment,
} from "../../scripts/smoke_harness.js";
import { describeNativeModuleFailure, probeSqliteAbi } from "../../scripts/native_abi_probe.js";

/**
 * [AI-16] gates for the delivery smokes. The env sanitizer is checked twice on purpose: once
 * as behaviour and once as a source guard over the call sites, because a script that deletes
 * ELECTRON_RUN_AS_NODE in a helper while handing `process.env` to the spawn would still pass a
 * behaviour-only test.
 */

const SCRIPT_DIRECTORY = new URL("../../scripts/", import.meta.url);
const SPAWN_SCRIPTS = ["smoke_harness.ts", "native_abi_probe.ts"];
const DELEGATING_SCRIPTS = ["artifact_smoke.ts", "payload_smoke.ts"];

describe("[AI-16] packaged smoke launch conditions", () => {
  it("[AI-16] drops ELECTRON_RUN_AS_NODE from an inherited environment", () => {
    const inherited = { ...process.env, ELECTRON_RUN_AS_NODE: "1", LLM_PROXY_DATA_DIR: "fresh" };
    const child = smokeChildEnvironment(inherited);
    expect(child).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(child["LLM_PROXY_DATA_DIR"]).toBe("fresh");
    expect(inherited.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("[AI-16] hands every packaged spawn to the sanitizer, not to the inherited environment", async () => {
    const violations: string[] = [];
    for (const name of SPAWN_SCRIPTS) {
      const text = await readFile(new URL(name, SCRIPT_DIRECTORY), "utf8");
      const source = ts.createSourceFile(name, text, ts.ScriptTarget.ES2024, true);
      for (const call of collectSpawnCalls(source)) {
        const options = call.arguments.find(ts.isObjectLiteralExpression);
        const environment = options?.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText() === "env",
        );
        const initializer =
          environment !== undefined && ts.isPropertyAssignment(environment)
            ? environment.initializer
            : undefined;
        const sanitized = initializer?.getText().includes("smokeChildEnvironment");
        if (!sanitized) {
          violations.push(`${name}: spawn at position ${call.getStart()} has no sanitized env`);
        }
      }
      const sourceText = source.text;
      if (sourceText.includes("env: process.env") || sourceText.includes("...process.env")) {
        violations.push(`${name}: hands the inherited environment to a child process`);
      }
    }
    expect(violations).toEqual([]);
    const harness = await readFile(new URL("smoke_harness.ts", SCRIPT_DIRECTORY), "utf8");
    for (const variable of [
      "LLM_PROXY_DATA_DIR",
      "LLM_PROXY_SMOKE_EXIT_FILE",
      "LLM_PROXY_STARTUP_ERROR_FILE",
    ]) {
      expect(harness).toContain(variable);
    }
  });

  it("[AI-16] keeps the wrapper and payload smokes as separate entry points that delegate", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    expect(scripts["smoke:payload"]).toContain("dist-node/scripts/payload_smoke.js");
    expect(scripts["smoke:artifact"]).toContain("dist-node/scripts/artifact_smoke.js");
    expect(scripts["smoke:delivery"]).toBe("npm run smoke:payload && npm run smoke:artifact");
    for (const name of DELEGATING_SCRIPTS) {
      const text = await readFile(new URL(name, SCRIPT_DIRECTORY), "utf8");
      expect(text).not.toContain("spawn(");
      expect(text).toContain("runPackagedSmoke");
    }
  });

  it("[AI-16] reads the pinned smoke ports and rejects a port that is not a port", () => {
    expect(requestedPorts({})).toBeUndefined();
    expect(
      requestedPorts({
        LLM_PROXY_SMOKE_ADMIN_PORT: "39491",
        LLM_PROXY_SMOKE_PROXY_PORT: "39492",
        LLM_PROXY_SMOKE_UPSTREAM_PORT: "39493",
      }),
    ).toEqual({ admin: 39491, proxy: 39492, upstream: 39493 });
    expect(() =>
      requestedPorts({
        LLM_PROXY_SMOKE_ADMIN_PORT: "18085",
        LLM_PROXY_SMOKE_PROXY_PORT: "nope",
        LLM_PROXY_SMOKE_UPSTREAM_PORT: "39493",
      }),
    ).toThrow(
      'LLM_PROXY_SMOKE_PROXY_PORT must be a TCP port between 1 and 65535, received "nope".',
    );
  });
});

describe("[AI-16] unpacked payload smoke", () => {
  it("[AI-16] selects win-unpacked/LLM Proxy.exe and refuses a missing payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-payload-smoke-"));
    try {
      await expect(findUnpackedPayload(root)).rejects.toThrow(
        /Unpacked payload executable not found .*npm run package:electron:dir/,
      );
      await mkdir(path.join(root, "win-unpacked"), { recursive: true });
      const executable = path.join(root, "win-unpacked", "LLM Proxy.exe");
      await writeFile(executable, "fixture");
      await expect(findUnpackedPayload(root)).resolves.toBe(executable);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("[AI-16] SQLite native ABI proof", () => {
  it("[AI-16] proves the installed ABI with a real query, not with require", () => {
    const result = probeSqliteAbi();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("NODE_MODULE_VERSION");
    expect(result.detail).toContain('{"a":1}');
  });

  it("[AI-16] names both ABI numbers and the rebuild command that fixes them", () => {
    const mismatch = new Error(
      "The module '…\\better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 143. This version of Node.js requires NODE_MODULE_VERSION 137.",
    );
    expect(describeNativeModuleFailure(mismatch, "node")).toBe(
      "better_sqlite3.node carries the ABI built for NODE_MODULE_VERSION 143 while node needs 137, so it cannot be loaded here: run npm run rebuild:node before Node tests, the Node smoke, or this probe.",
    );
    expect(describeNativeModuleFailure(mismatch, "electron")).toBe(
      "better_sqlite3.node carries the ABI built for NODE_MODULE_VERSION 143 while electron needs 137, so it cannot be loaded here: run npm run rebuild:electron before packaging or running a packaged executable.",
    );
  });
});

describe("[AI-16] health failure classification", () => {
  it("[AI-16] calls a contended unpack directory a launch collision, not a payload regression", async () => {
    const workspace = await createSmokeWorkspace("payload", {
      admin: 39491,
      proxy: 39492,
      upstream: 39493,
    });
    try {
      const collision = await explainHealthFailure(null, [43531], workspace, () =>
        Promise.resolve({ available: true, pids: [4242] }),
      );
      expect(collision).toContain("pid 4242");
      expect(collision).toContain("portable unpack-path collision, not a payload regression");
      expect(collision).toContain("npm run smoke:payload");
      const cleanExit = await explainHealthFailure(0, [43531], workspace);
      expect(cleanExit).toContain("launch problem, not a packaging failure");
      expect(cleanExit).toContain(workspace.dataDirectory);
      await writeFile(
        workspace.startupErrorFile,
        "Failed to start 1 enabled proxy pair(s).\n",
        "utf8",
      );
      expect(await explainHealthFailure(null, [43531], workspace)).toContain(
        "The application reported this startup failure: Failed to start 1 enabled proxy pair(s).",
      );
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  });
});

describe("[AI-16] delivery entry points", () => {
  it("[AI-16] proves the Node SQLite ABI in CI before the install is pruned", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("npm run abi:node");
    expect(workflow.indexOf("npm run abi:node")).toBeLessThan(
      workflow.indexOf("npm prune --omit=dev"),
    );
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    expect(scripts["abi:node"]).toBe(
      "node --enable-source-maps dist-node/scripts/native_abi_probe.js",
    );
    expect(scripts["abi:electron"]).toBe(
      "node --enable-source-maps dist-node/scripts/native_abi_probe.js --electron",
    );
    expect(scripts["abi:check"]).toBe("npm run abi:node && npm run abi:electron");
  });
});

function collectSpawnCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "spawn"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
