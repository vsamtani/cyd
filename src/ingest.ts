import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR, ALLOWED_FORMS, EDGAR_ARCHIVES } from "./config.js";
import { streamEntryLines } from "./lib/zip.js";
import { transaction, type DB } from "./lib/db.js";

// ---- TSV helpers -----------------------------------------------------------

/**
 * Split a TSV line into exactly `count` fields. The final field absorbs any
 * remaining tabs, so text values containing tabs (the last column) stay intact.
 */
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
  const get = (fields: string[], name: string): string => {
    const i = pos.get(name);
    return i === undefined ? "" : fields[i] ?? "";
  };
  return { count: cols.length, get };
}

const intOrNull = (s: string): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};
const floatOrNull = (s: string): number | null => {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
};

// ---- Row shapes ------------------------------------------------------------

interface CydFactRow {
  adsh: string;
  tag: string;
  version: string;
  ddate: string;
  qtrs: number | null;
  dimh: string;
  iprx: number;
  coreg: string;
  lang: string;
  escaped: number | null;
  srclen: number | null;
  txtlen: number | null;
  value: string;
}

// ---- Per-zip ingest --------------------------------------------------------

export interface IngestResult {
  period: string;
  url: string;
  zipBytes: number;
  filings: number;
  facts: number;
}

function filingUrl(cik: string, adsh: string): string {
  const noDash = adsh.replace(/-/g, "");
  return `${EDGAR_ARCHIVES}/${Number(cik)}/${noDash}/${adsh}-index.htm`;
}

