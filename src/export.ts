import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import type { DB } from "./lib/db.js";
import { SIZE_BANDS, bandFor } from "./bands.js";

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

/** The "materially affected or reasonably likely to" boolean flag. */
const MATERIALITY_TAG =
  "CybersecurityRiskMateriallyAffectedOrReasonablyLikelyToMateriallyAffectRegistrantFlag";

/** The five boolean governance/risk-management flags (the board scorecard). */
const GOVERNANCE_TAGS = [
  "CybersecurityRiskManagementProcessesIntegratedFlag",
  "CybersecurityRiskManagementPositionsOrCommitteesResponsibleFlag",
  "CybersecurityRiskManagementPositionsOrCommitteesResponsibleReportToBoardFlag",
  "CybersecurityRiskManagementThirdPartyEngagedFlag",
  "CybersecurityRiskThirdPartyOversightAndIdentificationProcessesFlag",
];
const GOVERNANCE_IN = GOVERNANCE_TAGS.map((t) => `'${t}'`).join(",");

/**
 * CTE that reduces filings to the population we report on, joined to one boolean
 * flag's value (`mat` = 1/0/NULL) so the same breakdowns work for ANY flag:
 *   - `pop`    one row per company × fiscal-year (the time-trend basis)
 *   - `pop_co` one row per company, latest filing (the current-state basis)
 */
function annualCte(flagTag: string): string {
  return `
  WITH annual AS (
    SELECT adsh, cik, fy, sic, pubfloatusd,
           substr(period, 1, 4) AS yend,  -- calendar year of fiscal year-end
           CASE WHEN form LIKE '20-F%' THEN '20-F' ELSE '10-K' END AS form_class,
           -- rn_fy: latest filing per company per fiscal year (trend basis)
           ROW_NUMBER() OVER (PARTITION BY cik, fy
                              ORDER BY filed_date DESC, adsh DESC) AS rn_fy,
           -- rn_co: the single most recent annual filing per company
           ROW_NUMBER() OVER (PARTITION BY cik
                              ORDER BY period DESC, filed_date DESC, adsh DESC) AS rn_co
    FROM filings
    WHERE form IN ('10-K','10-K/A','10-KT','10-KT/A','20-F','20-F/A')
      AND fy IS NOT NULL AND period <> ''
  ),
  latest AS (SELECT * FROM annual WHERE rn_fy = 1),     -- one row per company x fiscal year
  latest_co AS (SELECT * FROM annual WHERE rn_co = 1),  -- one row per company (latest filing)
  mat AS (
    SELECT adsh, MAX(flag_value) AS mat
    FROM cyd_facts
    WHERE tag = '${flagTag}'
    GROUP BY adsh
  ),
  pop AS (        -- multi-year, for the time trend
    SELECT l.*, m.mat FROM latest l LEFT JOIN mat m ON m.adsh = l.adsh
  ),
  pop_co AS (     -- one per company, for current-state metrics
    SELECT l.*, m.mat FROM latest_co l LEFT JOIN mat m ON m.adsh = l.adsh
  )
`;
}

// SIC-division labels (first two digits) — accurate, readable sector grouping.
function sicDivision(sic: string | null): string {
  const n = sic ? parseInt(sic.slice(0, 2), 10) : NaN;
  if (Number.isNaN(n)) return "Unclassified";
  if (n <= 9) return "Agriculture, Forestry & Fishing";
  if (n <= 14) return "Mining";
  if (n <= 17) return "Construction";
  if (n <= 39) return "Manufacturing";
  if (n <= 49) return "Transportation & Utilities";
  if (n <= 51) return "Wholesale Trade";
  if (n <= 59) return "Retail Trade";
  if (n <= 67) return "Finance, Insurance & Real Estate";
  if (n <= 89) return "Services";
  return "Public Administration / Other";
}

interface SectorRow { sic: string; yes: number; no: number; na: number }
interface IncidentFactRow {
  adsh: string; company_name: string; form: string; filed_date: string;
  filing_url: string; tag: string; value: string;
}

