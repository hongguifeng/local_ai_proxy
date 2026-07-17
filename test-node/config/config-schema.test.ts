import { describe, expect, it } from "vitest";

import { modelMappingSchema } from "../../src/config/config-schema.js";

describe("modelMappingSchema", () => {
  it("trims and validates listen/upstream model names", () => {
    expect(modelMappingSchema.parse({ listen: " local ", upstream: " remote " })).toEqual({
      listen: "local",
      upstream: "remote",
    });
  });

  it("rejects empty model names", () => {
    expect(() => modelMappingSchema.parse({ listen: "", upstream: "remote" })).toThrow();
    expect(() => modelMappingSchema.parse({ listen: "local", upstream: " " })).toThrow();
  });
});
