import { existsSync, readFileSync } from "node:fs";

import { defaultUsageLogPath, type UsageEvent } from "../src/usage-api.js";

type EventStats = {
  count: number;
  errorCount: number;
  firstTs: string;
  lastTs: string;
  durationsMs: number[];
  source: UsageEvent["source"];
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function daysAgo(ts: string): number {
  return Math.floor((Date.now() - Date.parse(ts)) / 86_400_000);
}

function lastUsedLabel(ts: string): string {
  const days = daysAgo(ts);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

const logPath = process.argv[2] ?? defaultUsageLogPath();
if (!existsSync(logPath)) {
  console.log(`No usage log at ${logPath} yet. Use the app for a bit, then rerun.`);
  process.exit(0);
}

const events = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .flatMap((line): UsageEvent[] => {
    try {
      const parsed = JSON.parse(line) as UsageEvent;
      return typeof parsed.name === "string" && typeof parsed.ts === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });

if (events.length === 0) {
  console.log(`Usage log at ${logPath} has no events yet.`);
  process.exit(0);
}

const byName = new Map<string, EventStats>();
for (const event of events) {
  const stats = byName.get(event.name) ?? { count: 0, errorCount: 0, firstTs: event.ts, lastTs: event.ts, durationsMs: [], source: event.source };
  stats.count += 1;
  if (event.ts < stats.firstTs) stats.firstTs = event.ts;
  if (event.ts > stats.lastTs) stats.lastTs = event.ts;
  const status = event.data?.status;
  if (typeof status === "number" && status >= 400) stats.errorCount += 1;
  const ms = event.data?.ms;
  if (typeof ms === "number") stats.durationsMs.push(ms);
  byName.set(event.name, stats);
}

const activeDays = new Set(events.map((event) => event.ts.slice(0, 10))).size;
console.log(`Usage log: ${logPath}`);
console.log(`${events.length} events over ${activeDays} active day(s), ${events[0].ts.slice(0, 10)} → ${events[events.length - 1].ts.slice(0, 10)}\n`);

const rows = [...byName.entries()].sort((a, b) => b[1].count - a[1].count);
const nameWidth = Math.max(...rows.map(([name]) => name.length), 5);
console.log(`${"event".padEnd(nameWidth)}  ${"count".padStart(5)}  ${"errors".padStart(6)}  ${"p50ms".padStart(6)}  ${"p95ms".padStart(6)}  last used`);
for (const [name, stats] of rows) {
  const sorted = [...stats.durationsMs].sort((a, b) => a - b);
  const p50 = sorted.length === 0 ? "" : String(quantile(sorted, 0.5));
  const p95 = sorted.length === 0 ? "" : String(quantile(sorted, 0.95));
  console.log(`${name.padEnd(nameWidth)}  ${String(stats.count).padStart(5)}  ${String(stats.errorCount).padStart(6)}  ${p50.padStart(6)}  ${p95.padStart(6)}  ${lastUsedLabel(stats.lastTs)}`);
}

const stale = rows.filter(([, stats]) => daysAgo(stats.lastTs) >= 14).map(([name]) => name);
if (stale.length > 0) console.log(`\nNot used in 14+ days: ${stale.join(", ")}`);

const friction = rows
  .filter(([, stats]) => stats.errorCount > 0)
  .sort((a, b) => b[1].errorCount / b[1].count - a[1].errorCount / a[1].count)
  .slice(0, 5);
if (friction.length > 0) {
  console.log("\nHighest error rates:");
  for (const [name, stats] of friction) console.log(`  ${name}: ${stats.errorCount}/${stats.count} (${Math.round((stats.errorCount / stats.count) * 100)}%)`);
}
