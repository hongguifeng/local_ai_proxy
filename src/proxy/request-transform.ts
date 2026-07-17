export function parseStripRequestFields(rawFields: string | null | undefined): Set<string> {
  if (rawFields === null || rawFields === undefined) {
    return new Set();
  }
  return new Set(
    rawFields
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field !== ""),
  );
}
