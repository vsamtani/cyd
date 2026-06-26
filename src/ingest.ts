import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_DIR, EDGAR_ARCHIVES, FSN_BASE } from "./config.js";
import { transaction, type DB } from "./lib/db.js";

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

function filingUrl(cik: string, adsh: string): string {
  return `${EDGAR_ARCHIVES}/${Number(cik)}/${adsh.replace(/-/g, "")}/${adsh}-index.htm`;
}

export interface IngestResult {
  filings: number;
  facts: number;
  tags: number;
}

interface TagRec { tag: string; version: string; datatype: string; label: string; doc: string }
interface FilingRec {
  adsh: string; cik: string; name: string; sic: string; form: string; period: string;
  fy: string; fp: string; filed: string; accepted: string; countryinc: string;
  stprinc: string; countryba: string; stprba: string; ein: string; instance: string;
  pubfloatusd: string; src: string;
}
interface FactRec {
  adsh: string; tag: string; version: string; ddate: string; qtrs: string; dimh: string;
  iprx: string; coreg: string; lang: string; escaped: string; srclen: string;
  txtlen: string; value: string;
}

/** Read every day-file under data/source/YYYY/*.ndjson (skips cyd_tags). */
function readDayRecords(): { filings: FilingRec[]; facts: FactRec[] } {
  const filings: FilingRec[] = [];
  const facts: FactRec[] = [];
  for (const year of readdirSync(SOURCE_DIR).filter((d) => /^\d{4}$/.test(d)).sort()) {
    const dir = join(SOURCE_DIR, year);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort()) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line) continue;
        const rec = JSON.parse(line) as { t?: string };
        if (rec.t === "filing") filings.push(rec as FilingRec);
        else if (rec.t === "fact") facts.push(rec as FactRec);
      }
    }
  }
  return { filings, facts };
}

/** Ingest the committed per-day source files (data/source/**) into the DB. */
export function ingestAll(db: DB): IngestResult {
  const tagsPath = join(SOURCE_DIR, "cyd_tags.ndjson");
  if (!existsSync(tagsPath)) {
    console.log("No source files in data/source/. Run `npm run split` first.");
    return { filings: 0, facts: 0, tags: 0 };
  }

  // cyd taxonomy dictionary + datatype map (for flag detection)
  const tagRows = readFileSync(tagsPath, "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as TagRec);
  const datatypeByKey = new Map<string, string>();
  for (const t of tagRows) datatypeByKey.set(`${t.tag}\t${t.version}`, t.datatype ?? "");

  const { filings, facts } = readDayRecords();

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

  const inScope = new Set(filings.map((f) => f.adsh!));

  transaction(db, () => {
    for (const t of tagRows) {
      upsertTag.run({
        tag: t.tag, version: t.version,
        datatype: t.datatype || null, label: t.label || null, doc: t.doc || null,
      });
    }
    for (const m of filings) {
      upsertFiling.run({
        adsh: m.adsh,
        cik: intOrNull(m.cik ?? ""),
        company_name: m.name || null,
        sic: m.sic || null,
        form: m.form,
        is_amendment: m.form!.includes("/A") ? 1 : 0,
        period: m.period || null,
        fy: intOrNull(m.fy ?? ""),
        fp: m.fp || null,
        filed_date: m.filed || null,
        accepted: m.accepted || null,
        country_inc: m.countryinc || null,
        state_inc: m.stprinc || null,
        country_ba: m.countryba || null,
        state_ba: m.stprba || null,
        ein: m.ein || null,
        instance: m.instance || null,
        pubfloatusd: floatOrNull(m.pubfloatusd ?? ""),
        source_period: m.src,
        filing_url: filingUrl(m.cik ?? "", m.adsh!),
      });
    }
    for (const fact of facts) {
      if (!inScope.has(fact.adsh!)) continue;
      const datatype = datatypeByKey.get(`${fact.tag}\t${fact.version}`) ?? "";
      const isFlag = datatype.toLowerCase() === "boolean" ? 1 : 0;
      let flagValue: number | null = null;
      if (isFlag) {
        const v = (fact.value ?? "").trim().toLowerCase();
        flagValue = v === "true" ? 1 : v === "false" ? 0 : null;
      }
      upsertFact.run({
        adsh: fact.adsh, tag: fact.tag, version: fact.version,
        ddate: fact.ddate || null,
        qtrs: intOrNull(fact.qtrs ?? ""),
        dimh: fact.dimh || "",
        iprx: intOrNull(fact.iprx ?? "") ?? 0,
        coreg: fact.coreg || "",
        lang: fact.lang || null,
        escaped: fact.escaped === "1" ? 1 : fact.escaped === "0" ? 0 : null,
        srclen: intOrNull(fact.srclen ?? ""),
        txtlen: intOrNull(fact.txtlen ?? ""),
        value: fact.value ?? "",
        is_flag: isFlag,
        flag_value: flagValue,
      });
    }
  });

  // Rebuild the per-FSN-period bookkeeping (provenance) from the loaded data.
  rebuildIngestedPeriods(db);

  const factCount = (db.prepare("SELECT COUNT(*) n FROM cyd_facts").get() as { n: number }).n;
  return { filings: filings.length, facts: factCount, tags: tagRows.length };
}

function rebuildIngestedPeriods(db: DB): void {
  const filingsPer = db.prepare(
    "SELECT source_period AS p, COUNT(*) n FROM filings GROUP BY source_period",
  ).all() as { p: string; n: number }[];
  const factsPer = db.prepare(
    "SELECT f.source_period AS p, COUNT(*) n FROM cyd_facts c JOIN filings f ON f.adsh=c.adsh GROUP BY f.source_period",
  ).all() as { p: string; n: number }[];
  const factMap = new Map(factsPer.map((r) => [r.p, r.n]));
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO ingested_periods (period, url, zip_bytes, filings_count, facts_count, ingested_at)
    VALUES (@period, @url, NULL, @filings_count, @facts_count, @ingested_at)
    ON CONFLICT(period) DO UPDATE SET
      filings_count=excluded.filings_count, facts_count=excluded.facts_count,
      url=excluded.url, ingested_at=excluded.ingested_at
  `);
  transaction(db, () => {
    db.exec("DELETE FROM ingested_periods");
    for (const r of filingsPer) {
      upsert.run({
        period: r.p,
        url: `${FSN_BASE}/${r.p}_notes.zip`,
        filings_count: r.n,
        facts_count: factMap.get(r.p) ?? 0,
        ingested_at: now,
      });
    }
  });
}
