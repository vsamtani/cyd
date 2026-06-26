import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import yauzl from "yauzl";
import {
  RAW_DIR, MARKETCAP_FILE, MARKETCAP_AVFAILED_FILE,
  ALPHAVANTAGE_KEY, ALPHAVANTAGE_DAILY_LIMIT,
} from "./config.js";
import { download } from "./lib/http.js";
import { streamEntryLines } from "./lib/zip.js";
import type { DB } from "./lib/db.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKERS_CACHE = join(RAW_DIR, "company_tickers.json");
const STOOQ_ZIP = join(RAW_DIR, "d_us_txt.zip");
const DEI_SHARES = "EntityCommonStockSharesOutstanding";
const USGAAP_SHARES = "CommonStockSharesOutstanding";
const TRADING_SYMBOL = "TradingSymbol";
const MAX_SHARES = 5e10; // guards against filer XBRL scaling errors
const MAX_MCAP = 5e12;

// ---- a priced market-cap record (one per filing) ---------------------------
interface McRecord {
  adsh: string; cik: number; form: string; ticker: string;
  as_of: string; as_of_kind: "yearend" | "filed";
  shares: number; shares_from: string;
  price: number; price_date: string; source: "stooq" | "alphavantage";
  market_cap: number;
}

// A filing that still needs a price.
interface Candidate {
  adsh: string; cik: number; form: string; ticker: string;
  as_of: string; as_of_kind: "yearend" | "filed";
  shares: number; shares_from: string;
}

// ---- shared SEC inputs (read from the cached zips at compute time) ----------

function loadTickerCandidates(): Map<number, string[]> {
  const raw = JSON.parse(readFileSync(TICKERS_CACHE, "utf8")) as Record<
    string, { cik_str: number; ticker: string }
  >;
  const map = new Map<number, string[]>();
  for (const { cik_str, ticker } of Object.values(raw)) {
    if (!ticker) continue;
    (map.get(cik_str) ?? map.set(cik_str, []).get(cik_str)!).push(ticker.toUpperCase());
  }
  return map;
}

async function ensureTickerCache(): Promise<void> {
  if (existsSync(TICKERS_CACHE)) return;
  process.stdout.write("  fetching SEC company_tickers.json ... ");
  await download(TICKERS_URL, TICKERS_CACHE);
  console.log("ok");
}

/** cik -> declared trading symbols (dei:TradingSymbol, from the cached txt.tsv). */
async function loadTradingSymbols(db: DB): Promise<Map<number, string[]>> {
  // adsh -> cik and group annual filings' adsh by their source zip (one query).
  const adshCik = new Map<string, number>();
  const byZip = new Map<string, Set<string>>();
  for (const r of db.prepare(
    "SELECT adsh, cik, source_period FROM filings WHERE form IN ('10-K','10-K/A','10-KT','10-KT/A')",
  ).all() as { adsh: string; cik: number; source_period: string }[]) {
    adshCik.set(r.adsh, r.cik);
    (byZip.get(r.source_period) ?? byZip.set(r.source_period, new Set()).get(r.source_period)!).add(r.adsh);
  }

  const out = new Map<number, string[]>();
  for (const [sp, adshSet] of byZip) {
    const zip = join(RAW_DIR, `${sp}_notes.zip`);
    if (!existsSync(zip) || adshSet.size === 0) continue;
    let header = true;
    for await (const line of streamEntryLines(zip, "txt.tsv")) {
      if (header) { header = false; continue; }
      const f = line.split("\t");
      if (f[1] !== TRADING_SYMBOL || !adshSet.has(f[0]!)) continue;
      const cik = adshCik.get(f[0]!)!;
      const sym = (f[f.length - 1] ?? "").trim().toUpperCase();
      if (!sym || /[^A-Z0-9.-]/.test(sym)) continue;
      const list = out.get(cik) ?? out.set(cik, []).get(cik)!;
      if (!list.includes(sym)) list.push(sym);
    }
  }
  return out;
}

