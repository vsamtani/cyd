import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";
import { EXPORT_DIR } from "./export.js";

const SITE_DIR = join(ROOT, "site");
const DIST_DIR = join(ROOT, "dist");

/**
 * Assemble the deployable static site into dist/:
 *   dist/{index.html, app.js, styles.css, data/summary.json}
 * The dashboard fetches ./data/summary.json relative to index.html, so this
 * layout works both locally (serve dist/) and on GitHub Pages.
 */
export function buildSite(): string {
  const summary = join(EXPORT_DIR, "summary.json");
  if (!existsSync(summary)) {
    throw new Error(
      "data/export/summary.json not found — run `npm run export` (or `npm run pipeline`) first.",
    );
  }
  mkdirSync(join(DIST_DIR, "data"), { recursive: true });
  for (const f of ["index.html", "app.js", "styles.css"]) {
    copyFileSync(join(SITE_DIR, f), join(DIST_DIR, f));
  }
  copyFileSync(summary, join(DIST_DIR, "data", "summary.json"));
  return DIST_DIR;
}
