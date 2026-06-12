"use strict";

// ---- small helpers ---------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
const pct = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "%");
const num = (n) => Number(n).toLocaleString("en-GB");

function ymd(s) {
  if (!s || s.length !== 8) return s || "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+s.slice(6, 8)} ${months[+s.slice(4, 6) - 1]} ${s.slice(0, 4)}`;
}
function niceMax(maxRate) {
  const step = 0.05;
  return Math.max(step, Math.ceil((maxRate + 1e-9) / step) * step);
}

// ---- horizontal bar chart (inline SVG) -------------------------------------
// items: [{ label, rate, n, partial?, sublabel? }]
function hBars(items, opts = {}) {
  const W = 720, labelW = opts.labelW ?? 210, padR = 64, rowH = 44, top = 6, axisH = 26;
  const trackW = W - labelW - padR;
  const H = top + items.length * rowH + axisH;
  const domainMax = opts.domainMax ?? niceMax(Math.max(...items.map((d) => d.rate || 0)));
  const fillStyle = opts.fill ? ` style="fill:${opts.fill}"` : "";

  const rows = items.map((d, i) => {
    const y = top + i * rowH;
    const cy = y + rowH / 2;
    const w = Math.max(0, (d.rate || 0) / domainMax * trackW);
    const sub = d.sublabel
      ? `<text class="bar-n" x="0" y="${cy + 15}">${esc(d.sublabel)}</text>`
      : d.n != null
        ? `<text class="bar-n" x="0" y="${cy + 15}">n = ${num(d.n)}</text>`
        : "";
    return `
      <text class="bar-label" x="0" y="${cy - 2}">${esc(d.label)}</text>
      ${sub}
      <rect class="bar-track" x="${labelW}" y="${cy - 11}" width="${trackW}" height="22" rx="3"/>
      <rect class="bar-fill ${d.partial ? "partial" : ""}"${fillStyle} x="${labelW}" y="${cy - 11}" width="${w}" height="22" rx="3"/>
      <text class="bar-value" x="${labelW + w + 8}" y="${cy + 4}">${pct(d.rate)}</text>`;
  });

  // axis: baseline + 0% and max% ticks
  const baseY = top + items.length * rowH + 4;
  const axis = `
    <line class="axis-line" x1="${labelW}" y1="${baseY}" x2="${labelW + trackW}" y2="${baseY}"/>
    <text class="axis-tick" x="${labelW}" y="${baseY + 16}">0%</text>
    <text class="axis-tick" x="${labelW + trackW}" y="${baseY + 16}" text-anchor="end">${(domainMax * 100).toFixed(0)}%</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img">${rows.join("")}${axis}</svg>`;
}

// ---- renderers -------------------------------------------------------------