/** adsh -> total common shares outstanding (dei preferred, us-gaap fallback). */
async function loadShares(db: DB, adshList: string[]): Promise<Map<string, number>> {
  const need = new Set(adshList);
  const byZip = new Map<string, Set<string>>();
  for (const r of db.prepare(
    "SELECT adsh, source_period FROM filings",
  ).all() as { adsh: string; source_period: string }[]) {
    if (!need.has(r.adsh)) continue;
    (byZip.get(r.source_period) ?? byZip.set(r.source_period, new Set()).get(r.source_period)!).add(r.adsh);
  }
  type Cell = { def: number | null; sum: number };
  const acc = new Map<string, { dei: Map<string, Cell>; usg: Map<string, Cell> }>();
  const add = (which: "dei" | "usg", adsh: string, ddate: string, dimh: string, v: number) => {
    const a = acc.get(adsh) ?? acc.set(adsh, { dei: new Map(), usg: new Map() }).get(adsh)!;
    const m = a[which];
    const cell = m.get(ddate) ?? { def: null, sum: 0 };
    if (dimh === "") cell.def = (cell.def ?? 0) + v; else cell.sum += v;
    m.set(ddate, cell);
  };
  for (const [sp, set] of byZip) {
    const zip = join(RAW_DIR, `${sp}_notes.zip`);
    if (!existsSync(zip)) continue;
    let header = true;
    for await (const line of streamEntryLines(zip, "num.tsv")) {
      if (header) { header = false; continue; }
      const f = line.split("\t");
      const which = f[1] === DEI_SHARES ? "dei" : f[1] === USGAAP_SHARES ? "usg" : null;
      if (!which || !set.has(f[0]!)) continue;
      const v = parseFloat(f[8]!);
      if (Number.isFinite(v)) add(which, f[0]!, f[3]!, f[6] ?? "", v);
    }
  }
  const resolve = (m: Map<string, Cell>): number | null => {
    if (m.size === 0) return null;
    const cell = m.get([...m.keys()].sort().at(-1)!)!;
    return cell.def ?? cell.sum;
  };
  const out = new Map<string, number>();
  for (const [adsh, a] of acc) {
    const v = resolve(a.dei) ?? resolve(a.usg);
    if (v && v > 0) out.set(adsh, v);
  }
  return out;
}

