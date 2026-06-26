-- Schema for the CYD (SEC cybersecurity disclosure) filings database.
-- Populated by src/ingest.ts from the EDGAR Financial Statement and Notes Data Sets.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per filing (10-K / 20-F / 8-K and their /A amendments) that carries
-- at least one cyd: fact. Metadata comes from sub.tsv.
CREATE TABLE IF NOT EXISTS filings (
  adsh          TEXT PRIMARY KEY,   -- accession number, e.g. 0000320193-25-000073
  cik           INTEGER NOT NULL,
  company_name  TEXT,
  sic           TEXT,               -- Standard Industrial Classification code
  form          TEXT NOT NULL,      -- 10-K, 20-F, 8-K, ... (with /A for amendments)
  is_amendment  INTEGER NOT NULL DEFAULT 0,
  period        TEXT,               -- balance/period date, YYYYMMDD
  fy            INTEGER,            -- fiscal year
  fp            TEXT,               -- fiscal period (FY, Q1, ...)
  filed_date    TEXT,               -- YYYYMMDD
  accepted      TEXT,               -- acceptance datetime
  country_inc   TEXT,               -- country of incorporation
  state_inc     TEXT,               -- state/province of incorporation
  country_ba    TEXT,               -- business-address country
  state_ba      TEXT,               -- business-address state/province
  ein           TEXT,
  instance      TEXT,               -- primary instance document name
  pubfloatusd   REAL,               -- public float in USD (market-cap proxy)
  source_period TEXT,               -- FSN dataset period this row was ingested from
  filing_url    TEXT                -- EDGAR filing index URL
);

CREATE INDEX IF NOT EXISTS idx_filings_form        ON filings(form);
CREATE INDEX IF NOT EXISTS idx_filings_fy          ON filings(fy);
CREATE INDEX IF NOT EXISTS idx_filings_sic         ON filings(sic);
CREATE INDEX IF NOT EXISTS idx_filings_country_inc ON filings(country_inc);

-- cyd taxonomy dictionary (from tag.tsv), used to label facts and classify
-- flags vs text blocks.
CREATE TABLE IF NOT EXISTS cyd_tags (
  tag      TEXT NOT NULL,           -- element name, e.g. CybersecurityRiskManagementProcessesIntegratedFlag
  version  TEXT NOT NULL,           -- cyd/2024, cyd/2025, ...
  datatype TEXT,                    -- textBlock, boolean, date, ...
  label    TEXT,                    -- human-readable label
  doc      TEXT,                    -- documentation string
  PRIMARY KEY (tag, version)
);

-- One row per cyd: fact (from txt.tsv).
CREATE TABLE IF NOT EXISTS cyd_facts (
  adsh       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  version    TEXT NOT NULL,
  ddate      TEXT,                  -- period end date the value applies to, YYYYMMDD
  qtrs       INTEGER,               -- duration in quarters (0 = point in time)
  dimh       TEXT NOT NULL DEFAULT '', -- dimension/segment hash ('' = default member)
  iprx       INTEGER NOT NULL DEFAULT 0, -- distinguishes otherwise-identical facts
  coreg      TEXT NOT NULL DEFAULT '',   -- co-registrant
  lang       TEXT,
  escaped    INTEGER,               -- 1 if value is HTML-escaped markup
  srclen     INTEGER,               -- original source length before truncation
  txtlen     INTEGER,               -- length of stored (possibly truncated) value
  value      TEXT,                  -- text-block content or flag value ("true"/"false")
  is_flag    INTEGER NOT NULL DEFAULT 0, -- 1 if the tag's datatype is boolean
  flag_value INTEGER,               -- 1/0 for booleans, NULL otherwise
  PRIMARY KEY (adsh, tag, version, ddate, qtrs, dimh, iprx, coreg),
  FOREIGN KEY (adsh) REFERENCES filings(adsh) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cyd_facts_tag  ON cyd_facts(tag);
CREATE INDEX IF NOT EXISTS idx_cyd_facts_adsh ON cyd_facts(adsh);

-- Estimated market capitalisation per company, as of its latest fiscal
-- year-end: shares outstanding (dei, from the filing) x Stooq close price on or
-- before that date. Populated by src/marketcap.ts.
CREATE TABLE IF NOT EXISTS market_cap (
  adsh           TEXT PRIMARY KEY, -- the in-scope filing this market cap is for
  cik            INTEGER,
  form           TEXT,
  ticker         TEXT,
  as_of          TEXT,    -- relevant date: fiscal year-end (annual) or filed (8-K)
  as_of_kind     TEXT,    -- 'yearend' | 'filed'
  shares         REAL,    -- total common shares outstanding
  price          REAL,    -- close (USD) on/before as_of
  price_date     TEXT,    -- actual trading date used (<= as_of)
  source         TEXT,    -- 'stooq' | 'alphavantage'
  market_cap_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_market_cap_cik ON market_cap(cik);

-- Bookkeeping: which FSN dataset periods have been ingested.
CREATE TABLE IF NOT EXISTS ingested_periods (
  period         TEXT PRIMARY KEY,  -- 2025_06 or 2025q1
  url            TEXT,
  zip_bytes      INTEGER,
  filings_count  INTEGER,
  facts_count    INTEGER,
  ingested_at    TEXT
);
