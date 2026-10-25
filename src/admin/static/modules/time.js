// LLM Proxy admin UI -- splitting a stored timestamp and rendering a duration.
// ES module: bundled into /static/app.js by the entry (../entry.js).

/**
 * The log list shows the date and the time of a task on separate lines, so the stored
 * `YYYY-MM-DD HH:MM:SS` is split once here rather than in every row template.
 * @param {unknown} value
 * @returns {{ date: string, shortDate: string, time: string }}
 */
export function displayTimestampParts(value) {
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/.exec(text);
  if (!match) return { date: "", shortDate: "", time: text };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    shortDate: `${match[2]}-${match[3]}`,
    time: match[4],
  };
}

/**
 * @param {unknown} milliseconds
 * @returns {string}
 */
export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || milliseconds === "") return "";
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return "";
  // Do not round sub-second timings to seconds: a real 95 ms TTFT used to
  // be rendered as 00:00, which looked like a missing/zero measurement.
  if (value < 1_000) return `${Math.round(value)} ms`;
  const totalSeconds = Math.round(value / 1_000);
  if (totalSeconds >= 3_600) {
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}
