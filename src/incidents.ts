import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDGAR_ARCHIVES, DATA_DIR } from "./config.js";
import { download } from "./lib/http.js";
import { EXPORT_DIR } from "./export.js";
import type { DB } from "./lib/db.js";

/** Cached full-submission .txt files (re-fetchable; gitignored). */
const CACHE_DIR = join(DATA_DIR, "incidents_raw");
/** Committed output: raw + sanitised primary-document HTML per incident. */
const OUT_DIR = join(EXPORT_DIR, "incidents");

interface IncidentFiling {
  adsh: string;
  cik: number;
  form: string;
}

/** Full-submission text file, e.g. .../data/{cik}/{adshNoDash}/{adsh}.txt */
function submissionUrl(cik: number, adsh: string): string {
  return `${EDGAR_ARCHIVES}/${cik}/${adsh.replace(/-/g, "")}/${adsh}.txt`;
}

/**
 * Extract the primary document's markup from the SGML full-submission file.
 * Prefers the <DOCUMENT> whose <TYPE> matches the form; falls back to the
 * first document (which is always SEQUENCE 1, the primary).
 */
function extractPrimaryDoc(submission: string, form: string): string | null {
  const docs = submission.match(/<DOCUMENT>[\s\S]*?<\/DOCUMENT>/gi) ?? [];
  const want = form.toUpperCase();
  let chosen =
    docs.find(
      (d) => (d.match(/<TYPE>([^\r\n<]+)/i)?.[1] ?? "").trim().toUpperCase() === want,
    ) ?? docs[0];
  if (!chosen) return null;
  const text = chosen.match(/<TEXT>([\s\S]*?)<\/TEXT>/i)?.[1];
  return text ? text.trim() : null;
}

// Structural tags kept by the sanitiser; everything else is unwrapped/dropped.
const ALLOWED = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "td", "th", "caption",
  "strong", "em", "b", "i", "u", "span", "div", "a", "hr", "sup", "sub",
]);

/** Reduce inline-XBRL filing HTML to safe, structural HTML for inline display. */
export function sanitise(html: string): string {
  let s = html;
  s = s.replace(/<\?[\s\S]*?\?>/g, "");            // XML declarations
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "");          // doctype
  s = s.replace(/<!--[\s\S]*?-->/g, "");           // comments
  // Drop whole noisy/unsafe sections, contents included.
  s = s.replace(
    /<(script|style|head|ix:header|ix:hidden|ix:references|ix:resources)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  // Walk remaining tags: whitelist structural tags, unwrap the rest.
  s = s.replace(
    /<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_m, slash: string, name: string, attrs: string) => {
      const tag = name.toLowerCase();
      if (tag.includes(":")) return "";        // ix:/xbrli:/link: — unwrap, keep text
      if (!ALLOWED.has(tag)) return "";        // unknown tag — unwrap, keep text
      if (slash) return `</${tag}>`;
      let keep = "";
      if (tag === "a") {
        const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
        const url = m ? (m[2] ?? m[3] ?? "") : "";
        if (/^(https?:|mailto:)/i.test(url))
          keep = ` href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener"`;
      } else if (tag === "td" || tag === "th") {
        const cs = attrs.match(/\bcolspan\s*=\s*"?(\d+)"?/i);
        const rs = attrs.match(/\browspan\s*=\s*"?(\d+)"?/i);
        if (cs) keep += ` colspan="${cs[1]}"`;
        if (rs) keep += ` rowspan="${rs[1]}"`;
      }
      return `<${tag}${keep}>`;
    },
  );
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * For every incident filing, fetch (and cache) its full submission, then write
 * both the raw primary-document HTML and a sanitised version to data/export.
 * Network fetch is cached (filings are immutable); parsing/sanitising always
 * re-runs so the sanitiser can be iterated without re-downloading.
 */
export async function processIncidents(db: DB): Promise<number> {
  const rows = db
    .prepare(`
      SELECT DISTINCT f.adsh AS adsh, f.cik AS cik, f.form AS form
      FROM filings f JOIN cyd_facts c ON c.adsh = f.adsh
      WHERE f.form IN ('8-K','8-K/A','6-K','6-K/A')
        AND c.tag LIKE 'MaterialCybersecurityIncident%'
      ORDER BY f.filed_date DESC
    `)
    .all() as unknown as IncidentFiling[];

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0;
  for (const r of rows) {
    const cached = join(CACHE_DIR, `${r.adsh}.txt`);
    try {
      if (!existsSync(cached)) {
        process.stdout.write(`  fetch ${r.adsh} (${r.form}) ... `);
        await download(submissionUrl(r.cik, r.adsh), cached);
        console.log("ok");
      }
      const doc = extractPrimaryDoc(readFileSync(cached, "utf8"), r.form);
      if (!doc) {
        console.log(`  WARN: no primary document in ${r.adsh}`);
        continue;
      }
      writeFileSync(join(OUT_DIR, `${r.adsh}.raw.html`), doc);
      writeFileSync(join(OUT_DIR, `${r.adsh}.clean.html`), sanitise(doc));
      ok++;
    } catch (err) {
      console.log(`  WARN: failed ${r.adsh}: ${(err as Error).message}`);
    }
  }
  return ok;
}
