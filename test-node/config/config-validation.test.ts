import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  validateProxyConfigFile,
} from "../../src/config/config-validation.js";
import { createDefaultProxyPair } from "../../src/config/defaults.js";

describe("validateProxyConfigFile", () => {
  it("returns validated configuration", () => {
    const config = { pairs: [createDefaultProxyPair()] };

    expect(validateProxyConfigFile(config)).toEqual(config);
  });

  it("returns field paths and messages for invalid configuration", () => {
    const pair = createDefaultProxyPair();
    const invalid = {
      pairs: [
        {
          ...pair,
          listen_port: 70_000,
          targets: [
            { ...pair.targets[0], inject_request_fields: "[]", target_headers: ["invalid"] },
          ],
        },
      ],
    };

    try {
      validateProxyConfigFile(invalid);
      expect.unreachable("validation should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validationError = error as ConfigValidationError;
      expect(validationError.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "pairs.0.listen_port" }),
          expect.objectContaining({ path: "pairs.0.targets.0.inject_request_fields" }),
          expect.objectContaining({ path: "pairs.0.targets.0.target_headers.0" }),
        ]),
      );
    }
  });
});
