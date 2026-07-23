// Landing Health Monitor
// Reads 3 KPIs (%Starter, %ODP, %Paid) from a single PostHog Trends insight
// that uses Formula mode (B/A*100 etc). Classifies each as green/yellow/red,
// appends to a CSV history, and alerts Slack only when status changes.
//
// NOTE: Bounce rate is not wired up yet — add it later as a 4th formula
// in the same PostHog insight, then add it back into KPI_CONFIG below.

const fs = require("fs");
const path = require("path");

// ---------- 1. CONFIGURATION ----------
// Edit thresholds here without touching any logic below.
// "label" here MUST exactly match the formula name you typed into PostHog
// (the text in the "Formula name" box, e.g. "%Starter").
const KPI_CONFIG = {
  bounce: { label: "%Bounce", direction: "lowerIsBetter", green: 40, yellow: 55 },
  starter: { label: "%Starter", direction: "higherIsBetter", green: 30, yellow: 20 },
  odp: { label: "%ODP", direction: "higherIsBetter", green: 60, yellow: 45 },
  paid: { label: "%Paid", direction: "higherIsBetter", green: 70, yellow: 55 },
};

const CHECKLISTS = {
  bounce: ["Check page load speed", "Check for broken layout on mobile", "Check recent deploy or content change"],
  starter: ["Check CTA visibility & copy", "Check tracking / event firing", "Check mobile rendering", "Check recent deploy"],
  odp: ["Check form errors or validation bugs", "Check payment gateway status", "Check step drop-off in the funnel view"],
  paid: ["Check payment provider status", "Check discount/coupon logic", "Check for checkout errors in logs"],
};

const ENV = process.env;
const POSTHOG_HOST = ENV.POSTHOG_HOST || "https://us.posthog.com";
const PROJECT_ID = ENV.POSTHOG_PROJECT_ID;
const API_KEY = ENV.POSTHOG_API_KEY;
const TREND_SHORT_ID = ENV.POSTHOG_TREND_SHORT_ID; // the "Landing Health Monitor — Trend %" insight
const SLACK_WEBHOOK_URL = ENV.SLACK_WEBHOOK_URL;
const HEALTHCHECK_URL = ENV.HEALTHCHECK_URL; // optional, from healthchecks.io
const HISTORY_PATH = path.join(__dirname, "data", "history.csv");

