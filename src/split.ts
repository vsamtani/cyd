import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR, SOURCE_DIR, ALLOWED_FORMS } from "./config.js";
import { streamEntryLines } from "./lib/zip.js";

// ---- TSV helpers -----------------------------------------------------------

/** Split a TSV line into exactly `count` fields; the last field absorbs any
 *  remaining tabs, so text values (the final column) stay intact. */
function splitTsv(line: string, count: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const idx = line.indexOf("\t", start);
    if (idx === -1) {
      out.push(line.slice(start));
      while (out.length < count) out.push("");
      return out;
    }
    out.push(line.slice(start, idx));
    start = idx + 1;
  }
  out.push(line.slice(start));
  return out;
}

function makeIndexer(headerLine: string) {
  const cols = headerLine.split("\t");
  const pos = new Map<string, number>();
  cols.forEach((c, i) => pos.set(c, i));
  return {
    count: cols.length,
    get: (f: string[], name: string): string => {
      const i = pos.get(name);
      return i === undefined ? "" : f[i] ?? "";
    },
  };
}

// ---- Record shapes (source fields kept verbatim as strings) ----------------

type Rec = Record<string, string>;
const FACT_KEY = (r: Rec) =>
  [r.adsh, r.tag, r.version, r.ddate, r.qtrs, r.dimh, r.iprx, r.coreg].join("\t");

interface DayBucket {
  filings: Map<string, Rec>; // adsh -> filing record
  facts: Rec[];
}

/**
 * Filter the cached FSN zips down to in-scope filings (allowed forms with ≥1
 * cyd fact) and write them as per-filing-day NDJSON under data/source/.
 * Each day-file is a deterministic, sorted dump → re-running yields identical
 * bytes, so git only sees genuinely new/changed days (append-only in effect).
 */
export async function splitAll(): Promise<{ days: number; filings: number; facts: number; tags: number }> {
  const zips = readdirSync(RAW_DIR).filter((f) => f.endsWith("_notes.zip")).sort();
  if (zips.length === 0) {
    console.log("No FSN zips in data/raw/. Run `npm run fetch` first.");
    return { days: 0, filings: 0, facts: 0, tags: 0 };
  }

  const tagMap = new Map<string, Rec>(); // `${tag}\t${version}` -> tag record
  const byDay = new Map<string, DayBucket>(); // YYYY-MM-DD -> bucket

  for (const zipFile of zips) {
    const period = zipFile.replace(/_notes\.zip$/, "");
    const zipPath = join(RAW_DIR, zipFile);
    process.stdout.write(`  split ${period} ... `);

    // tag.tsv -> cyd taxonomy dictionary
    {
      let h: ReturnType<typeof makeIndexer> | null = null;
      for await (const line of streamEntryLines(zipPath, "tag.tsv")) {
        if (!h) { h = makeIndexer(line); continue; }
        const f = splitTsv(line, h.count);
        const version = h.get(f, "version");
        if (!version.startsWith("cyd/")) continue;
        const tag = h.get(f, "tag");
        tagMap.set(`${tag}\t${version}`, {
          tag, version, datatype: h.get(f, "datatype"),
          label: h.get(f, "tlabel"), doc: h.get(f, "doc"),
        });
      }
    }

    // txt.tsv -> cyd facts, grouped by accession
    const factsByAdsh = new Map<string, Rec[]>();
    {
      let h: ReturnType<typeof makeIndexer> | null = null;
      for await (const line of streamEntryLines(zipPath, "txt.tsv")) {
        if (!h) { h = makeIndexer(line); continue; }
        const f = splitTsv(line, h.count);
        const version = h.get(f, "version");
        if (!version.startsWith("cyd/")) continue;
        const adsh = h.get(f, "adsh");
        const rec: Rec = {
          t: "fact", adsh, tag: h.get(f, "tag"), version,
          ddate: h.get(f, "ddate"), qtrs: h.get(f, "qtrs"), dimh: h.get(f, "dimh"),
          iprx: h.get(f, "iprx"), coreg: h.get(f, "coreg"), lang: h.get(f, "lang"),
          escaped: h.get(f, "escaped"), srclen: h.get(f, "srclen"),
          txtlen: h.get(f, "txtlen"), value: h.get(f, "value"),
        };
        (factsByAdsh.get(adsh) ?? factsByAdsh.set(adsh, []).get(adsh)!).push(rec);
      }
    }

    // sub.tsv -> in-scope filing metadata; route filing + its facts to its filed-day
    {
      let h: ReturnType<typeof makeIndexer> | null = null;
      for await (const line of streamEntryLines(zipPath, "sub.tsv")) {
        if (!h) { h = makeIndexer(line); continue; }
        const f = splitTsv(line, h.count);
        const adsh = h.get(f, "adsh");
        if (!factsByAdsh.has(adsh)) continue;
        const form = h.get(f, "form");
        if (!ALLOWED_FORMS.has(form)) continue;
        const filed = h.get(f, "filed");
        if (filed.length !== 8) continue;
        const day = `${filed.slice(0, 4)}-${filed.slice(4, 6)}-${filed.slice(6, 8)}`;
        const filing: Rec = {
          t: "filing", adsh, cik: h.get(f, "cik"), name: h.get(f, "name"),
          sic: h.get(f, "sic"), form, period: h.get(f, "period"), fy: h.get(f, "fy"),
          fp: h.get(f, "fp"), filed, accepted: h.get(f, "accepted"),
          countryinc: h.get(f, "countryinc"), stprinc: h.get(f, "stprinc"),
          countryba: h.get(f, "countryba"), stprba: h.get(f, "stprba"),
          ein: h.get(f, "ein"), instance: h.get(f, "instance"),
          pubfloatusd: h.get(f, "pubfloatusd"), src: period,
        };
        const bucket = byDay.get(day) ?? byDay.set(day, { filings: new Map(), facts: [] }).get(day)!;
        bucket.filings.set(adsh, filing);
        for (const fr of factsByAdsh.get(adsh)!) bucket.facts.push(fr);
      }
    }
    console.log("ok");
  }

  // Write per-day files, deterministically sorted.
  mkdirSync(SOURCE_DIR, { recursive: true });
  let filings = 0, facts = 0;
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const bucket = byDay.get(day)!;
    const year = day.slice(0, 4);
    mkdirSync(join(SOURCE_DIR, year), { recursive: true });
    const fil = [...bucket.filings.values()].sort((a, b) => a.adsh!.localeCompare(b.adsh!));
    const fac = bucket.facts.sort((a, b) => FACT_KEY(a).localeCompare(FACT_KEY(b)));
    const lines = [...fil, ...fac].map((r) => JSON.stringify(r));
    writeFileSync(join(SOURCE_DIR, year, `${day}.ndjson`), lines.join("\n") + "\n");
    filings += fil.length;
    facts += fac.length;
  }

  // Shared cyd taxonomy dictionary.
  const tags = [...tagMap.values()].sort(
    (a, b) => a.tag!.localeCompare(b.tag!) || a.version!.localeCompare(b.version!),
  );
  writeFileSync(
    join(SOURCE_DIR, "cyd_tags.ndjson"),
    tags.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  return { days: days.length, filings, facts, tags: tags.length };
}
