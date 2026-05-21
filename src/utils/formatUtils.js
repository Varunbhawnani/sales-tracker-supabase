// Number formatting helpers. The cartoons/lots unit model means we don't
// need a "sets" formatter anymore; the only thing left here is a percentage
// formatter shared by stats and exports.

export function formatPercentage(numerator, denominator) {
  if (!denominator || denominator <= 0) return '0.0%';
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}%`;
}
