import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import type { DB } from "./lib/db.js";

/** Directory for committed, text-based exports (tracked in git; feeds the static site). */
export const EXPORT_DIR = join(DATA_DIR, "export");

// ---- CSV helpers (values are newline/tab-free; only need comma/quote escaping) ----

function csvField(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (vals: (string | number | null)[]) =>
  vals.map(csvField).join(",") + "\n";

/** Stream rows from a query to a (optionally gzipped) CSV file, honoring backpressure. */
async function writeCsv(
  db: DB,
  sql: string,
  header: string[],
  destPath: string,
  gzip = false,
): Promise<number> {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const file = createWriteStream(destPath);
  const sink = gzip ? createGzip() : file;
  if (gzip) sink.pipe(file);

  const write = async (chunk: string) => {
    if (!sink.write(chunk)) await once(sink, "drain");
  };

  await write(csvRow(header));
  let n = 0;
  for (const row of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
    await write(csvRow(header.map((h) => row[h] as string | number | null)));
    n++;
  }
  sink.end();
  await once(file, "finish");
  return n;
}

// ---- Pre-aggregated summary for the dashboard ------------------------------

function buildSummary(db: DB): unknown {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const many = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

  return {
    generated_at: new Date().toISOString(),
    source: "SEC EDGAR Financial Statement and Notes Data Sets (cyd: taxonomy)",
    totals: {
      filings: one<{ n: number }>("SELECT COUNT(*) n FROM filings").n,
      facts: one<{ n: number }>("SELECT COUNT(*) n FROM cyd_facts").n,
      companies: one<{ n: number }>(
        "SELECT COUNT(DISTINCT cik) n FROM filings",
      ).n,
      tags: one<{ n: number }>("SELECT COUNT(*) n FROM cyd_tags").n,
    },
    periods: many(
      "SELECT period, filings_count AS filings, facts_count AS facts FROM ingested_periods ORDER BY period",
    ),
    by_form: many("SELECT form, COUNT(*) n FROM filings GROUP BY form ORDER BY n DESC"),
    by_fiscal_year: many(
      "SELECT fy, COUNT(*) n FROM filings WHERE fy IS NOT NULL GROUP BY fy ORDER BY fy",
    ),
    by_country_inc: many(
      "SELECT COALESCE(NULLIF(country_inc,''),'US/blank') AS country, COUNT(*) n FROM filings GROUP BY country ORDER BY n DESC LIMIT 25",
    ),
    top_sic: many(
      "SELECT sic, COUNT(*) n FROM filings WHERE sic IS NOT NULL AND sic<>'' GROUP BY sic ORDER BY n DESC LIMIT 20",
    ),
    // Yes/No disclosure rates per boolean cyd tag — the core dashboard metric.
    flags: many(`
      SELECT c.tag,
             MAX(t.label) AS label,
             SUM(CASE WHEN c.flag_value=1 THEN 1 ELSE 0 END) AS yes,
             SUM(CASE WHEN c.flag_value=0 THEN 1 ELSE 0 END) AS no,
             COUNT(*) AS total
      FROM cyd_facts c LEFT JOIN cyd_tags t ON t.tag=c.tag AND t.version=c.version
      WHERE c.is_flag=1
      GROUP BY c.tag ORDER BY total DESC
    `),
  };
}

// ---- Entry point -----------------------------------------------------------

export interface ExportResult {
  filings: number;
  facts: number;
  textFacts: number;
  tags: number;
}

export async function exportAll(db: DB): Promise<ExportResult> {
  mkdirSync(EXPORT_DIR, { recursive: true });

  const filings = await writeCsv(
    db,
    `SELECT adsh, cik, company_name, sic, form, is_amendment, fy, fp, period,
            filed_date, country_inc, country_ba, pubfloatusd, filing_url
     FROM filings ORDER BY filed_date, adsh`,
    [
      "adsh", "cik", "company_name", "sic", "form", "is_amendment", "fy", "fp",
      "period", "filed_date", "country_inc", "country_ba", "pubfloatusd", "filing_url",
    ],
    join(EXPORT_DIR, "filings.csv"),
  );

  const tags = await writeCsv(
    db,
    "SELECT tag, version, datatype, label FROM cyd_tags ORDER BY tag, version",
    ["tag", "version", "datatype", "label"],
    join(EXPORT_DIR, "cyd_tags.csv"),
  );

  // Structural facts (no text) — small, plain CSV; drives client-side analytics.
  const facts = await writeCsv(
    db,
    `SELECT adsh, tag, version, ddate, qtrs, dimh, is_flag, flag_value, txtlen
     FROM cyd_facts ORDER BY adsh, tag`,
    ["adsh", "tag", "version", "ddate", "qtrs", "dimh", "is_flag", "flag_value", "txtlen"],
    join(EXPORT_DIR, "facts.csv"),
  );

  // Disclosure text blocks — bulky, so gzipped. (Truncated by SEC; full text via filing_url.)
  const textFacts = await writeCsv(
    db,
    `SELECT adsh, tag, version, ddate, dimh, value
     FROM cyd_facts WHERE is_flag=0 AND value<>'' ORDER BY adsh, tag`,
    ["adsh", "tag", "version", "ddate", "dimh", "value"],
    join(EXPORT_DIR, "text.csv.gz"),
    true,
  );

  writeFileSync(
    join(EXPORT_DIR, "summary.json"),
    JSON.stringify(buildSummary(db), null, 2) + "\n",
  );

  return { filings, facts, textFacts, tags };
}
