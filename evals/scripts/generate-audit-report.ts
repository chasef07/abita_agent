/**
 * Renders a quick-scan HTML dashboard from structured call audits.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_INTENT_BUCKETS } from "../lib/audit.js";
import { OUTPUT_DIR, ensureDir, findTodayOutput, readJSON } from "../lib/io.js";
import type {
  AuditIntentBucket,
  CallAuditRecord,
  CallAuditReport,
} from "../lib/types.js";

const HISTORY_PATH = join(OUTPUT_DIR, "history.jsonl");
const REPORT_PATH = join(OUTPUT_DIR, "audit-report.html");

interface HistoryRow {
  date: string;
  audit?: {
    total: number;
    resolved: number;
    toolCorrect: number;
    hallucinationSafe: number;
    byBucket?: Partial<
      Record<
        AuditIntentBucket,
        { total: number; resolved: number; avgTurns: number }
      >
    >;
  };
}

function readHistory(): HistoryRow[] {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryRow)
    .filter((row) => row.audit);
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

function formatBucketLabel(bucket: AuditIntentBucket): string {
  switch (bucket) {
    case "new_patient":
      return "New patient";
    case "faq":
      return "FAQ";
    case "immediate_transfer":
      return "Immediate transfer";
    case "confirm":
      return "Confirm";
    case "cancel_rebook":
      return "Cancel / rebook";
    case "existing_patient_booking":
      return "Existing patient booking";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function topCounts(
  counts: Record<string, number>,
  limit: number,
): Array<{ label: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function weakestCalls(
  audits: CallAuditRecord[],
  limit: number,
): CallAuditRecord[] {
  const rank = (audit: CallAuditRecord): number => {
    if (audit.overallStatus === "failed") return 3;
    if (audit.overallStatus === "needs_work") return 2;
    return 1;
  };
  return [...audits]
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        Number(a.resolved) - Number(b.resolved) ||
        a.pathEfficiency.score - b.pathEfficiency.score,
    )
    .slice(0, limit);
}

function bucketRows(report: CallAuditReport): string {
  return AUDIT_INTENT_BUCKETS.map((bucket) => {
    const entry = report.byBucket[bucket];
    return `
      <tr>
        <td>${formatBucketLabel(bucket)}</td>
        <td>${entry.total}</td>
        <td>${pct(entry.resolved, entry.total)}%</td>
        <td>${pct(entry.toolCorrect, entry.total)}%</td>
        <td>${pct(entry.hallucinationSafe, entry.total)}%</td>
        <td>${entry.avgTurns}</td>
        <td>${entry.avgPathScore}</td>
      </tr>
    `;
  }).join("");
}

function callCards(audits: CallAuditRecord[]): string {
  return weakestCalls(audits, 8)
    .map((audit) => {
      const chips = [
        `<span class="chip bucket">${formatBucketLabel(audit.intentBucket)}</span>`,
        `<span class="chip ${audit.overallStatus === "great" ? "good" : audit.overallStatus === "needs_work" ? "warn" : "bad"}">${audit.overallStatus.replace("_", " ")}</span>`,
        `<span class="chip neutral">${audit.callId}</span>`,
      ].join("");
      const failures =
        audit.failureModes.length > 0 ? audit.failureModes.join(", ") : "none";
      const strengths =
        audit.strengths.length > 0 ? audit.strengths.join(" | ") : "none noted";
      const fixes =
        audit.recommendedFixes.length > 0
          ? audit.recommendedFixes.join(" | ")
          : "none suggested";
      return `
      <article class="call-card">
        <div class="call-card-header">${chips}</div>
        <p class="call-reason">${escapeHtml(audit.resolutionReason)}</p>
        <p><strong>Failures:</strong> ${escapeHtml(failures)}</p>
        <p><strong>Tool issues:</strong> ${escapeHtml(audit.toolCorrectness.issues.join(" | ") || "none")}</p>
        <p><strong>Strengths:</strong> ${escapeHtml(strengths)}</p>
        <p><strong>Fixes:</strong> ${escapeHtml(fixes)}</p>
      </article>
    `;
    })
    .join("");
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function main() {
  const report = readJSON<CallAuditReport>(findTodayOutput("audits-"));
  if (!report) {
    console.error("No audits report found for today.");
    process.exit(1);
  }

  const history = readHistory();
  const failureModeTop = topCounts(report.failureModeCounts, 8);
  const strengthsTop = topCounts(report.strengthCounts, 8);
  const bucketLabels = AUDIT_INTENT_BUCKETS.map(formatBucketLabel);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Call Audit Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #f5efe3;
      --card: rgba(255, 251, 245, 0.88);
      --ink: #10221b;
      --muted: #5e675f;
      --line: rgba(16, 34, 27, 0.12);
      --forest: #1b5e4b;
      --moss: #7aa87b;
      --clay: #b85c38;
      --gold: #d5a43b;
      --rose: #8d3b3b;
      --sand: #e7dcc7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(213, 164, 59, 0.22), transparent 34%),
        radial-gradient(circle at top right, rgba(27, 94, 75, 0.18), transparent 28%),
        linear-gradient(180deg, #f7f2e9 0%, var(--bg) 100%);
      padding: 32px;
    }
    .shell {
      max-width: 1320px;
      margin: 0 auto;
    }
    .hero {
      margin-bottom: 20px;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 12px 32px rgba(42, 48, 35, 0.08);
      padding: 22px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(2.3rem, 4vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .subtitle {
      color: var(--muted);
      max-width: 60ch;
      font-size: 1rem;
      line-height: 1.5;
    }
    .hero-grid, .charts-grid {
      display: grid;
      gap: 16px;
    }
    .hero-grid {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      margin-top: 22px;
    }
    .charts-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-bottom: 20px;
    }
    .metric {
      padding: 18px;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.3));
      border: 1px solid rgba(16, 34, 27, 0.08);
    }
    .metric-label {
      color: var(--muted);
      font-size: 0.86rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }
    .metric-value {
      font-size: clamp(1.8rem, 3vw, 2.8rem);
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .metric-value.metric-text {
      font-size: clamp(1rem, 1.6vw, 1.35rem);
      letter-spacing: -0.02em;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
    .metric-sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 1.05rem;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--muted);
    }
    .chart-wrap {
      height: 320px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.94rem;
    }
    th, td {
      text-align: left;
      padding: 12px 10px;
      border-bottom: 1px solid var(--line);
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 20px;
      margin-bottom: 20px;
    }
    .list {
      display: grid;
      gap: 10px;
    }
    .list-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .bar {
      height: 10px;
      flex: 1;
      border-radius: 999px;
      overflow: hidden;
      background: var(--sand);
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--forest), var(--gold));
    }
    .bar-label {
      width: 180px;
      font-size: 0.92rem;
    }
    .bar-count {
      width: 42px;
      text-align: right;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .call-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .call-card {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      background: rgba(255,255,255,0.45);
    }
    .call-card-header {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .chip.good { background: rgba(122, 168, 123, 0.22); color: #275f37; }
    .chip.warn { background: rgba(213, 164, 59, 0.22); color: #8a6518; }
    .chip.bad { background: rgba(141, 59, 59, 0.18); color: #7d2e2e; }
    .chip.neutral { background: rgba(16, 34, 27, 0.08); color: var(--ink); }
    .chip.bucket { background: rgba(27, 94, 75, 0.16); color: var(--forest); }
    .call-reason {
      font-size: 1rem;
      line-height: 1.45;
      margin: 0 0 10px;
    }
    p { margin: 8px 0 0; line-height: 1.45; }
    .footer-note {
      color: var(--muted);
      font-size: 0.9rem;
      margin-top: 12px;
    }
    .hero-meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .hero-meta span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(16, 34, 27, 0.05);
      border: 1px solid rgba(16, 34, 27, 0.08);
    }
    @media (max-width: 1100px) {
      .two-col, .charts-grid, .call-grid {
        grid-template-columns: 1fr;
      }
      .hero-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 760px) {
      .hero-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="panel">
        <h1>Call audit dashboard</h1>
        <p class="subtitle">
          Fast view of what the agent resolved, where it wasted motion, where it risked hallucination, and what it already does well.
          This report is driven by the structured audit pipeline rather than one coarse pass/fail score.
        </p>
        <div class="hero-meta">
          <span>Date ${report.date}</span>
          <span>${report.totalCalls} calls audited</span>
          <span>History-backed trend charts turn on as <code>history.jsonl</code> fills in</span>
        </div>
        <div class="hero-grid">
          <div class="metric">
            <div class="metric-label">Resolved</div>
            <div class="metric-value">${pct(report.overall.resolved, report.totalCalls)}%</div>
            <div class="metric-sub">${report.overall.resolved}/${report.totalCalls} calls</div>
          </div>
          <div class="metric">
            <div class="metric-label">Tool correct</div>
            <div class="metric-value">${pct(report.overall.toolCorrect, report.totalCalls)}%</div>
            <div class="metric-sub">${report.overall.toolCorrect}/${report.totalCalls}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Hallucination safe</div>
            <div class="metric-value">${pct(report.overall.hallucinationSafe, report.totalCalls)}%</div>
            <div class="metric-sub">${report.overall.hallucinationSafe}/${report.totalCalls}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Avg turns</div>
            <div class="metric-value">${report.overall.avgTurns}</div>
            <div class="metric-sub">Avg duration ${report.overall.avgDurationSec}s</div>
          </div>
          <div class="metric">
            <div class="metric-label">Top failure</div>
            <div class="metric-value metric-text">${escapeHtml(failureModeTop[0]?.label ?? "none")}</div>
            <div class="metric-sub">${failureModeTop[0]?.count ?? 0} calls</div>
          </div>
          <div class="metric">
            <div class="metric-label">Top strength</div>
            <div class="metric-value metric-text">${escapeHtml(strengthsTop[0]?.label ?? "none")}</div>
            <div class="metric-sub">${strengthsTop[0]?.count ?? 0} calls</div>
          </div>
          <div class="metric">
            <div class="metric-label">Calls audited</div>
            <div class="metric-value">${report.totalCalls}</div>
            <div class="metric-sub">Structured production sample</div>
          </div>
        </div>
      </div>
    </section>

    <section class="charts-grid">
      <div class="panel">
        <div class="section-title">Call volume by bucket</div>
        <div class="chart-wrap"><canvas id="bucketVolumeChart"></canvas></div>
      </div>
      <div class="panel">
        <div class="section-title">Resolution and quality by bucket</div>
        <div class="chart-wrap"><canvas id="bucketQualityChart"></canvas></div>
      </div>
      <div class="panel">
        <div class="section-title">Average turns by bucket</div>
        <div class="chart-wrap"><canvas id="turnsChart"></canvas></div>
      </div>
      <div class="panel">
        <div class="section-title">Trend over time</div>
        <div class="chart-wrap"><canvas id="trendChart"></canvas></div>
      </div>
    </section>

    <section class="two-col">
      <div class="panel">
        <div class="section-title">Bucket breakdown</div>
        <table>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Calls</th>
              <th>Resolved</th>
              <th>Tool correct</th>
              <th>Hallucination safe</th>
              <th>Avg turns</th>
              <th>Path score</th>
            </tr>
          </thead>
          <tbody>${bucketRows(report)}</tbody>
        </table>
      </div>
      <div class="panel">
        <div class="section-title">Top failure modes</div>
        <div class="list">
          ${failureModeTop
            .map(
              (item) => `
            <div class="list-row">
              <div class="bar-label">${escapeHtml(item.label)}</div>
              <div class="bar"><div class="bar-fill" style="width:${Math.max(10, (item.count / Math.max(failureModeTop[0]?.count ?? 1, 1)) * 100)}%"></div></div>
              <div class="bar-count">${item.count}</div>
            </div>
          `,
            )
            .join("")}
        </div>
        <div class="section-title" style="margin-top:20px;">What the agent does well</div>
        <div class="list">
          ${strengthsTop
            .map(
              (item) => `
            <div class="list-row">
              <div class="bar-label">${escapeHtml(item.label)}</div>
              <div class="bar"><div class="bar-fill" style="width:${Math.max(10, (item.count / Math.max(strengthsTop[0]?.count ?? 1, 1)) * 100)}%"></div></div>
              <div class="bar-count">${item.count}</div>
            </div>
          `,
            )
            .join("")}
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="section-title">Calls that need review first</div>
      <div class="call-grid">${callCards(report.audits)}</div>
    </section>
  </div>

  <script>
    const bucketLabels = ${json(bucketLabels)};
    const bucketStats = ${json(AUDIT_INTENT_BUCKETS.map((bucket) => report.byBucket[bucket]))};
    const history = ${json(history)};
    const palette = {
      forest: "#1b5e4b",
      moss: "#7aa87b",
      clay: "#b85c38",
      gold: "#d5a43b",
      rose: "#8d3b3b",
      ink: "#10221b",
      grid: "rgba(16, 34, 27, 0.12)"
    };
    Chart.defaults.color = palette.ink;
    Chart.defaults.font.family = '"Avenir Next", "Segoe UI", sans-serif';
    Chart.defaults.borderColor = palette.grid;

    new Chart(document.getElementById("bucketVolumeChart"), {
      type: "bar",
      data: {
        labels: bucketLabels,
        datasets: [{
          label: "Calls",
          data: bucketStats.map((entry) => entry.total),
          backgroundColor: [palette.forest, palette.gold, palette.clay, palette.moss, palette.rose, "#4b7c7a"],
          borderRadius: 12,
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { maxRotation: 0, minRotation: 0 } }
        }
      }
    });

    new Chart(document.getElementById("bucketQualityChart"), {
      type: "bar",
      data: {
        labels: bucketLabels,
        datasets: [
          {
            label: "Resolved %",
            data: bucketStats.map((entry) => entry.total ? Number(((entry.resolved / entry.total) * 100).toFixed(1)) : 0),
            backgroundColor: palette.forest,
            borderRadius: 8,
          },
          {
            label: "Tool correct %",
            data: bucketStats.map((entry) => entry.total ? Number(((entry.toolCorrect / entry.total) * 100).toFixed(1)) : 0),
            backgroundColor: palette.gold,
            borderRadius: 8,
          },
          {
            label: "Hallucination safe %",
            data: bucketStats.map((entry) => entry.total ? Number(((entry.hallucinationSafe / entry.total) * 100).toFixed(1)) : 0),
            backgroundColor: palette.clay,
            borderRadius: 8,
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, max: 100 },
          x: { ticks: { maxRotation: 0, minRotation: 0 } }
        }
      }
    });

    new Chart(document.getElementById("turnsChart"), {
      type: "line",
      data: {
        labels: bucketLabels,
        datasets: [{
          label: "Avg turns",
          data: bucketStats.map((entry) => entry.avgTurns),
          borderColor: palette.rose,
          backgroundColor: "rgba(141, 59, 59, 0.14)",
          fill: true,
          tension: 0.32,
          pointRadius: 4,
          pointBackgroundColor: palette.rose,
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });

    new Chart(document.getElementById("trendChart"), {
      type: "line",
      data: {
        labels: history.map((row) => row.date),
        datasets: [
          {
            label: "Resolved %",
            data: history.map((row) => row.audit && row.audit.total ? Number(((row.audit.resolved / row.audit.total) * 100).toFixed(1)) : null),
            borderColor: palette.forest,
            tension: 0.28,
            pointRadius: 3,
          },
          {
            label: "Tool correct %",
            data: history.map((row) => row.audit && row.audit.total ? Number(((row.audit.toolCorrect / row.audit.total) * 100).toFixed(1)) : null),
            borderColor: palette.gold,
            tension: 0.28,
            pointRadius: 3,
          },
          {
            label: "Hallucination safe %",
            data: history.map((row) => row.audit && row.audit.total ? Number(((row.audit.hallucinationSafe / row.audit.total) * 100).toFixed(1)) : null),
            borderColor: palette.clay,
            tension: 0.28,
            pointRadius: 3,
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, max: 100 } }
      }
    });
  </script>
</body>
</html>`;

  ensureDir(OUTPUT_DIR);
  writeFileSync(REPORT_PATH, html, "utf-8");
  console.log(`Wrote ${REPORT_PATH}`);
}

main();
