import { describe, expect, it } from "vitest";
import {
  STATISTICS_EXPORT_QUERY_SCHEMA,
  STATISTICS_OVERVIEW_RESPONSE_SCHEMA,
  STATISTICS_QUERY_SCHEMA,
  STATISTICS_TREND_RESPONSE_SCHEMA,
  STATISTICS_WINDOW_QUERY_SCHEMA,
  type AdminJsonSchema,
} from "../../src/admin/admin-schemas.js";

/** The declared properties of a schema object, in the order they were declared. */
function propertiesOf(schema: AdminJsonSchema): Record<string, AdminJsonSchema> {
  const properties = schema["properties"];
  expect(properties).toBeTypeOf("object");
  return properties as Record<string, AdminJsonSchema>;
}

/**
 * The listed values a declared property accepts, read out of the schema the server actually
 * registers. Reading the schema instead of grepping source is the point: this fails when the
 * enum the browser can send differs from the enum the validator accepts.
 */
function enumOf(schema: AdminJsonSchema, key: string): readonly unknown[] {
  const values = propertiesOf(schema)[key]?.["enum"];
  expect(values).toBeTypeOf("object");
  return values as readonly unknown[];
}

describe("usage statistics API contract", () => {
  it("declares strict metric and granularity enums [AI-02]", () => {
    expect(enumOf(STATISTICS_QUERY_SCHEMA, "metric")).toEqual(["token", "cost"]);
    expect(enumOf(STATISTICS_QUERY_SCHEMA, "granularity")).toEqual([
      "day",
      "week",
      "month",
      "auto",
    ]);
    expect(enumOf(STATISTICS_QUERY_SCHEMA, "breakdown")).toEqual(["total", "model", "target"]);
    expect(enumOf(STATISTICS_EXPORT_QUERY_SCHEMA, "granularity")).toEqual([
      "day",
      "week",
      "month",
      "auto",
    ]);
  });

  it("[AI-08] refuses a statistics query key it does not declare", () => {
    // The query strings are closed, so an unknown filter is a validation error rather than
    // something the service quietly ignores.
    expect(STATISTICS_QUERY_SCHEMA["additionalProperties"]).toBe(false);
    expect(STATISTICS_WINDOW_QUERY_SCHEMA["additionalProperties"]).toBe(false);
    expect(STATISTICS_EXPORT_QUERY_SCHEMA["additionalProperties"]).toBe(false);
    expect(STATISTICS_QUERY_SCHEMA["required"]).toEqual(["from", "to"]);
  });

  it("[AI-08] answers statistics with the version key the page reads first", () => {
    // The order a schema declares its properties is the order the answer lists them, so
    // this is where the wire order of a statistics payload is pinned.
    expect(Object.keys(propertiesOf(STATISTICS_OVERVIEW_RESPONSE_SCHEMA))).toEqual([
      "dataVersion",
      "totals",
      "byTarget",
      "byModel",
      "unpriced",
    ]);
    expect(Object.keys(propertiesOf(STATISTICS_TREND_RESPONSE_SCHEMA))).toEqual([
      "dataVersion",
      "granularity",
      "points",
    ]);
    for (const schema of [STATISTICS_OVERVIEW_RESPONSE_SCHEMA, STATISTICS_TREND_RESPONSE_SCHEMA]) {
      expect(propertiesOf(schema)["dataVersion"]).toEqual({ type: "number", const: 1 });
    }
  });
});
