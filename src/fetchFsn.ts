import { existsSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR } from "./config.js";
import { download } from "./lib/http.js";
import { discoverPeriods, type Period } from "./periods.js";

export interface FetchedPeriod {
  period: Period;
  path: string;
}

/**
 * Download all available FSN dataset zips into data/raw/.
 * Existing files are skipped, except the most recent period (which can still
 * be updated by SEC after first publication). Raw zips are retained.
 */
export async function fetchAll(): Promise<FetchedPeriod[]> {
  const periods = await discoverPeriods();
  console.log(`Discovered ${periods.length} available period(s).`);

  const fetched: FetchedPeriod[] = [];
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i]!;
    const path = join(RAW_DIR, period.filename);
    const isLatest = i === periods.length - 1;

    if (existsSync(path) && !isLatest) {
      console.log(`  skip  ${period.id} (already downloaded)`);
    } else {
      const reason = isLatest ? "latest, refreshing" : "new";
      console.log(`  get   ${period.id} (${reason}) ...`);
      const bytes = await download(period.url, path);
      console.log(`        done (${(bytes / 1e6).toFixed(1)} MB)`);
    }
    fetched.push({ period, path });
  }
  return fetched;
}
