import { FSN_BASE, START_PERIOD } from "./config.js";
import { head } from "./lib/http.js";

export interface Period {
  id: string; // "2025q1" or "2025_06"
  kind: "quarter" | "month";
  filename: string; // e.g. "2025q1_notes.zip"
  url: string;
}

function makePeriod(id: string, kind: Period["kind"]): Period {
  const filename = `${id}_notes.zip`;
  return { id, kind, filename, url: `${FSN_BASE}/${filename}` };
}

const quarterPeriod = (year: number, q: number) =>
  makePeriod(`${year}q${q}`, "quarter");
const monthPeriod = (year: number, month: number) =>
  makePeriod(`${year}_${String(month).padStart(2, "0")}`, "month");

/**
 * Discover which FSN dataset zips actually exist, from START_PERIOD to now.
 * Prefers a quarterly archive when present; otherwise falls back to the
 * individual monthly files for that quarter. This auto-adapts as SEC folds
 * recent months into quarterly archives over time.
 */
export async function discoverPeriods(): Promise<Period[]> {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const curQuarter = Math.ceil(curMonth / 3);

  const periods: Period[] = [];
  let year: number = START_PERIOD.year;
  let q: number = START_PERIOD.quarter;

  while (year < curYear || (year === curYear && q <= curQuarter)) {
    const quarter = quarterPeriod(year, q);
    const { ok } = await head(quarter.url);
    if (ok) {
      periods.push(quarter);
    } else {
      const lastMonth = year === curYear ? curMonth : q * 3;
      for (let m = (q - 1) * 3 + 1; m <= Math.min(q * 3, lastMonth); m++) {
        const month = monthPeriod(year, m);
        if ((await head(month.url)).ok) periods.push(month);
      }
    }
    if (q === 4) {
      q = 1;
      year++;
    } else {
      q++;
    }
  }
  return periods;
}
