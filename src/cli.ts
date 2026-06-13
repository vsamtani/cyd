import { Command } from "commander";
import { openDb } from "./lib/db.js";
import { fetchAll } from "./fetchFsn.js";
import { ingestAll } from "./ingest.js";
import { exportAll, EXPORT_DIR } from "./export.js";
import { processIncidents } from "./incidents.js";
import { computeMarketCaps } from "./marketcap.js";
import { buildSite } from "./buildSite.js";

const program = new Command();
program
  .name("cyd")
  .description("Download & ingest SEC cybersecurity (cyd:) iXBRL disclosures");

program
  .command("fetch")
  .description("Download all available FSN dataset zips into data/raw/")
  .action(async () => {
    await fetchAll();
  });

program
  .command("ingest")
  .description("Parse data/raw/*_notes.zip into data/cyd.db")
  .action(async () => {
    const db = openDb();
    try {
      await ingestAll(db);
    } finally {
      db.close();
    }
  });

program
  .command("export")
  .description("Write text exports (CSV + summary.json) to data/export/")
  .action(async () => {
    const db = openDb();
    try {
      const r = await exportAll(db);
      console.log(
        `Exported to ${EXPORT_DIR}: ${r.filings} filings, ${r.facts} facts (${r.textFacts} text blocks), ${r.tags} tags + summary.json`,
      );
    } finally {
      db.close();
    }
  });

program
  .command("incidents")
  .description("Fetch incident filings' full text and write raw + sanitised HTML")
  .action(async () => {
    const db = openDb();
    try {
      const n = await processIncidents(db);
      console.log(`Processed ${n} incident filing(s) -> ${EXPORT_DIR}/incidents`);
    } finally {
      db.close();
    }
  });

program
  .command("marketcap")
  .description("Estimate each company's market cap (shares x Stooq year-end price)")
  .action(async () => {
    const db = openDb();
    try {
      const r = await computeMarketCaps(db);
      console.log(
        `Priced ${r.priced} of ${r.population} US-domestic companies` +
          ` (${r.droppedOutliers} dropped as scaling outliers)`,
      );
    } finally {
      db.close();
    }
  });

program
  .command("site")
  .description("Assemble the deployable static dashboard into dist/")
  .action(() => {
    const dir = buildSite();
    console.log(`Built static site -> ${dir}`);
  });

program
  .command("pipeline")
  .description("Fetch, ingest, then export")
  .action(async () => {
    await fetchAll();
    const db = openDb();
    try {
      await ingestAll(db);
      const r = await exportAll(db);
      console.log(
        `Exported ${r.filings} filings, ${r.facts} facts (${r.textFacts} text blocks) to ${EXPORT_DIR}`,
      );
      const n = await processIncidents(db);
      console.log(`Processed ${n} incident filing(s)`);
    } finally {
      db.close();
    }
    printStatus();
  });

program
  .command("status")
  .description("Print a summary of the ingested data")
  .action(() => {
    printStatus();
  });

function printStatus(): void {
  const db = openDb();
  try {
    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM filings)   AS filings,
           (SELECT COUNT(*) FROM cyd_facts) AS facts,
           (SELECT COUNT(*) FROM cyd_tags)  AS tags`,
      )
      .get() as { filings: number; facts: number; tags: number };

    console.log("\n=== CYD database summary ===");
    console.log(
      `filings: ${totals.filings}   facts: ${totals.facts}   distinct tag/versions: ${totals.tags}`,
    );

    const periods = db
      .prepare(
        `SELECT period, filings_count, facts_count FROM ingested_periods ORDER BY period`,
      )
      .all() as { period: string; filings_count: number; facts_count: number }[];
    if (periods.length) {
      console.log("\nby period:");
      for (const p of periods)
        console.log(
          `  ${p.period.padEnd(8)} ${String(p.filings_count).padStart(5)} filings  ${String(p.facts_count).padStart(6)} facts`,
        );
    }

    const byForm = db
      .prepare(
        `SELECT form, COUNT(*) n FROM filings GROUP BY form ORDER BY n DESC`,
      )
      .all() as { form: string; n: number }[];
    if (byForm.length) {
      console.log("\nfilings by form:");
      for (const r of byForm)
        console.log(`  ${r.form.padEnd(8)} ${r.n}`);
    }

    const byFy = db
      .prepare(
        `SELECT fy, COUNT(*) n FROM filings WHERE fy IS NOT NULL GROUP BY fy ORDER BY fy`,
      )
      .all() as { fy: number; n: number }[];
    if (byFy.length) {
      console.log("\nfilings by fiscal year:");
      for (const r of byFy) console.log(`  ${r.fy}  ${r.n}`);
    }

    const topTags = db
      .prepare(
        `SELECT tag, COUNT(*) n FROM cyd_facts GROUP BY tag ORDER BY n DESC LIMIT 10`,
      )
      .all() as { tag: string; n: number }[];
    if (topTags.length) {
      console.log("\ntop 10 cyd tags by fact count:");
      for (const r of topTags)
        console.log(`  ${String(r.n).padStart(5)}  ${r.tag}`);
    }
    console.log("");
  } finally {
    db.close();
  }
}

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