function renderMeta(s) {
  const t = s.totals;
  $("meta").textContent =
    `${num(t.annual_population)} annual reports from ${num(t.companies)} companies · ` +
    `filings from ${ymd(s.coverage.first_filed)} to ${ymd(s.coverage.last_filed)} · ` +
    `data updated ${new Date(s.generated_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
  $("footer-meta").textContent =
    `Generated ${new Date(s.generated_at).toUTCString()} from ${num(t.facts)} tagged disclosures across ${num(t.filings)} filings.`;
}

function renderHero(s) {
  const o = s.materiality.overall;
  $("hero-body").innerHTML = `
    <div class="hero-grid">
      <div class="bignum">${pct(o.rate)}<small>of companies</small></div>
      <div class="hero-copy">
        <p>of US-listed companies that answered the question told the SEC that
        cyber risk <strong>has materially affected them, or is reasonably likely
        to</strong>, in their latest annual report.</p>
        <div class="counts">
          <span><span class="dot" style="background:var(--accent)"></span>${num(o.yes)} said yes</span>
          <span><span class="dot" style="background:var(--neutral)"></span>${num(o.no)} said no</span>
          <span><span class="dot" style="background:var(--partial)"></span>${num(o.not_disclosed)} did not disclose the flag</span>
        </div>
      </div>
    </div>`;
}

function renderFy(s) {
  const rows = s.materiality.by_fiscal_year;
  const dmax = niceMax(Math.max(...rows.map((r) => r.rate || 0)));
  const items = rows.map((r) => {
    const partial = r.total < 200; // thin/incomplete cohorts
    return {
      label: "FY " + r.fy,
      rate: r.rate,
      partial,
      sublabel: `n = ${num(r.total)}${partial ? " · partial cohort" : ""}`,
    };
  });
  $("chart-fy").innerHTML = hBars(items, { domainMax: dmax, labelW: 150 });
  $("fy-note").textContent =
    "Greyed bars are partial cohorts: the earliest and latest fiscal years only include filers that fall inside the data window, so their rates are unreliable.";
}

function renderForm(s) {
  const items = s.materiality.by_form.map((r) => ({ label: r.label, rate: r.rate, n: r.yes + r.no }));
  $("chart-form").innerHTML = hBars(items, { labelW: 200 });
}

function renderSector(s) {
  const items = s.materiality.by_sector.map((r) => ({ label: r.sector, rate: r.rate, n: r.total }));
  $("chart-sector").innerHTML = hBars(items, { labelW: 260 });
}

// Board-facing labels for the five governance flags.
const GOV_META = {
  CybersecurityRiskManagementThirdPartyEngagedFlag: {
    label: "Independent third parties involved",
    desc: "Assessors, consultants or auditors engaged in the cyber-risk process",
  },
  CybersecurityRiskManagementPositionsOrCommitteesResponsibleFlag: {
    label: "A named management owner",
    desc: "A management role or committee is responsible for cyber risk",
  },
  CybersecurityRiskManagementProcessesIntegratedFlag: {
    label: "Built into enterprise risk management",
    desc: "Cyber risk is integrated into the company's overall risk processes",
  },
  CybersecurityRiskThirdPartyOversightAndIdentificationProcessesFlag: {
    label: "Oversees supply-chain risk",
    desc: "Processes to identify and oversee third-party / vendor cyber risk",
  },
  CybersecurityRiskManagementPositionsOrCommitteesResponsibleReportToBoardFlag: {
    label: "Reports up to the board",
    desc: "The responsible management role reports cyber risk to the board",
  },
};

function renderGovernance(s) {
  const g = s.governance;
  $("gov-base").textContent = num(g.completeness_base);
  const rows = g.flags.slice().sort((a, b) => b.rate - a.rate);
  $("scorecard").innerHTML = rows
    .map((f) => {
      const m = GOV_META[f.tag] || { label: f.tag, desc: "" };
      const w = (f.rate * 100).toFixed(1);
      return `
        <div class="score-row">
          <div>
            <div class="score-label">${esc(m.label)}</div>
            <div class="score-desc">${esc(m.desc)}</div>
          </div>
          <div class="score-val">${Math.round(f.rate * 100)}%<small>${num(f.affirmed)} of ${num(f.base)}</small></div>
          <div class="score-track"><div class="score-fill" style="width:${w}%"></div></div>
        </div>`;
    })
    .join("");
}

function renderCompleteness(s) {
  const g = s.governance;
  const base = g.completeness_base || 1;
  const items = g.completeness
    .slice()
    .sort((a, b) => b.yes_count - a.yes_count)
    .map((c) => ({ label: c.yes_count + " of 5", rate: c.n / base, n: c.n }));
  $("chart-comp").innerHTML = hBars(items, { labelW: 120, fill: "var(--good)" });
  const all5 = g.completeness.find((c) => c.yes_count === 5);
  if (all5) {
    $("comp-note").textContent =
      `${(100 * all5.n / base).toFixed(0)}% of companies that disclose their governance affirm all five practices; ` +
      `the rest disclose a partial picture.`;
  }
}

const INCIDENT_FIELDS = [
  ["nature", "Nature"],
  ["scope", "Scope"],
  ["timing", "Timing"],
  ["materialImpactOrReasonablyLikelyMaterialImpact", "Impact"],
  ["informationNotAvailableOrUndetermined", "Not yet determined"],
];

function renderIncidents(s) {
  const host = $("incidents");
  if (!s.incidents || !s.incidents.length) {
    host.innerHTML = '<p class="note">No material-incident disclosures in the current dataset.</p>';
    return;
  }
  host.innerHTML = s.incidents
    .map((it) => {
      const rows = INCIDENT_FIELDS.filter(([k]) => it[k])
        .map(([k, label]) => `<dt>${label}</dt><dd>${esc(it[k])}</dd>`)
        .join("");
      return `
        <article class="incident">
          <div class="ihead">
            <span class="co">${esc(it.company || "—")} <span class="tag-form">${esc(it.form)}</span></span>
            <span class="when">Filed ${ymd(it.filed_date)}</span>
          </div>
          <dl>${rows}</dl>
          <p><a href="${esc(it.filing_url)}" target="_blank" rel="noopener">View filing on SEC EDGAR →</a></p>
        </article>`;
    })
    .join("");
}

// ---- boot ------------------------------------------------------------------

fetch("./data/summary.json")
  .then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then((s) => {
    renderMeta(s);
    renderHero(s);
    renderFy(s);
    renderForm(s);
    renderSector(s);
    renderGovernance(s);
    renderCompleteness(s);
    renderIncidents(s);
  })
  .catch((err) => {
    $("meta").innerHTML = `<span class="error">Could not load data (${esc(err.message)}). ` +
      `Build it with <code>npm run build:site</code> and serve the <code>dist/</code> folder.</span>`;
  });
