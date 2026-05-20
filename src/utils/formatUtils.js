/**
 * Number and display formatting utilities.
 */

/**
 * Format sets as plain integer (no decimal places).
 */
export function formatSets(n) {
  if (n === null || n === undefined) return '0';
  return Math.round(n).toString();
}

/**
 * Format percentage with 1 decimal place.
 */
export function formatPercentage(numerator, denominator) {
  if (!denominator || denominator === 0) return '0.0%';
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}%`;
}

/**
 * Format quantity with "Sets" label.
 */
export function formatQuantity(sets) {
  if (sets === null || sets === undefined) return '0 Sets';
  const n = Math.round(sets);
  return `${n} Set${n !== 1 ? 's' : ''}`;
}

/**
 * Truncate text to a max length with ellipsis.
 */
export function truncateText(text, maxLength = 50) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}