function loadStooqUniverse(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const set = new Set<string>();
    yauzl.open(STOOQ_ZIP, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("open failed"));
      zip.on("entry", (e: yauzl.Entry) => {
        const m = /([^/]+)\.us\.txt$/i.exec(e.fileName);
        if (m) set.add(m[1]!.toUpperCase());
        zip.readEntry();
      });
      zip.on("end", () => resolve(set));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Stooq pass: price every candidate whose ticker Stooq covers for its as-of date. */
function stooqPrice(
  byTicker: Map<string, Candidate[]>,
): Promise<Map<string, { date: string; close: number }>> {
  // returns "adsh" -> {date, close}
  return new Promise((resolve, reject) => {
    const out = new Map<string, { date: string; close: number }>();
    yauzl.open(STOOQ_ZIP, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("open failed"));
      zip.on("entry", (entry: yauzl.Entry) => {
        const m = /([^/]+)\.us\.txt$/i.exec(entry.fileName);
        const tic = m ? m[1]!.toUpperCase() : null;
        if (!tic || !byTicker.has(tic)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry();
          const series: [string, number][] = []; // ascending by date
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          let first = true;
          rl.on("line", (line) => {
            if (first) { first = false; return; }
            const p = line.split(",");
            if (p.length >= 8) series.push([p[2]!, parseFloat(p[7]!)]);
          });
          rl.on("close", () => {
            for (const c of byTicker.get(tic)!) {
              // last close on/before as_of
              let lo = 0, hi = series.length - 1, best = -1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (series[mid]![0] <= c.as_of) { best = mid; lo = mid + 1; } else hi = mid - 1;
              }
              if (best >= 0) out.set(c.adsh, { date: series[best]![0], close: series[best]![1] });
            }
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Alpha Vantage: full weekly-adjusted history for one ticker (date -> close, ascending). */
async function avWeekly(ticker: string): Promise<[string, number][] | null> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${ALPHAVANTAGE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  if (data["Note"] || data["Information"]) throw new Error("alpha-vantage-rate-limited");
  const series = data["Weekly Adjusted Time Series"] as Record<string, Record<string, string>> | undefined;
  if (!series) return null; // unknown symbol / no data
  const rows: [string, number][] = Object.entries(series)
    .map(([date, v]) => [date.replace(/-/g, ""), parseFloat(v["5. adjusted close"]!)] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return rows.length ? rows : null;
}

function closeOnOrBefore(series: [string, number][], asOf: string): { date: string; close: number } | null {
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]![0] <= asOf) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? { date: series[best]![0], close: series[best]![1] } : null;
}

// ---- committed-file I/O ----------------------------------------------------

function readPriced(): Map<string, McRecord> {
  const out = new Map<string, McRecord>();
  if (!existsSync(MARKETCAP_FILE)) return out;
  for (const line of readFileSync(MARKETCAP_FILE, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as McRecord;
    out.set(r.adsh, r);
  }
  return out;
}
function writePriced(records: Map<string, McRecord>): void {
  const lines = [...records.values()]
    .sort((a, b) => a.adsh.localeCompare(b.adsh))
    .map((r) => JSON.stringify(r));
  writeFileSync(MARKETCAP_FILE, lines.join("\n") + "\n");
}
function readAvFailed(): Set<string> {
  if (!existsSync(MARKETCAP_AVFAILED_FILE)) return new Set();
  return new Set(JSON.parse(readFileSync(MARKETCAP_AVFAILED_FILE, "utf8")) as string[]);
}
function writeAvFailed(s: Set<string>): void {
  writeFileSync(MARKETCAP_AVFAILED_FILE, JSON.stringify([...s].sort(), null, 0) + "\n");
}

// ---- orchestration ---------------------------------------------------------

export interface MarketCapResult {
  priced: number; newStooq: number; newAv: number; pending: number; avTried: number;
}

export async function computeMarketCaps(db: DB): Promise<MarketCapResult> {
  if (!existsSync(STOOQ_ZIP)) throw new Error(`Stooq data not found at ${STOOQ_ZIP}`);
  await ensureTickerCache();

  const priced = readPriced();
  const avFailed = readAvFailed();

  // Candidates: latest US-domestic annual filing per company + all 8-K incidents.
  const annual = db.prepare(`
    WITH a AS (
      SELECT cik, adsh, period, form,
        ROW_NUMBER() OVER (PARTITION BY cik ORDER BY period DESC, filed_date DESC, adsh DESC) rn
      FROM filings WHERE form IN ('10-K','10-K/A','10-KT','10-KT/A') AND period <> ''
    ) SELECT cik, adsh, period, form FROM a WHERE rn = 1
  `).all() as { cik: number; adsh: string; period: string; form: string }[];
  const incidents = db.prepare(
    "SELECT cik, adsh, filed_date AS filed, form FROM filings WHERE form IN ('8-K','8-K/A') AND filed_date <> ''",
  ).all() as { cik: number; adsh: string; filed: string; form: string }[];

  const tickerCands = loadTickerCandidates();
  const symbols = await loadTradingSymbols(db);
  const universe = await loadStooqUniverse();
  const pickTicker = (cik: number): string | undefined =>
    [...(symbols.get(cik) ?? []), ...(tickerCands.get(cik) ?? [])].find((t) => universe.has(t)) ??
    (symbols.get(cik) ?? tickerCands.get(cik) ?? [])[0]; // fall back to a declared symbol for AV

  // Shares: annual from each filing; incidents borrow the company's latest annual.
  const annualShares = await loadShares(db, annual.map((a) => a.adsh));
  const sharesByCik = new Map<number, { adsh: string; shares: number }>();
  for (const a of annual) {
    const s = annualShares.get(a.adsh);
    if (s) sharesByCik.set(a.cik, { adsh: a.adsh, shares: s });
  }

  // Build the candidate list for filings not already priced.
  const candidates: Candidate[] = [];
  for (const a of annual) {
    if (priced.has(a.adsh)) continue;
    const ticker = pickTicker(a.cik); const shares = annualShares.get(a.adsh);
    if (!ticker || !shares) continue;
    candidates.push({ adsh: a.adsh, cik: a.cik, form: a.form, ticker, as_of: a.period, as_of_kind: "yearend", shares, shares_from: a.adsh });
  }
  for (const i of incidents) {
    if (priced.has(i.adsh)) continue;
    const ticker = pickTicker(i.cik); const borrowed = sharesByCik.get(i.cik);
    if (!ticker || !borrowed) continue;
    candidates.push({ adsh: i.adsh, cik: i.cik, form: i.form, ticker, as_of: i.filed, as_of_kind: "filed", shares: borrowed.shares, shares_from: borrowed.adsh });
  }

  const isIncident = (c: Candidate) => c.as_of_kind === "filed";
  const record = (c: Candidate, price: number, price_date: string, source: McRecord["source"]) => {
    const mc = c.shares * price;
    if (c.shares > MAX_SHARES || mc > MAX_MCAP) return; // scaling-error guard
    priced.set(c.adsh, {
      adsh: c.adsh, cik: c.cik, form: c.form, ticker: c.ticker,
      as_of: c.as_of, as_of_kind: c.as_of_kind, shares: c.shares, shares_from: c.shares_from,
      price, price_date, source, market_cap: mc,
    });
  };

  // 1) Stooq pass (local, unlimited).
  const stooqByTicker = new Map<string, Candidate[]>();
  for (const c of candidates) if (universe.has(c.ticker)) (stooqByTicker.get(c.ticker) ?? stooqByTicker.set(c.ticker, []).get(c.ticker)!).push(c);
  const stooqPrices = await stooqPrice(stooqByTicker);
  let newStooq = 0;
  const stillUnpriced: Candidate[] = [];
  for (const c of candidates) {
    const p = stooqPrices.get(c.adsh);
    if (p) { record(c, p.close, p.date, "stooq"); newStooq++; } else stillUnpriced.push(c);
  }

  // 2) Alpha Vantage backlog: leftover candidates, grouped by ticker, incidents first.
  const avByTicker = new Map<string, Candidate[]>();
  for (const c of stillUnpriced) {
    if (avFailed.has(c.ticker)) continue;
    (avByTicker.get(c.ticker) ?? avByTicker.set(c.ticker, []).get(c.ticker)!).push(c);
  }
  const avTickers = [...avByTicker.keys()].sort((a, b) => {
    const ai = avByTicker.get(a)!.some(isIncident) ? 0 : 1;
    const bi = avByTicker.get(b)!.some(isIncident) ? 0 : 1;
    return ai - bi || a.localeCompare(b);
  });

  let newAv = 0, avTried = 0;
  if (ALPHAVANTAGE_KEY) {
    for (const ticker of avTickers.slice(0, ALPHAVANTAGE_DAILY_LIMIT)) {
      avTried++;
      try {
        const series = await avWeekly(ticker);
        if (!series) { avFailed.add(ticker); continue; }
        let hit = false;
        for (const c of avByTicker.get(ticker)!) {
          const p = closeOnOrBefore(series, c.as_of);
          if (p) { record(c, p.close, p.date, "alphavantage"); newAv++; hit = true; }
        }
        if (!hit) avFailed.add(ticker);
      } catch (err) {
        if ((err as Error).message === "alpha-vantage-rate-limited") {
          console.log("  Alpha Vantage daily limit reached — stopping");
          break;
        }
        avFailed.add(ticker);
      }
    }
  } else if (avTickers.length) {
    console.log(`  ${avTickers.length} ticker(s) pending; set ALPHAVANTAGE_API_KEY to price them`);
  }

  writePriced(priced);
  writeAvFailed(avFailed);
  loadIntoTable(db, priced);

  const pending = avTickers.length - (ALPHAVANTAGE_KEY ? Math.min(avTickers.length, ALPHAVANTAGE_DAILY_LIMIT) : 0);
  return { priced: priced.size, newStooq, newAv, pending: Math.max(0, pending), avTried };
}

/** Load the committed market-cap records into the market_cap table. */
export function loadIntoTable(db: DB, priced?: Map<string, McRecord>): number {
  const records = priced ?? readPriced();
  const upsert = db.prepare(`
    INSERT INTO market_cap (adsh, cik, form, ticker, as_of, as_of_kind, shares, price, price_date, source, market_cap_usd)
    VALUES (@adsh, @cik, @form, @ticker, @as_of, @as_of_kind, @shares, @price, @price_date, @source, @market_cap)
    ON CONFLICT(adsh) DO UPDATE SET
      cik=excluded.cik, form=excluded.form, ticker=excluded.ticker, as_of=excluded.as_of,
      as_of_kind=excluded.as_of_kind, shares=excluded.shares, price=excluded.price,
      price_date=excluded.price_date, source=excluded.source, market_cap_usd=excluded.market_cap_usd
  `);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM market_cap");
    for (const r of records.values()) {
      upsert.run({
        adsh: r.adsh, cik: r.cik, form: r.form, ticker: r.ticker, as_of: r.as_of,
        as_of_kind: r.as_of_kind, shares: r.shares, price: r.price, price_date: r.price_date,
        source: r.source, market_cap: r.market_cap,
      });
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return records.size;
}
