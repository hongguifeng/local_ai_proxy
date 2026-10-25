// LLM Proxy admin UI -- text helpers shared by every panel that builds markup.
// ES module: bundled into /static/app.js by the entry (../entry.js).

/**
 * Every panel builds markup by string concatenation, so untrusted text from the API
 * has to be escaped before it is interpolated.
 * @param {unknown} text
 */
export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/**
 * JSON stored for the pane carries literal escape sequences rather than the characters
 * they stand for, so the pretty-printed view turns them back into text. Anything that
 * is not a string is handed back untouched.
 * @param {unknown} value
 * @returns {*}
 */
export function formatString(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\\n/g, String.fromCharCode(10))
    .replace(/\\r/g, String.fromCharCode(13))
    .replace(/\\t/g, "    ")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
