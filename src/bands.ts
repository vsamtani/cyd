// Market-cap size bands — EDIT HERE to change thresholds or labels.
// Bands are listed largest-first; `min` is inclusive, `max` is exclusive (USD).
// The displayed dollar range is derived from min/max, so editing the numbers is
// enough — no labels to keep in sync.

export interface SizeBand {
  label: string;
  min: number; // inclusive, USD
  max: number; // exclusive, USD (use Infinity for the top band)
}

export const SIZE_BANDS: SizeBand[] = [
  { label: "Mega-cap", min: 200e9, max: Infinity },
  { label: "Large-cap", min: 10e9, max: 200e9 },
  { label: "Mid-cap", min: 2e9, max: 10e9 },
  { label: "Small-cap", min: 300e6, max: 2e9 },
  { label: "Micro-cap", min: 0, max: 300e6 },
];

/** The band a market cap falls in, or undefined if it matches none. */
export function bandFor(marketCapUsd: number): SizeBand | undefined {
  return SIZE_BANDS.find((b) => marketCapUsd >= b.min && marketCapUsd < b.max);
}