export async function ingestZip(
  db: DB,
  period: string,
  zipPath: string,
): Promise<IngestResult> {
  // 1. tag.tsv -> cyd taxonomy dictionary + datatype map (for flag detection)
  const datatypeByKey = new Map<string, string>(); // `${tag}\t${version}` -> datatype
  const tagRows: {
    tag: string;
    version: string;
    datatype: string;
    label: string;
    doc: string;
  }[] = [];
  {
    let header: ReturnType<typeof makeIndexer> | null = null;
    for await (const line of streamEntryLines(zipPath, "tag.tsv")) {
      if (!header) {
        header = makeIndexer(line);
        continue;
      }
      const f = splitTsv(line, header.count);
      const version = header.get(f, "version");
      if (!version.startsWith("cyd/")) continue;
      const tag = header.get(f, "tag");
      const datatype = header.get(f, "datatype");
      datatypeByKey.set(`${tag}\t${version}`, datatype);
      tagRows.push({
        tag,
        version,
        datatype,
        label: header.get(f, "tlabel"),
        doc: header.get(f, "doc"),
      });
    }
  }

  // 2. txt.tsv -> buffer cyd facts and collect their accession numbers
  const facts: CydFactRow[] = [];
  const adshNeeded = new Set<string>();
  {
    let header: ReturnType<typeof makeIndexer> | null = null;
    for await (const line of streamEntryLines(zipPath, "txt.tsv")) {
      if (!header) {
        header = makeIndexer(line);
        continue;
      }
      const f = splitTsv(line, header.count);
      const version = header.get(f, "version");
      if (!version.startsWith("cyd/")) continue;
      const adsh = header.get(f, "adsh");
      adshNeeded.add(adsh);
      facts.push({
        adsh,
        tag: header.get(f, "tag"),
        version,
        ddate: header.get(f, "ddate"),
        qtrs: intOrNull(header.get(f, "qtrs")),
        dimh: header.get(f, "dimh"),
        iprx: intOrNull(header.get(f, "iprx")) ?? 0,
        coreg: header.get(f, "coreg"),
        lang: header.get(f, "lang"),
        escaped:
          header.get(f, "escaped") === "1"
            ? 1
            : header.get(f, "escaped") === "0"
              ? 0
              : null,
        srclen: intOrNull(header.get(f, "srclen")),
        txtlen: intOrNull(header.get(f, "txtlen")),
        value: header.get(f, "value"),
      });
    }
  }

  // 3. sub.tsv -> metadata for the needed filings, restricted to allowed forms
  interface FilingMeta {
    cik: string;
    name: string;
    sic: string;
    form: string;
    period: string;
    fy: string;
    fp: string;
    filed: string;
    accepted: string;
    countryinc: string;
    stprinc: string;
    countryba: string;
    stprba: string;
    ein: string;
    instance: string;
    pubfloatusd: string;
  }
  const filings = new Map<string, FilingMeta>();
  {
    let header: ReturnType<typeof makeIndexer> | null = null;
    for await (const line of streamEntryLines(zipPath, "sub.tsv")) {
      if (!header) {
        header = makeIndexer(line);
        continue;
      }
      const f = splitTsv(line, header.count);
      const adsh = header.get(f, "adsh");
      if (!adshNeeded.has(adsh)) continue;
      const form = header.get(f, "form");
      if (!ALLOWED_FORMS.has(form)) continue;
      filings.set(adsh, {
        cik: header.get(f, "cik"),
        name: header.get(f, "name"),
        sic: header.get(f, "sic"),
        form,
        period: header.get(f, "period"),
        fy: header.get(f, "fy"),
        fp: header.get(f, "fp"),
        filed: header.get(f, "filed"),
        accepted: header.get(f, "accepted"),
        countryinc: header.get(f, "countryinc"),
        stprinc: header.get(f, "stprinc"),
        countryba: header.get(f, "countryba"),
        stprba: header.get(f, "stprba"),
        ein: header.get(f, "ein"),
        instance: header.get(f, "instance"),
        pubfloatusd: header.get(f, "pubfloatusd"),
      });
    }
  }

  // 4. Upsert everything in a single transaction.
  const upsertTag = db.prepare(`
    INSERT INTO cyd_tags (tag, version, datatype, label, doc)
    VALUES (@tag, @version, @datatype, @label, @doc)
    ON CONFLICT(tag, version) DO UPDATE SET
      datatype = excluded.datatype, label = excluded.label, doc = excluded.doc
  `);
  const upsertFiling = db.prepare(`
    INSERT INTO filings (
      adsh, cik, company_name, sic, form, is_amendment, period, fy, fp,
      filed_date, accepted, country_inc, state_inc, country_ba, state_ba,
      ein, instance, pubfloatusd, source_period, filing_url
    ) VALUES (
      @adsh, @cik, @company_name, @sic, @form, @is_amendment, @period, @fy, @fp,
      @filed_date, @accepted, @country_inc, @state_inc, @country_ba, @state_ba,
      @ein, @instance, @pubfloatusd, @source_period, @filing_url
    )
    ON CONFLICT(adsh) DO UPDATE SET
      cik=excluded.cik, company_name=excluded.company_name, sic=excluded.sic,
      form=excluded.form, is_amendment=excluded.is_amendment, period=excluded.period,
      fy=excluded.fy, fp=excluded.fp, filed_date=excluded.filed_date,
      accepted=excluded.accepted, country_inc=excluded.country_inc,
      state_inc=excluded.state_inc, country_ba=excluded.country_ba,
      state_ba=excluded.state_ba, ein=excluded.ein, instance=excluded.instance,
      pubfloatusd=excluded.pubfloatusd, source_period=excluded.source_period,
      filing_url=excluded.filing_url
  `);
  const upsertFact = db.prepare(`
    INSERT INTO cyd_facts (
      adsh, tag, version, ddate, qtrs, dimh, iprx, coreg, lang, escaped,
      srclen, txtlen, value, is_flag, flag_value
    ) VALUES (
      @adsh, @tag, @version, @ddate, @qtrs, @dimh, @iprx, @coreg, @lang, @escaped,
      @srclen, @txtlen, @value, @is_flag, @flag_value
    )
    ON CONFLICT(adsh, tag, version, ddate, qtrs, dimh, iprx, coreg) DO UPDATE SET
      lang=excluded.lang, escaped=excluded.escaped, srclen=excluded.srclen,
      txtlen=excluded.txtlen, value=excluded.value, is_flag=excluded.is_flag,
      flag_value=excluded.flag_value
  `);

  const factCount = transaction(db, () => {
    for (const t of tagRows) upsertTag.run(t);

    for (const [adsh, m] of filings) {
      upsertFiling.run({
        adsh,
        cik: intOrNull(m.cik),
        company_name: m.name || null,
        sic: m.sic || null,
        form: m.form,
        is_amendment: m.form.includes("/A") ? 1 : 0,
        period: m.period || null,
        fy: intOrNull(m.fy),
        fp: m.fp || null,
        filed_date: m.filed || null,
        accepted: m.accepted || null,
        country_inc: m.countryinc || null,
        state_inc: m.stprinc || null,
        country_ba: m.countryba || null,
        state_ba: m.stprba || null,
        ein: m.ein || null,
        instance: m.instance || null,
        pubfloatusd: floatOrNull(m.pubfloatusd),
        source_period: period,
        filing_url: filingUrl(m.cik, adsh),
      });
    }

    let factCount = 0;
    for (const fact of facts) {
      if (!filings.has(fact.adsh)) continue; // form not in scope
      const datatype = datatypeByKey.get(`${fact.tag}\t${fact.version}`) ?? "";
      const isFlag = datatype.toLowerCase() === "boolean" ? 1 : 0;
      let flagValue: number | null = null;
      if (isFlag) {
        const v = fact.value.trim().toLowerCase();
        flagValue = v === "true" ? 1 : v === "false" ? 0 : null;
      }
      upsertFact.run({
        adsh: fact.adsh,
        tag: fact.tag,
        version: fact.version,
        ddate: fact.ddate || null,
        qtrs: fact.qtrs,
        dimh: fact.dimh || "",
        iprx: fact.iprx,
        coreg: fact.coreg || "",
        lang: fact.lang || null,
        escaped: fact.escaped,
        srclen: fact.srclen,
        txtlen: fact.txtlen,
        value: fact.value,
        is_flag: isFlag,
        flag_value: flagValue,
      });
      factCount++;
    }
    return factCount;
  });

  const zipBytes = statSync(zipPath).size;
  const url = `https://www.sec.gov/files/dera/data/financial-statement-notes-data-sets/${period}_notes.zip`;
  db.prepare(`
    INSERT INTO ingested_periods (period, url, zip_bytes, filings_count, facts_count, ingested_at)
    VALUES (@period, @url, @zip_bytes, @filings_count, @facts_count, @ingested_at)
    ON CONFLICT(period) DO UPDATE SET
      url=excluded.url, zip_bytes=excluded.zip_bytes,
      filings_count=excluded.filings_count, facts_count=excluded.facts_count,
      ingested_at=excluded.ingested_at
  `).run({
    period,
    url,
    zip_bytes: zipBytes,
    filings_count: filings.size,
    facts_count: factCount,
    ingested_at: new Date().toISOString(),
  });

  return { period, url, zipBytes, filings: filings.size, facts: factCount };
}

/** Ingest every *_notes.zip present in data/raw/. */
export async function ingestAll(db: DB): Promise<IngestResult[]> {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith("_notes.zip"))
    .sort();
  if (files.length === 0) {
    console.log("No FSN zips found in data/raw/. Run `npm run fetch` first.");
    return [];
  }
  const results: IngestResult[] = [];
  for (const file of files) {
    const period = file.replace(/_notes\.zip$/, "");
    process.stdout.write(`  ingest ${period} ... `);
    const res = await ingestZip(db, period, join(RAW_DIR, file));
    console.log(`${res.filings} filings, ${res.facts} facts`);
    results.push(res);
  }
  return results;
}
