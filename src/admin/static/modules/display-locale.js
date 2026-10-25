// LLM Proxy admin UI -- the display locale the number helpers format with.
// ES module: bundled into /static/app.js by the entry (../entry.js).

/**
 * The UI language the display helpers were last told about. Everything that is not
 * Chinese is treated as English, which mirrors the fallback `state.language` uses
 * when the saved language is not in the dictionary.
 *
 * `applyLanguage()` in `./core.js` is the only writer: it runs once during startup
 * from `./wiring.js` and again on every language change, so every format call that
 * renders a number happens after a push. Until that first push the helpers fall back
 * to English, the same value `state.language` falls back to.
 * @type {"zh" | "en"}
 */
let displayLanguage = "en";

/**
 * @param {string} language The language the shared bootstrap keeps in `state.language`.
 * @returns {void}
 */
export function configureDisplayLanguage(language) {
  displayLanguage = language === "zh" ? "zh" : "en";
}

/** BCP-47 tag `toLocaleString` groups with: the UI language is the only choice here. */
export function displayLocaleTag() {
  return displayLanguage === "en" ? "en-US" : "zh-CN";
}

/** True when the compact units are the English ones (B/M) instead of 万/亿. */
export function displayLanguageIsEnglish() {
  return displayLanguage === "en";
}
