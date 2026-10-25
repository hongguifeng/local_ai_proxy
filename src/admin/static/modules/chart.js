// LLM Proxy admin UI -- chart geometry: the axis scale and the two overlay labels.
// ES module: bundled into /static/app.js by the entry (../entry.js).

import { compactNumber } from "./numbers.js";

// Choose the y-axis step and maximum for the task-detail line charts: the
// highest data point should sit close to the top gridline.  Among the 1/2/5
// "nice" steps that leave 3 to 8 gridline intervals, pick the one with the
// smallest resulting axis maximum (ties prefer the larger step).  A plain
// "max / 4" round-up can jump to the next 1/2/5 tier (e.g. 8,400 -> 5,000)
// and then force the axis to 4 steps (20,000), leaving the top of the chart
// mostly empty.
/**
 * @param {unknown} maxValue
 * @returns {{ step: number, axisMax: number }}
 */
export function niceAxisScale(maxValue) {
  const max = Number(maxValue);
  if (!Number.isFinite(max) || max <= 0) return { step: 1, axisMax: 4 };
  let best = null;
  const top = Math.floor(Math.log10(max));
  for (let exponent = top - 2; exponent <= top + 1; exponent++) {
    for (const factor of [1, 2, 5]) {
      const step = factor * 10 ** exponent;
      const intervals = Math.ceil(max / step - 1e-9);
      if (intervals < 3 || intervals > 8) continue;
      const axisMax = step * intervals;
      if (!best || axisMax < best.axisMax || (axisMax === best.axisMax && step > best.step))
        best = { step, axisMax };
    }
  }
  return best ?? { step: 1, axisMax: Math.ceil(max) };
}

// Dashed horizontal line marking a trend chart's average value (used by the
// cost and token-output charts), drawn across the full plot width and labeled
// at the right edge so the typical per-request size reads at a glance without
// hovering. Returns an empty string for a zero mean, which would sit on the
// x axis and would be indistinguishable from it. The chart renders it after
// the dots so a dense cluster of points cannot cover the value label.
/**
 * @param {(value: number) => number} yFor Maps a data value to a y coordinate.
 * @param {number} mean
 * @param {string} label Already escaped markup for the value text.
 * @param {number} padTop
 * @param {number} padLeft
 * @param {number} padRight
 * @param {number} plotHeight
 * @param {number} width
 * @returns {string}
 */
export function chartMeanLine(yFor, mean, label, padTop, padLeft, padRight, plotHeight, width) {
  if (mean <= 0) return "";
  const y = yFor(mean);
  const above = y > padTop + plotHeight - 18;
  return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="token-chart-mean"/><text x="${width - padRight - 4}" y="${above ? y - 6 : y + 13}" text-anchor="end" class="token-chart-mean-label">${label}</text>`;
}

// SVG label pinning the exact value of a trend chart's highest point just
// above its dot (flipped to the left of the dot when the peak sits close to
// the right edge, so the text never overflows the viewBox). Shared element
// class .token-chart-peak across the three charts; color follows each
// chart's dot color.
/**
 * @param {number} x
 * @param {number} y
 * @param {string} valueText Already escaped markup for the value text.
 * @param {number} width
 * @param {number} padRight
 * @returns {string}
 */
export function chartPeakLabel(x, y, valueText, width, padRight) {
  const halfWidth = valueText.length * 3.4 + 4;
  const toLeft = x + halfWidth > width - padRight;
  const tx = toLeft ? x - 7 : x;
  return `<text x="${tx}" y="${Math.max(y - 8, 11)}" text-anchor="${toLeft ? "end" : "middle"}" class="token-chart-peak">${valueText}</text>`;
}

// Axis tick labels for yuan values: compact for large amounts, fixed four
// decimal places (trimmed) for everyday per-request costs, scientific for
// sub-0.0001-yuan amounts where fixed decimals would round to zero.
/**
 * @param {unknown} value
 * @returns {string}
 */
export function costAxisLabel(value) {
  const n = Number(value);
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return compactNumber(n);
  if (Math.abs(n) < 1e-4) return n.toPrecision(1);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
