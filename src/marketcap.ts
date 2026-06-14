import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import yauzl from "yauzl";
import { RAW_DIR } from "./config.js";
import { download } from "./lib/http.js";
import { streamEntryLines } from "./lib/zip.js";
import { transaction, type DB } from "./lib/db.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKERS_CACHE = join(RAW_DIR, "company_tickers.json");
const STOOQ_ZIP = join(RAW_DIR, "d_us_txt.zip");

const DEI_SHARES = "EntityCommonStockSharesOutstanding";
const USGAAP_SHARES = "CommonStockSharesOutstanding";
const TRADING_SYMBOL = "TradingSymbol"; // dei, text fact in txt.tsv

// Sanity guards against filer XBRL scaling errors (real max ~25B shares / ~$5T).
const MAX_SHARES = 5e10;
const MAX_MCAP = 5e12;

interface PopRow { cik: number; adsh: string; period: string; source_period: string }

/** CIK -> all tickers listed in SEC's company_tickers.json (in file order). */
function loadTickerCandidates(): Map<number, string[]> {
  const raw = JSON.parse(readFileSync(TICKERS_CACHE, "utf8")) as Record<
    string,
    { cik_str: number; ticker: string }
  >;
  const map = new Map<number, string[]>();
  for (const { cik_str, ticker } of Object.values(raw)) {
    if (!ticker) continue;
    if (!map.has(cik_str)) map.set(cik_str, []);
    map.get(cik_str)!.push(ticker.toUpperCase());
  }
  return map;
}

async function ensureTickerCache(): Promise<void> {
  if (existsSync(TICKERS_CACHE)) return;
  process.stdout.write("  fetching SEC company_tickers.json ... ");
  await download(TICKERS_URL, TICKERS_CACHE);
  console.log("ok");
}

/** adsh -> trading symbols the company declares on its own cover (dei:TradingSymbol). */
async function loadTradingSymbols(pop: PopRow[]): Promise<Map<string, string[]>> {
  const byZip = groupAdshByZip(pop);
  const out = new Map<string, string[]>();
  for (const [sp, adshSet] of byZip) {
    const zip = join(RAW_DIR, `${sp}_notes.zip`);
    if (!existsSync(zip)) continue;
    let header = true;
    for await (const line of streamEntryLines(zip, "txt.tsv")) {
      if (header) { header = false; continue; }
      const f = line.split("\t"); // adsh,tag,...,value(last)
      if (f[1] !== TRADING_SYMBOL || !adshSet.has(f[0]!)) continue;
      const sym = (f[f.length - 1] ?? "").trim().toUpperCase();
      if (!sym || /[^A-Z0-9.-]/.test(sym)) continue;
      const list = out.get(f[0]!) ?? [];
      if (!list.includes(sym)) list.push(sym);
      out.set(f[0]!, list);
    }
  }
  return out;
}

/**
 * adsh -> total common shares outstanding. Prefers the dei cover tag; falls
 * back to the us-gaap balance-sheet tag (some filers only report the latter).
 * Uses the latest "as of" date and sums share classes if no single total.
 */
async function loadShares(pop: PopRow[]): Promise<Map<string, number>> {
  const byZip = groupAdshByZip(pop);
  type Cell = { def: number | null; sum: number };
  type Acc = { dei: Map<string, Cell>; usg: Map<string, Cell> };
  const acc = new Map<string, Acc>();
  const add = (a: Acc, which: "dei" | "usg", ddate: string, dimh: string, v: number) => {
    const m = a[which];
    const cell = m.get(ddate) ?? { def: null, sum: 0 };
    if (dimh === "") cell.def = (cell.def ?? 0) + v;
    else cell.sum += v;
    m.set(ddate, cell);
  };
  for (const [sp, adshSet] of byZip) {
    const zip = join(RAW_DIR, `${sp}_notes.zip`);
    if (!existsSync(zip)) continue;
    let header = true;
    for await (const line of streamEntryLines(zip, "num.tsv")) {
      if (header) { header = false; continue; }
      const f = line.split("\t"); // adsh,tag,version,ddate,qtrs,uom,dimh,iprx,value
      const which = f[1] === DEI_SHARES ? "dei" : f[1] === USGAAP_SHARES ? "usg" : null;
      if (!which || !adshSet.has(f[0]!)) continue;
      const v = parseFloat(f[8]!);
      if (!Number.isFinite(v)) continue;
      if (!acc.has(f[0]!)) acc.set(f[0]!, { dei: new Map(), usg: new Map() });
      add(acc.get(f[0]!)!, which, f[3]!, f[6] ?? "", v);
    }
  }
  const resolve = (m: Map<string, Cell>): number | null => {
    if (m.size === 0) return null;
    const latest = [...m.keys()].sort().at(-1)!;
    const cell = m.get(latest)!;
    return cell.def ?? cell.sum;
  };
  const shares = new Map<string, number>();
  for (const [adsh, a] of acc) {
    const v = resolve(a.dei) ?? resolve(a.usg);
    if (v && v > 0) shares.set(adsh, v);
  }
  return shares;
}

