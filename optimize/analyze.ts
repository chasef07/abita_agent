/**
 * Analytics dashboard generator.
 * Queries the Prisma DB, computes metrics, and generates an HTML report with charts.
 *
 * Usage: npm run analyze
 * Output: optimize/report.html
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set in .env.local");
  process.exit(1);
}

// --- DB Query Helper ---

async function query(sql: string): Promise<any[]> {
  const { execSync } = await import("child_process");
  // Collapse whitespace — psql -c chokes on newlines
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const result = execSync(
    `psql "${DATABASE_URL}" -t -A -F '\t' -c ${JSON.stringify(oneLine)}`,
    { encoding: "utf-8", timeout: 15_000 },
  );
  return result
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

// --- Call Classification ---

interface CallRecord {
  callId: string;
  totalTurns: number;
  durationSec: number;
  toolCalls: number;
  toolErrors: number;
  startedAt: string;
  officePhone: string;
  type: "new_patient" | "existing_patient" | "faq" | "transfer" | "hangup";
  resolved: boolean;
  toolsUsed: string[];
  turns: any[];
}

function classifyCall(toolsUsed: string[], totalTurns: number, durationSec: number): {
  type: CallRecord["type"];
  resolved: boolean;
} {
  if (totalTurns <= 1 || durationSec < 5) {
    return { type: "hangup", resolved: false };
  }

  const hasTransfer = toolsUsed.includes("transfer_call");
  const hasAddPatient = toolsUsed.includes("add_patient");
  const hasBookAppt = toolsUsed.includes("book_appt");
  const hasVerify = toolsUsed.includes("verify_patient");
  const hasFaq = toolsUsed.includes("check_insurance") || toolsUsed.includes("lookup_knowledge");
  const hasConfirm = toolsUsed.includes("confirm_appt");
  const hasCancel = toolsUsed.includes("cancel_appt");

  if (hasAddPatient) {
    return {
      type: "new_patient",
      resolved: hasBookAppt, // resolved if they also booked
    };
  }

  if (hasVerify && (hasBookAppt || hasConfirm || hasCancel)) {
    return {
      type: "existing_patient",
      resolved: true, // completed a scheduling action
    };
  }

  if (hasTransfer && !hasBookAppt && !hasAddPatient) {
    // Determine if transfer was appropriate or premature
    const onlyTransfer = toolsUsed.filter((t) => t !== "transfer_call").length === 0;
    return {
      type: "transfer",
      resolved: true, // transfer is a resolution (appropriate or not)
    };
  }

  if (hasFaq && !hasTransfer) {
    return {
      type: "faq",
      resolved: true,
    };
  }

  if (hasFaq && hasTransfer) {
    return {
      type: "faq",
      resolved: false, // had to transfer after FAQ attempt
    };
  }

  if (hasTransfer) {
    return { type: "transfer", resolved: true };
  }

  // No tools or unclear
  return {
    type: totalTurns <= 3 ? "hangup" : "faq",
    resolved: totalTurns > 2,
  };
}

// --- Ideal Baselines ---

const IDEAL_TURNS: Record<string, { min: number; max: number; label: string }> = {
  faq: { min: 2, max: 4, label: "FAQ" },
  new_patient: { min: 14, max: 22, label: "New Patient + Book" },
  existing_patient: { min: 5, max: 10, label: "Existing Patient" },
  transfer: { min: 2, max: 4, label: "Transfer" },
};

const IDEAL_TOOL_SEQUENCE: Record<string, string[]> = {
  new_patient: ["verify_patient", "check_insurance", "add_patient", "get_availability", "book_appt"],
  existing_patient: ["verify_patient", "get_availability", "book_appt"],
  faq: ["check_insurance"],
  transfer: ["transfer_call"],
};

// --- Main ---

async function main() {
  console.log("Fetching call data...");

  // Get all calls with their tools
  const rows = await query(`
    SELECT
      ce."callId",
      ce."totalTurns",
      ce."durationSec",
      ce."toolCalls",
      ce."toolErrors",
      ce."startedAt"::text,
      ce."officePhone",
      (
        SELECT string_agg(DISTINCT t->>'name', ',')
        FROM jsonb_array_elements(data->'turns') turn,
             jsonb_array_elements(turn->'toolCalls') t
      ) as tools_used
    FROM "CallEvent" ce
    ORDER BY ce."startedAt" DESC
  `);

  const calls: CallRecord[] = rows.map((r) => {
    const toolsUsed = r[7] ? r[7].split(",") : [];
    const { type, resolved } = classifyCall(toolsUsed, parseInt(r[1]), parseInt(r[2]));
    return {
      callId: r[0],
      totalTurns: parseInt(r[1]),
      durationSec: parseInt(r[2]),
      toolCalls: parseInt(r[3]),
      toolErrors: parseInt(r[4]),
      startedAt: r[5],
      officePhone: r[6],
      type,
      resolved,
      toolsUsed,
      turns: [],
    };
  });

  console.log(`Analyzed ${calls.length} calls.`);

  // Get double transfer counts
  const doubleTransfers = await query(`
    SELECT count(DISTINCT ce."callId")
    FROM "CallEvent" ce, jsonb_array_elements(data->'turns') c, jsonb_array_elements(c->'toolCalls') t
    WHERE t->>'name' = 'transfer_call'
    GROUP BY ce."callId"
    HAVING count(*) > 1
  `);

  // --- Compute Metrics ---

  const nonHangup = calls.filter((c) => c.type !== "hangup");
  const byType = new Map<string, CallRecord[]>();
  for (const call of nonHangup) {
    const list = byType.get(call.type) ?? [];
    list.push(call);
    byType.set(call.type, list);
  }

  // Resolution rates
  const resolutionRates: Record<string, { total: number; resolved: number; rate: number }> = {};
  for (const [type, typeCalls] of byType) {
    const resolved = typeCalls.filter((c) => c.resolved).length;
    resolutionRates[type] = {
      total: typeCalls.length,
      resolved,
      rate: Math.round((resolved / typeCalls.length) * 100),
    };
  }

  // Avg turns by type
  const avgTurns: Record<string, { avg: number; min: number; max: number; count: number }> = {};
  for (const [type, typeCalls] of byType) {
    const turns = typeCalls.map((c) => c.totalTurns);
    avgTurns[type] = {
      avg: Math.round(turns.reduce((a, b) => a + b, 0) / turns.length),
      min: Math.min(...turns),
      max: Math.max(...turns),
      count: turns.length,
    };
  }

  // Avg duration by type
  const avgDuration: Record<string, number> = {};
  for (const [type, typeCalls] of byType) {
    const durations = typeCalls.map((c) => c.durationSec);
    avgDuration[type] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }

  // Transfer rate (% of non-hangup calls that end in transfer)
  const transferCalls = nonHangup.filter((c) => c.toolsUsed.includes("transfer_call"));
  const transferRate = Math.round((transferCalls.length / nonHangup.length) * 100);

  // Tool usage frequency
  const toolFreq: Record<string, number> = {};
  for (const call of nonHangup) {
    for (const tool of call.toolsUsed) {
      toolFreq[tool] = (toolFreq[tool] ?? 0) + 1;
    }
  }

  // Daily call volumes (last 14 days)
  const dailyRows = await query(`
    SELECT
      date_trunc('day', "startedAt")::date::text as day,
      count(*) as total,
      count(*) FILTER (WHERE "totalTurns" > 1) as substantive
    FROM "CallEvent"
    WHERE "startedAt" > now() - interval '14 days'
    GROUP BY 1
    ORDER BY 1
  `);

  // Path analysis: for each call type, what tool sequence did we see?
  const pathAnalysis: Record<string, Record<string, number>> = {};
  for (const call of nonHangup) {
    if (!pathAnalysis[call.type]) pathAnalysis[call.type] = {};
    const path = call.toolsUsed.join(" → ") || "(no tools)";
    pathAnalysis[call.type][path] = (pathAnalysis[call.type][path] ?? 0) + 1;
  }

  // --- Generate HTML ---

  const typeLabels = { faq: "FAQ", new_patient: "New Patient", existing_patient: "Existing Patient", transfer: "Transfer", hangup: "Hangup" };
  const typeColors = { faq: "#4CAF50", new_patient: "#2196F3", existing_patient: "#FF9800", transfer: "#F44336", hangup: "#9E9E9E" };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Analytics Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-bottom: 1rem; color: #888; font-weight: 400; }
    h3 { font-size: 1rem; margin-bottom: 0.75rem; color: #aaa; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
    .card { background: #151515; border: 1px solid #222; border-radius: 12px; padding: 1.5rem; }
    .stat { font-size: 2.5rem; font-weight: 700; line-height: 1; }
    .stat-label { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
    .stat-row { display: flex; gap: 2rem; margin-bottom: 1rem; }
    .chart-container { position: relative; height: 280px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #222; }
    th { color: #888; font-weight: 500; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
    .tag-good { background: #1b5e20; color: #81c784; }
    .tag-warn { background: #e65100; color: #ffb74d; }
    .tag-bad { background: #b71c1c; color: #ef9a9a; }
    .path-item { font-family: monospace; font-size: 0.8rem; color: #90CAF9; }
    .bar { display: inline-block; height: 8px; border-radius: 4px; margin-right: 8px; vertical-align: middle; }
    .timestamp { color: #666; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Agent Performance Report</h1>
  <h2>Generated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} — ${calls.length} total calls</h2>

  <!-- KPI Cards -->
  <div class="grid">
    <div class="card">
      <div class="stat">${nonHangup.length}</div>
      <div class="stat-label">Substantive Calls (${calls.length - nonHangup.length} hangups excluded)</div>
    </div>
    <div class="card">
      <div class="stat">${100 - transferRate}%</div>
      <div class="stat-label">Handled Without Transfer (${nonHangup.length - transferCalls.length}/${nonHangup.length})</div>
    </div>
    <div class="card">
      <div class="stat">${doubleTransfers.length}</div>
      <div class="stat-label">Calls with Double transfer_call (of ${transferCalls.length} transfers)</div>
    </div>
    <div class="card">
      <div class="stat">${Math.round(nonHangup.reduce((a, c) => a + c.durationSec, 0) / nonHangup.length)}s</div>
      <div class="stat-label">Avg Call Duration</div>
    </div>
  </div>

  <!-- Charts Row 1 -->
  <div class="grid">
    <div class="card">
      <h3>Call Type Distribution</h3>
      <div class="chart-container"><canvas id="typeChart"></canvas></div>
    </div>
    <div class="card">
      <h3>Avg Turns by Type (vs Ideal Range)</h3>
      <div class="chart-container"><canvas id="turnsChart"></canvas></div>
    </div>
  </div>

  <!-- Charts Row 2 -->
  <div class="grid">
    <div class="card">
      <h3>Resolution Rate by Type</h3>
      <div class="chart-container"><canvas id="resolutionChart"></canvas></div>
    </div>
    <div class="card">
      <h3>Tool Usage Frequency</h3>
      <div class="chart-container"><canvas id="toolChart"></canvas></div>
    </div>
  </div>

  <!-- Charts Row 3 -->
  <div class="grid">
    <div class="card" style="grid-column: span 2;">
      <h3>Daily Call Volume (Last 14 Days)</h3>
      <div class="chart-container"><canvas id="dailyChart"></canvas></div>
    </div>
  </div>

  <!-- Path Analysis Table -->
  <div class="card" style="margin-bottom: 2rem;">
    <h3>Path Analysis — Most Common Tool Sequences</h3>
    <table>
      <thead><tr><th>Type</th><th>Tool Sequence</th><th>Count</th><th>Ideal Path</th><th>Match</th></tr></thead>
      <tbody>
        ${Object.entries(pathAnalysis)
          .flatMap(([type, paths]) =>
            Object.entries(paths)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([path, count]) => {
                const ideal = (IDEAL_TOOL_SEQUENCE[type] ?? []).join(" → ");
                const isIdeal = path === ideal;
                return `<tr>
                  <td>${(typeLabels as any)[type] ?? type}</td>
                  <td class="path-item">${path}</td>
                  <td>${count}</td>
                  <td class="path-item">${ideal || "—"}</td>
                  <td>${isIdeal ? '<span class="tag tag-good">Match</span>' : '<span class="tag tag-warn">Diff</span>'}</td>
                </tr>`;
              }),
          )
          .join("\n")}
      </tbody>
    </table>
  </div>

  <!-- Per-Type Metrics Table -->
  <div class="card" style="margin-bottom: 2rem;">
    <h3>Per-Type Metrics</h3>
    <table>
      <thead><tr><th>Type</th><th>Count</th><th>Avg Turns</th><th>Ideal Range</th><th>Efficiency</th><th>Avg Duration</th><th>Resolution</th></tr></thead>
      <tbody>
        ${Array.from(byType.entries())
          .map(([type, typeCalls]) => {
            const ideal = IDEAL_TURNS[type];
            const avg = avgTurns[type]?.avg ?? 0;
            const inRange = ideal ? avg >= ideal.min && avg <= ideal.max : true;
            const tag = inRange ? "tag-good" : avg > (ideal?.max ?? 999) ? "tag-bad" : "tag-warn";
            return `<tr>
              <td>${(typeLabels as any)[type] ?? type}</td>
              <td>${typeCalls.length}</td>
              <td>${avg} (${avgTurns[type]?.min}–${avgTurns[type]?.max})</td>
              <td>${ideal ? `${ideal.min}–${ideal.max}` : "—"}</td>
              <td><span class="tag ${tag}">${inRange ? "On Target" : avg > (ideal?.max ?? 999) ? "Over" : "Under"}</span></td>
              <td>${avgDuration[type]}s</td>
              <td>${resolutionRates[type]?.rate ?? 0}%</td>
            </tr>`;
          })
          .join("\n")}
      </tbody>
    </table>
  </div>

  <script>
    const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#888' } } }, scales: { x: { ticks: { color: '#888' }, grid: { color: '#222' } }, y: { ticks: { color: '#888' }, grid: { color: '#222' } } } };

    // Type distribution
    new Chart(document.getElementById('typeChart'), {
      type: 'doughnut',
      data: {
        labels: ${JSON.stringify(Array.from(byType.keys()).map((k) => (typeLabels as any)[k] ?? k))},
        datasets: [{ data: ${JSON.stringify(Array.from(byType.values()).map((v) => v.length))}, backgroundColor: ${JSON.stringify(Array.from(byType.keys()).map((k) => (typeColors as any)[k] ?? "#666"))} }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#888' } } } }
    });

    // Avg turns vs ideal
    const turnTypes = ${JSON.stringify(Array.from(byType.keys()).filter((k) => k !== "hangup"))};
    const turnLabels = turnTypes.map(t => (${JSON.stringify(typeLabels)})[t] || t);
    const turnActual = turnTypes.map(t => (${JSON.stringify(avgTurns)})[t]?.avg || 0);
    const turnIdealMin = turnTypes.map(t => (${JSON.stringify(IDEAL_TURNS)})[t]?.min || 0);
    const turnIdealMax = turnTypes.map(t => (${JSON.stringify(IDEAL_TURNS)})[t]?.max || 0);
    new Chart(document.getElementById('turnsChart'), {
      type: 'bar',
      data: {
        labels: turnLabels,
        datasets: [
          { label: 'Actual Avg', data: turnActual, backgroundColor: '#2196F3' },
          { label: 'Ideal Min', data: turnIdealMin, backgroundColor: 'rgba(76,175,80,0.3)', borderColor: '#4CAF50', borderWidth: 1 },
          { label: 'Ideal Max', data: turnIdealMax, backgroundColor: 'rgba(255,152,0,0.3)', borderColor: '#FF9800', borderWidth: 1 },
        ]
      },
      options: { ...chartDefaults, plugins: { legend: { labels: { color: '#888' } } } }
    });

    // Resolution rate
    const resTypes = ${JSON.stringify(Array.from(byType.keys()).filter((k) => k !== "hangup"))};
    new Chart(document.getElementById('resolutionChart'), {
      type: 'bar',
      data: {
        labels: resTypes.map(t => (${JSON.stringify(typeLabels)})[t] || t),
        datasets: [{ label: 'Resolution %', data: resTypes.map(t => (${JSON.stringify(resolutionRates)})[t]?.rate || 0), backgroundColor: resTypes.map(t => (${JSON.stringify(typeColors)})[t] || '#666') }]
      },
      options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, max: 100 } } }
    });

    // Tool usage
    const toolNames = ${JSON.stringify(Object.keys(toolFreq).sort((a, b) => toolFreq[b] - toolFreq[a]))};
    new Chart(document.getElementById('toolChart'), {
      type: 'bar',
      data: {
        labels: toolNames,
        datasets: [{ label: 'Times Used', data: toolNames.map(t => (${JSON.stringify(toolFreq)})[t] || 0), backgroundColor: '#90CAF9' }]
      },
      options: { ...chartDefaults, indexAxis: 'y' }
    });

    // Daily volume
    new Chart(document.getElementById('dailyChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(dailyRows.map((r) => r[0]))},
        datasets: [
          { label: 'Total', data: ${JSON.stringify(dailyRows.map((r) => parseInt(r[1])))}, borderColor: '#2196F3', tension: 0.3 },
          { label: 'Substantive', data: ${JSON.stringify(dailyRows.map((r) => parseInt(r[2])))}, borderColor: '#4CAF50', tension: 0.3 }
        ]
      },
      options: { ...chartDefaults }
    });
  </script>
</body>
</html>`;

  const outPath = join(import.meta.dirname, "report.html");
  writeFileSync(outPath, html);
  console.log(`Report written to: ${outPath}`);
  console.log(`Open: file://${outPath}`);

  // Also print summary to console
  console.log("\n=== Summary ===");
  console.log(`Total calls: ${calls.length} (${nonHangup.length} substantive)`);
  console.log(`Transfer rate: ${transferRate}% (${transferCalls.length}/${nonHangup.length})`);
  console.log(`Double transfers: ${doubleTransfers.length} calls`);
  for (const [type, data] of Object.entries(resolutionRates)) {
    console.log(`  ${type}: ${data.rate}% resolved (${data.resolved}/${data.total})`);
  }
}

main().catch(console.error);
