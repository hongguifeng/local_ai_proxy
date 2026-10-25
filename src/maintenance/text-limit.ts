/**
 * The one way a value's text form is cut to a limit. Input preparation shortens what
 * the model is sent, and the brief shortens what it answered with; both use this rule
 * so a shortened value is always marked with an ellipsis and never looks complete.
 */
export function truncateText(value: unknown, limit: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit)}…`;
  const serialized = JSON.stringify(value);
  const text = typeof serialized === "string" ? serialized : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