function groupAdshByZip(pop: PopRow[]): Map<string, Set<string>> {
  const byZip = new Map<string, Set<string>>();
  for (const r of pop) {
    if (!byZip.has(r.source_period)) byZip.set(r.source_period, new Set());
    byZip.get(r.source_period)!.add(r.adsh);
  }
  return byZip;
}

/** The set of tickers Stooq actually has data for (from the zip's file list). */
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

/** For each needed ticker, the Stooq close on or before its year-end date. */
function loadPrices(
  needed: Map<string, string>,
): Promise<Map<string, { date: string; close: number }>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, { date: string; close: number }>();
    yauzl.open(STOOQ_ZIP, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("open failed"));
      zip.on("entry", (entry: yauzl.Entry) => {
        const m = /([^/]+)\.us\.txt$/i.exec(entry.fileName);
        const tic = m ? m[1]!.toUpperCase() : null;
        if (!tic || !needed.has(tic)) return zip.readEntry();
        const yearend = needed.get(tic)!;
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry();
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          let best: { date: string; close: number } | null = null;
          let first = true;
          rl.on("line", (line) => {
            if (first) { first = false; return; }
            const p = line.split(",");
            if (p.length < 8) return;
            if (p[2]! <= yearend) best = { date: p[2]!, close: parseFloat(p[7]!) };
            else { rl.close(); stream.destroy(); } // ascending dates; stop early
          });
          rl.on("close", () => {
            if (best) out.set(tic, best);
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

export interface MarketCapResult {
  population: number;
  priced: number;
  droppedOutliers: number;
}

export async function computeMarketCaps(db: DB): Promise<MarketCapResult> {
  if (!existsSync(STOOQ_ZIP)) throw new Error(`Stooq data not found at ${STOOQ_ZIP}`);
  await ensureTickerCache();

  // US-domestic annual filers only (foreign 20-F can't be sized via ADR prices).
  const pop = db
    .prepare(`
      WITH annual AS (
        SELECT cik, adsh, period, source_period,
          ROW_NUMBER() OVER (PARTITION BY cik ORDER BY period DESC, filed_date DESC, adsh DESC) rn
        FROM filings
        WHERE form IN ('10-K','10-K/A','10-KT','10-KT/A') AND period <> ''
      )
      SELECT cik, adsh, period, source_period FROM annual WHERE rn = 1
    `)
    .all() as unknown as PopRow[];

  const candidates = loadTickerCandidates();
  const symbols = await loadTradingSymbols(pop);
  const shares = await loadShares(pop);
  const universe = await loadStooqUniverse();
  console.log(`  ${pop.length} US-domestic companies; ${shares.size} with shares`);

  // Choose, per company, the first candidate ticker that Stooq actually has.
  // Prefer the company's own declared symbol(s), then SEC's ticker file.
  const needed = new Map<string, string>(); // ticker -> yearend
  const chosen = new Map<string, string>(); // adsh -> ticker
  let noTicker = 0;
  for (const r of pop) {
    if (!shares.has(r.adsh)) continue;
    const cands = [...(symbols.get(r.adsh) ?? []), ...(candidates.get(r.cik) ?? [])];
    const ticker = cands.find((t) => universe.has(t));
    if (!ticker) { noTicker++; continue; }
    needed.set(ticker, r.period);
    chosen.set(r.adsh, ticker);
  }

  const prices = await loadPrices(needed);
  console.log(`  ${prices.size} of ${needed.size} chosen tickers priced (${noTicker} unmatched)`);

  const upsert = db.prepare(`
    INSERT INTO market_cap (cik, adsh, ticker, yearend, shares, price, price_date, market_cap_usd)
    VALUES (@cik, @adsh, @ticker, @yearend, @shares, @price, @price_date, @mc)
    ON CONFLICT(cik) DO UPDATE SET
      adsh=excluded.adsh, ticker=excluded.ticker, yearend=excluded.yearend,
      shares=excluded.shares, price=excluded.price, price_date=excluded.price_date,
      market_cap_usd=excluded.market_cap_usd
  `);

  let priced = 0, dropped = 0;
  transaction(db, () => {
    db.exec("DELETE FROM market_cap");
    for (const r of pop) {
      const ticker = chosen.get(r.adsh);
      if (!ticker) continue;
      const p = prices.get(ticker);
      const sh = shares.get(r.adsh)!;
      if (!p) continue;
      const mc = sh * p.close;
      if (sh > MAX_SHARES || mc > MAX_MCAP) { dropped++; continue; } // scaling error
      upsert.run({
        cik: r.cik, adsh: r.adsh, ticker, yearend: r.period,
        shares: sh, price: p.close, price_date: p.date, mc,
      });
      priced++;
    }
  });
  return { population: pop.length, priced, droppedOutliers: dropped };
}