// ---------- 2. FETCH FROM POSTHOG ----------
async function fetchTrendInsight() {
  const url = `${POSTHOG_HOST}/api/projects/${PROJECT_ID}/insights/?short_id=${TREND_SHORT_ID}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) throw new Error(`PostHog API error ${res.status} for insight ${TREND_SHORT_ID}`);
  const json = await res.json();
  const insight = json.results?.[0];
  if (!insight) throw new Error(`Insight ${TREND_SHORT_ID} not found`);
  return insight.result; // array of series, one per formula
}

// Pull yesterday's value out of a named formula series.
// Falls back to the last non-null point if "yesterday" isn't in the range
// (e.g. if the insight's date grouping doesn't line up exactly).
function yesterdayValue(result, formulaLabel) {
  const series = result.find((s) => s.label === formulaLabel);
  if (!series) throw new Error(`Formula "${formulaLabel}" not found in insight result`);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const days = series.days || [];
  let idx = days.findIndex((d) => d.startsWith(yesterday));

  if (idx === -1) {
    // fallback: last point that isn't the (possibly incomplete) "today" bucket
    idx = series.data.length - 2 >= 0 ? series.data.length - 2 : series.data.length - 1;
  }
  return series.data[idx] ?? 0;
}

// ---------- 3. CLASSIFY ----------
function classify(value, cfg) {
  if (cfg.direction === "lowerIsBetter") {
    if (value < cfg.green) return "green";
    if (value < cfg.yellow) return "yellow";
    return "red";
  }
  if (value > cfg.green) return "green";
  if (value > cfg.yellow) return "yellow";
  return "red";
}

const RANK = { green: 0, yellow: 1, red: 2 };
function worstStatus(statusMap) {
  return Object.entries(statusMap).sort((a, b) => RANK[b[1]] - RANK[a[1]])[0][1];
}

// ---------- 4. HISTORY (CSV in repo) ----------
function readLastRow() {
  if (!fs.existsSync(HISTORY_PATH)) return null;
  const lines = fs.readFileSync(HISTORY_PATH, "utf8").trim().split("\n");
  if (lines.length < 2) return null;
  const headers = lines[0].split(",");
  const values = lines[lines.length - 1].split(",");
  return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
}

function appendRow(row) {
  const headers = "date,bounce_value,bounce_status,starter_value,starter_status,odp_value,odp_status,paid_value,paid_status,overall";
  const exists = fs.existsSync(HISTORY_PATH);
  if (!exists) fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  const line = [
    row.date,
    row.values.bounce.toFixed(1), row.status.bounce,
    row.values.starter.toFixed(1), row.status.starter,
    row.values.odp.toFixed(1), row.status.odp,
    row.values.paid.toFixed(1), row.status.paid,
    row.overall,
  ].join(",");
  if (!exists) fs.writeFileSync(HISTORY_PATH, headers + "\n" + line + "\n");
  else fs.appendFileSync(HISTORY_PATH, line + "\n");
}

// ---------- 5. SLACK ALERT ----------
async function sendSlackAlert(status, values, overall) {
  const emoji = { green: "🟢", yellow: "🟡", red: "🔴" };
  const lines = Object.keys(KPI_CONFIG).map(
    (k) => `${emoji[status[k]]} *${KPI_CONFIG[k].label}*: ${values[k].toFixed(1)}%`
  );
  let text = `*Landing Health — ${overall.toUpperCase()}*\n` + lines.join("\n");

  const worstKpi = Object.keys(status).sort((a, b) => RANK[status[b]] - RANK[status[a]])[0];
  if (status[worstKpi] === "red" && CHECKLISTS[worstKpi]) {
    text += `\n\n*Start here (${KPI_CONFIG[worstKpi].label}):*\n` + CHECKLISTS[worstKpi].map((c) => `• ${c}`).join("\n");
  }

  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// ---------- 6. MAIN ----------
// NOTE: the real funnel order turned out to be:
//   Pageview (A) -> client_returned_to_odp (C, "Starter") ->
//   cta_order_step (D, "ODP"/review) -> cta_order_finish (B, "Paid")
// The PostHog insight's formulas are already set up this way:
//   %Starter = C/A*100, %ODP = D/C*100, %Paid = B/D*100, %Bounce = E/A*100
// This script just reads whatever is named %Bounce/%Starter/%ODP/%Paid in
// the insight — it doesn't care about A/B/C/D labels itself.
async function main() {
  const result = await fetchTrendInsight();
async function main() {
  console.log("ENV CHECK:", {
    POSTHOG_HOST: !!ENV.POSTHOG_HOST,
    POSTHOG_PROJECT_ID: !!ENV.POSTHOG_PROJECT_ID,
    POSTHOG_API_KEY: !!ENV.POSTHOG_API_KEY,
    POSTHOG_TREND_SHORT_ID: !!ENV.POSTHOG_TREND_SHORT_ID,
    SLACK_WEBHOOK_URL: !!ENV.SLACK_WEBHOOK_URL,
  });

  const result = await fetchTrendInsight();
  const values = {
    bounce: yesterdayValue(result, KPI_CONFIG.bounce.label),
    starter: yesterdayValue(result, KPI_CONFIG.starter.label),
    odp: yesterdayValue(result, KPI_CONFIG.odp.label),
    paid: yesterdayValue(result, KPI_CONFIG.paid.label),
  };

  const status = Object.fromEntries(
    Object.keys(KPI_CONFIG).map((k) => [k, classify(values[k], KPI_CONFIG[k])])
  );
  const overall = worstStatus(status);

  const previous = readLastRow();
  const previousOverall = previous?.overall;

  appendRow({ date: new Date().toISOString().slice(0, 10), values, status, overall });

  if (overall !== "green" && overall !== previousOverall) {
    await sendSlackAlert(status, values, overall);
  }

  if (HEALTHCHECK_URL) await fetch(HEALTHCHECK_URL);
  console.log("Done:", { values, status, overall });
}

main().catch(async (err) => {
  console.error(err);
  if (HEALTHCHECK_URL) await fetch(HEALTHCHECK_URL + "/fail").catch(() => {});
  process.exit(1);
});