function buildSummary(db: DB): unknown {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const many = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

  const rate = (yes: number, no: number): number | null =>
    yes + no === 0 ? null : +(yes / (yes + no)).toFixed(4);

  // Full set of breakdowns for ANY boolean cyd flag, over the deduped
  // populations. Materiality is just the canonical caller; the identical path
  // works for any flag tag. (Returned `companies`/`annual_reports` are
  // population sizes, independent of which flag is passed.)
  function flagBreakdowns(tag: string) {
    const cte = annualCte(tag);

    // Current state, one row per company (latest filing).
    const overallRow = one<{ yes: number; no: number; na: number; companies: number }>(`
      ${cte}
      SELECT SUM(mat=1) AS yes, SUM(mat=0) AS no,
             SUM(mat IS NULL) AS na, COUNT(*) AS companies FROM pop_co
    `);

    // Bucket by the calendar year of each company's fiscal year-end (the date
    // the disclosed state is "as of"), not the self-reported fiscal-year integer.
    const by_yearend = many<{ yearend: string; yes: number; no: number; na: number }>(`
      ${cte}
      SELECT yend AS yearend, SUM(mat=1) AS yes, SUM(mat=0) AS no, SUM(mat IS NULL) AS na
      FROM pop GROUP BY yend ORDER BY yend
    `).map((r) => ({ ...r, total: r.yes + r.no, rate: rate(r.yes, r.no) }));

    const by_form = many<{ form_class: string; yes: number; no: number }>(`
      ${cte}
      SELECT form_class, SUM(mat=1) AS yes, SUM(mat=0) AS no
      FROM pop_co GROUP BY form_class ORDER BY form_class
    `).map((r) => ({
      form: r.form_class,
      label: r.form_class === "20-F" ? "Foreign (20-F)" : "US domestic (10-K)",
      yes: r.yes, no: r.no, rate: rate(r.yes, r.no),
    }));

    // Aggregate sectors in JS so we can apply SIC-division labels.
    const sectorAgg = new Map<string, { yes: number; no: number; na: number }>();
    for (const r of many<SectorRow>(`
      ${cte}
      SELECT COALESCE(sic,'') AS sic, SUM(mat=1) AS yes, SUM(mat=0) AS no,
             SUM(mat IS NULL) AS na
      FROM pop_co GROUP BY sic
    `)) {
      const div = sicDivision(r.sic || null);
      const cur = sectorAgg.get(div) ?? { yes: 0, no: 0, na: 0 };
      cur.yes += r.yes; cur.no += r.no; cur.na += r.na;
      sectorAgg.set(div, cur);
    }
    const by_sector = [...sectorAgg.entries()]
      .map(([sector, v]) => ({
        sector, yes: v.yes, no: v.no, total: v.yes + v.no, rate: rate(v.yes, v.no),
      }))
      .filter((r) => r.total >= 30) // suppress tiny, noisy cells
      .sort((a, b) => b.total - a.total); // largest sectors first

    // By market-cap band: POPULATION 2 ONLY. INNER JOIN to market_cap drops
    // every company without a calculated market cap for its date — we never
    // assume or impute size (see roadmap rule).
    const sizeRows = many<{ mat: number | null; mcap: number }>(`
      ${cte}
      SELECT pc.mat AS mat, mc.market_cap_usd AS mcap
      FROM pop_co pc JOIN market_cap mc ON mc.cik = pc.cik
    `);
    const bandAgg = new Map<string, { companies: number; yes: number; no: number }>();
    for (const b of SIZE_BANDS) bandAgg.set(b.label, { companies: 0, yes: 0, no: 0 });
    for (const r of sizeRows) {
      const b = bandFor(r.mcap);
      if (!b) continue;
      const cell = bandAgg.get(b.label)!;
      cell.companies++;
      if (r.mat === 1) cell.yes++;
      else if (r.mat === 0) cell.no++;
    }
    const bands = SIZE_BANDS.map((b) => {
      const c = bandAgg.get(b.label)!;
      return {
        label: b.label,
        min: b.min,
        max: Number.isFinite(b.max) ? b.max : null, // JSON has no Infinity
        companies: c.companies,
        yes: c.yes,
        no: c.no,
        rate: rate(c.yes, c.no),
      };
    });

    return {
      companies: overallRow.companies,
      annual_reports: by_yearend.reduce((a, r) => a + r.yes + r.no + r.na, 0),
      overall: {
        yes: overallRow.yes, no: overallRow.no, not_disclosed: overallRow.na,
        rate: rate(overallRow.yes, overallRow.no),
      },
      by_yearend,
      by_form,
      by_sector,
      by_size: { priced: sizeRows.length, bands },
    };
  }

  const materiality = flagBreakdowns(MATERIALITY_TAG);

  // --- Governance scorecard (one row per company, latest filing) ---
  // Reusable CTE: one row per (company, governance flag) collapsed value.
  // (The flag tag passed to annualCte is irrelevant here — `fv` uses latest_co.)
  const GOV_FV = `
    ${annualCte(MATERIALITY_TAG)}
    , fv AS (
      SELECT c.adsh, c.tag, MAX(c.flag_value) AS v
      FROM cyd_facts c JOIN latest_co l ON l.adsh = c.adsh
      WHERE c.tag IN (${GOVERNANCE_IN}) AND c.flag_value IS NOT NULL
      GROUP BY c.adsh, c.tag
    )`;

  // How many of the five governance practices each company affirms. The base is
  // companies that disclosed governance at all (≥1 of the five flags).
  const completeness = many<{ yes_count: number; n: number }>(`
    ${GOV_FV}, per AS (SELECT adsh, SUM(v=1) AS yes_count FROM fv GROUP BY adsh)
    SELECT yes_count, COUNT(*) AS n FROM per GROUP BY yes_count ORDER BY yes_count
  `);
  const completenessBase = completeness.reduce((a, r) => a + r.n, 0);

  // Per flag: affirmative-disclosure rate over that same base (yes / base).
  // (Explicit "no" is rare; the meaningful spread is how many companies
  // affirm each practice vs. stay silent on it.)
  const govFlags = many<{ tag: string; yes: number; no: number }>(`
    ${GOV_FV}
    SELECT tag, SUM(v=1) AS yes, SUM(v=0) AS no FROM fv GROUP BY tag
  `).map((r) => ({
    tag: r.tag,
    affirmed: r.yes,
    explicit_no: r.no,
    base: completenessBase,
    rate: completenessBase ? +(r.yes / completenessBase).toFixed(4) : null,
  }));

  // --- Material-incident feed (events with a disclosed incident nature) ---
  const SNIP = (s: string) =>
    s.length > 280 ? s.slice(0, 277).trimEnd() + "…" : s;
  // Restrict to current reports (8-K Item 1.05 for domestic filers; 6-K for
  // foreign private issuers) — the mechanisms for reporting an actual material
  // incident. Annual reports (10-K/20-F) often tag the same incident elements
  // with "no incident"/boilerplate text, so we exclude them here.
  const incidentMap = new Map<string, Record<string, string>>();
  for (const r of many<IncidentFactRow>(`
    SELECT f.adsh, f.company_name, f.form, f.filed_date, f.filing_url, c.tag, c.value
    FROM filings f JOIN cyd_facts c ON c.adsh = f.adsh
    WHERE f.form IN ('8-K','8-K/A','6-K','6-K/A')
      AND c.tag LIKE 'MaterialCybersecurityIncident%' AND c.value <> ''
    ORDER BY f.filed_date DESC
  `)) {
    const it = incidentMap.get(r.adsh) ?? {
      adsh: r.adsh, company: r.company_name, form: r.form,
      filed_date: r.filed_date, filing_url: r.filing_url,
    };
    const key = r.tag
      .replace(/^MaterialCybersecurityIncident/, "")
      .replace(/TextBlock$/, "");
    it[key.charAt(0).toLowerCase() + key.slice(1)] = SNIP(r.value);
    incidentMap.set(r.adsh, it);
  }
  const incidents = [...incidentMap.values()]
    .sort((a, b) => (b.filed_date ?? "").localeCompare(a.filed_date ?? ""))
    .slice(0, 40);

  const coverage = one<{ min: string; max: string }>(
    "SELECT MIN(filed_date) min, MAX(filed_date) max FROM filings",
  );

  return {
    generated_at: new Date().toISOString(),
    source: "SEC EDGAR Financial Statement and Notes Data Sets (cyd: taxonomy)",
    coverage: { first_filed: coverage.min, last_filed: coverage.max },
    totals: {
      filings: one<{ n: number }>("SELECT COUNT(*) n FROM filings").n,
      facts: one<{ n: number }>("SELECT COUNT(*) n FROM cyd_facts").n,
      // distinct companies with an annual cyber filing (latest-filing basis)
      companies: materiality.companies,
      // total annual reports across all years (the trend's basis)
      annual_reports: materiality.annual_reports,
      tags: one<{ n: number }>("SELECT COUNT(*) n FROM cyd_tags").n,
    },
    materiality: {
      tag: MATERIALITY_TAG,
      overall: materiality.overall,
      by_yearend: materiality.by_yearend,
      by_form: materiality.by_form,
      by_sector: materiality.by_sector,
      by_size: materiality.by_size,
    },
    governance: {
      flags: govFlags,
      completeness,
      completeness_base: completenessBase,
    },
    incidents,
    periods: many(
      "SELECT period, filings_count AS filings, facts_count AS facts FROM ingested_periods ORDER BY period",
    ),
    by_form: many("SELECT form, COUNT(*) n FROM filings GROUP BY form ORDER BY n DESC"),
    // Yes/No rates per boolean cyd tag — feeds the (later) governance scorecard.
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
