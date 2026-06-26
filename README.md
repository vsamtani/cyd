# cyd — SEC cybersecurity disclosure data pipeline

Downloads and ingests SEC **10-K**, **20-F**, and **8-K** filings' Inline-XBRL
**Cybersecurity Disclosure (CYD)** tags (the `cyd:` namespace) into a local
SQLite database, ready for analysis and a future dashboard.

## Background

The SEC adopted cybersecurity disclosure rules requiring registrants to tag
their disclosures with the CYD taxonomy in Inline XBRL, mandatory for fiscal
years ending on/after **2024-12-15** (Reg S-K Item 106 → Form 10-K Item 1C;
Form 20-F Item 16K; 8-K Item 1.05 for material incidents).

These `cyd:` facts are **not** exposed by the `data.sec.gov` CompanyFacts/Frames
APIs (which only return `us-gaap`/`dei`). They are available in the bulk
[Financial Statement and Notes Data Sets](https://www.sec.gov/data-research/sec-markets-data/financial-statement-notes-data-sets),
which this project downloads and parses.

## Requirements

- Node.js ≥ 20 (uses built-in `fetch`)
- ~2–2.5 GB free disk for the full raw-zip history

## Setup

```bash
npm install
# SEC requires a descriptive User-Agent. Default is set; override if you like:
export SEC_USER_AGENT="your-app your-email@example.com"
```

## Usage

Refresh all data, then commit and push to redeploy the dashboard:

```bash
npm run refresh    # fetch -> split -> ingest -> marketcap -> export -> incidents
git add data/source data/export && git commit -m "Refresh data" && git push  # -> Pages deploy
```

Individual steps:

```bash
npm run fetch      # download available FSN dataset zips -> data/raw/
npm run split      # filter zips into committed per-day source files -> data/source/
npm run ingest     # load data/source/ -> data/cyd.db
npm run marketcap  # price filings -> data/source/marketcap.ndjson (Stooq + AV)
npm run export     # write data/export/ (CSVs + summary.json)
npm run incidents  # fetch + sanitise incident filing text -> data/export/incidents/
npm run status     # summary of the database
npm run dev        # build dist/ and serve at http://localhost:8000
```

`data/source/` holds the **public-domain source data** as one immutable NDJSON
file per filing-day (`YYYY/YYYY-MM-DD.ndjson`) — in-scope filing metadata + cyd
facts, plus a shared `cyd_tags.ndjson`. `ingest` reads these (no raw zips
needed), so the dataset is **reproducible from git alone**, and refreshes append
new day-files rather than rewriting. Market cap is committed the same way in
`data/source/marketcap.ndjson` (one record per priced filing, append-only);
`ingest` loads it, so size bands build with no pricing at build time. `marketcap`
backfills from the local Stooq file and fills gaps via Alpha Vantage
(`ALPHAVANTAGE_API_KEY`, free, ~25 calls/run) — without the key it still does the
full Stooq backfill and leaves the rest pending. Steps are **idempotent**; raw zips are
**retained** (see "Data model"). The dashboard is built from the committed
`data/export/` and deployed to GitHub Pages on push to `main`. `split` and
`marketcap` need the cached raw zips (and `marketcap` the Stooq file at
`data/raw/d_us_txt.zip`); `ingest` and downstream work from committed data alone.

## Data model (`data/cyd.db`)

- **`filings`** — one row per in-scope filing carrying ≥1 cyd fact (form, CIK,
  company, SIC, country, fiscal year, public float, EDGAR `filing_url`, …).
- **`cyd_facts`** — one row per cyd fact (tag, value, and for boolean tags a
  normalized `flag_value` of 1/0). Joins to `filings` via `adsh`.
- **`cyd_tags`** — the CYD taxonomy dictionary (datatype + human label per tag).
- **`ingested_periods`** — bookkeeping per FSN dataset period.

> Text-block values are length-capped by the SEC (truncated). They're sufficient
> for statistics; full disclosure text can be read at each filing's `filing_url`.

### Why raw zips are kept

The pipeline is download-once / parse-many. The same FSN zips also contain
`us-gaap`/`dei` financial facts (revenue, assets, shares outstanding) in
`num.tsv`, and public float in `sub.tsv`. A later phase can join contextual
financials onto these filings (by `adsh`) **without any re-download**.

## Fair access

All HTTP goes through one rate-limited client (`src/lib/http.ts`): it sends the
required `User-Agent`, spaces requests (<7 req/s, under SEC's 10 req/s limit),
and backs off on `429`/`5xx` honoring `Retry-After`.
