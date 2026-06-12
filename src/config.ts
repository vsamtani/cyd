import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (parent of src/). */
export const ROOT = join(__dirname, "..");
export const DATA_DIR = join(ROOT, "data");
export const RAW_DIR = join(DATA_DIR, "raw");
export const DB_PATH = join(DATA_DIR, "cyd.db");
export const SCHEMA_PATH = join(ROOT, "sql", "schema.sql");

/**
 * SEC requires a descriptive User-Agent identifying the requester, otherwise
 * requests are blocked. Override via the SEC_USER_AGENT env var.
 * See https://www.sec.gov/os/webmaster-faq#developers
 */
export const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "cyd-dashboard vijay@samtani.net";

/** Base URL for the Financial Statement and Notes Data Sets (note: no "and-"). */
export const FSN_BASE =
  "https://www.sec.gov/files/dera/data/financial-statement-notes-data-sets";

/** EDGAR archives base, used to build per-filing index URLs. */
export const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";

/**
 * Earliest period to consider. The CYD taxonomy launched on EDGAR in
 * 2024-09, so cyd facts first appear around 2024 Q3/Q4.
 */
export const START_PERIOD = { year: 2024, quarter: 3 } as const;

/** Forms whose cyd disclosures we keep. */
export const ALLOWED_FORMS = new Set([
  "10-K",
  "10-K/A",
  "20-F",
  "20-F/A",
  "8-K",
  "8-K/A",
]);

/**
 * Minimum spacing between HTTP requests, in ms. SEC's fair-access limit is
 * 10 req/s; ~150ms keeps us comfortably under that (<7 req/s).
 */
export const MIN_REQUEST_INTERVAL_MS = 150;

/** Max retry attempts for transient (429/5xx/network) failures. */
export const MAX_RETRIES = 5;
