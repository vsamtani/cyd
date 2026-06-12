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

```bash
npm run fetch      # download all available FSN dataset zips -> data/raw/
npm run ingest     # parse data/raw/*_notes.zip -> data/cyd.db
npm run pipeline   # fetch + ingest + print summary
npm run status     # print a summary of what's in the database
```

Both `fetch` and `ingest` are **idempotent**: re-running skips already-downloaded
zips (except the latest period, which is refreshed) and upserts rows so counts
stay stable. Raw zips are **retained** — see "Data model" below.

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
