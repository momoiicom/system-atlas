import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { sourceForFunction } from "./descriptions.js";

type EventRow = {
  rowid: number;
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  module: string;
  fn: string;
  t0: number;
  t1: number;
  args: string | null;
  result: string | null;
  error: string | null;
};

export type DiagnosticMode = "overview" | "trace" | "function" | "verify";

export type DiagnosticOptions = {
  mode?: DiagnosticMode;
  now?: number;
  since?: number;
  until?: number;
  limit?: number;
  traceId?: string;
  module?: string;
  fn?: string;
  includeValues?: boolean;
  expectations?: string[];
  allowErrors?: boolean;
};

export function diagnosticSourceEvidence(projectRoot: string, identities: Array<{ module: string; fn: string }>) {
  const unique = new Map(identities.map((identity) => [identity.module + "\0" + identity.fn, identity]));
  return [...unique.values()].map(({ module, fn }) => {
    const source = sourceForFunction(projectRoot, module, fn);
    return "source" in source
      ? { module, fn, available: true, file: resolve(projectRoot, module), location: source.location, hash: source.hash, source: source.source }
      : { module, fn, available: false };
  });
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function decodeCaptured(value: string | null) {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

function eventView(row: EventRow, includeValues: boolean, depth?: number) {
  return {
    rowid: row.rowid,
    traceId: row.trace_id,
    spanId: row.span_id,
    parentId: row.parent_id,
    module: row.module,
    fn: row.fn,
    startedAt: row.t0,
    durationMs: row.t1 - row.t0,
    ...(depth === undefined ? {} : { depth }),
    error: row.error,
    ...(includeValues
      ? { arguments: decodeCaptured(row.args), result: decodeCaptured(row.result) }
      : { hasArguments: row.args !== null, hasResult: row.result !== null }),
  };
}

function traceDepth(row: EventRow, rowsBySpan: Map<string, EventRow>, visiting = new Set<string>()): number {
  if (!row.parent_id) return 0;
  if (visiting.has(row.span_id)) return 0;
  const parent = rowsBySpan.get(row.parent_id);
  if (!parent) return 0;
  visiting.add(row.span_id);
  return traceDepth(parent, rowsBySpan, visiting) + 1;
}

function expectationParts(expectation: string) {
  const separator = expectation.lastIndexOf("#");
  if (separator <= 0 || separator === expectation.length - 1) {
    throw new Error("Invalid expectation '" + expectation + "'. Use <module>#<function>.");
  }
  return { module: expectation.slice(0, separator), fn: expectation.slice(separator + 1) };
}

export function parseDiagnosticTime(value: string, now = Date.now()) {
  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (duration) {
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return now - Number(duration[1]) * units[duration[2] as keyof typeof units];
  }
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error("Invalid time '" + value + "'. Use 10m, an ISO timestamp, or a Unix timestamp.");
  return parsed;
}

export function diagnoseAtlas(db: Database.Database, options: DiagnosticOptions = {}) {
  const now = options.now ?? Date.now();
  const since = options.since ?? now - 15 * 60_000;
  const until = options.until ?? now;
  if (since > until) throw new Error("The diagnostic start time must not be after the end time.");
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const mode = options.mode ?? "overview";
  if (mode === "trace" && !options.traceId) throw new Error("Trace diagnostics require --trace <trace-id>.");
  if (mode === "function" && !options.module) throw new Error("Function diagnostics require --module <module>.");

  const conditions = options.traceId ? ["trace_id = @traceId"] : ["t0 >= @since", "t0 <= @until"];
  const parameters: Record<string, string | number> = options.traceId ? { traceId: options.traceId } : { since, until };
  if (options.module) { conditions.push("module = @module"); parameters.module = options.module; }
  if (options.fn) { conditions.push("fn = @fn"); parameters.fn = options.fn; }
  const rows = db.prepare(`
    SELECT rowid, trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error
    FROM events
    WHERE ${conditions.join(" AND ")}
    ORDER BY t0 DESC, rowid DESC
  `).all(parameters) as EventRow[];

  const functionGroups = new Map<string, EventRow[]>();
  const traceGroups = new Map<string, EventRow[]>();
  for (const row of rows) {
    const functionKey = row.module + "\0" + row.fn;
    const functionEntries = functionGroups.get(functionKey);
    if (functionEntries) functionEntries.push(row);
    else functionGroups.set(functionKey, [row]);
    const traceEntries = traceGroups.get(row.trace_id);
    if (traceEntries) traceEntries.push(row);
    else traceGroups.set(row.trace_id, [row]);
  }

  const windowMinutes = Math.max((until - since) / 60_000, 1 / 60);
  const functions = [...functionGroups.values()].map((entries) => {
    const first = entries[0];
    const durations = entries.map((entry) => entry.t1 - entry.t0);
    const errors = entries.filter((entry) => entry.error !== null).length;
    return {
      module: first.module,
      fn: first.fn,
      calls: entries.length,
      callsPerMinute: options.traceId ? null : Number((entries.length / windowMinutes).toFixed(3)),
      errors,
      errorRate: entries.length ? errors / entries.length : 0,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: Math.max(...durations),
      lastSeen: Math.max(...entries.map((entry) => entry.t1)),
    };
  });
  const hotspots = [...functions].sort((a, b) => b.calls - a.calls || b.p95Ms - a.p95Ms).slice(0, limit);
  const slowFunctions = [...functions].sort((a, b) => b.p95Ms - a.p95Ms || b.calls - a.calls).slice(0, limit);

  const traces = [...traceGroups.entries()].map(([traceId, entries]) => ({
    traceId,
    startedAt: Math.min(...entries.map((entry) => entry.t0)),
    durationMs: Math.max(...entries.map((entry) => entry.t1)) - Math.min(...entries.map((entry) => entry.t0)),
    spans: entries.length,
    errors: entries.filter((entry) => entry.error !== null).length,
  })).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);

  const errorRows = rows.filter((row) => row.error !== null);
  const errorGroupMap = new Map<string, { module: string; fn: string; message: string; count: number; lastSeen: number; traceId: string }>();
  for (const row of errorRows) {
    const message = row.error!.split("\n", 1)[0];
    const key = row.module + "\0" + row.fn + "\0" + message;
    const current = errorGroupMap.get(key);
    if (current) current.count += 1;
    else errorGroupMap.set(key, { module: row.module, fn: row.fn, message, count: 1, lastSeen: row.t1, traceId: row.trace_id });
  }
  const errorGroups = [...errorGroupMap.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, limit);
  const recentErrors = errorRows.slice(0, limit).map((row) => ({
    traceId: row.trace_id,
    spanId: row.span_id,
    module: row.module,
    fn: row.fn,
    startedAt: row.t0,
    durationMs: row.t1 - row.t0,
    error: row.error,
  }));

  const rowsBySpan = new Map(rows.map((row) => [row.span_id, row]));
  const runtimeCounts = new Map<string, { source: string; target: string; calls: number }>();
  for (const row of rows) {
    if (!row.parent_id) continue;
    const parent = rowsBySpan.get(row.parent_id);
    if (!parent) continue;
    const key = parent.module + "\0" + row.module;
    const current = runtimeCounts.get(key);
    if (current) current.calls += 1;
    else runtimeCounts.set(key, { source: parent.module, target: row.module, calls: 1 });
  }
  let staticRows: Array<{ source: string; target: string }> = [];
  try {
    staticRows = db.prepare("SELECT from_module AS source, to_module AS target FROM static_graph").all() as Array<{ source: string; target: string }>;
  } catch { /* Older databases may not have a static graph yet. */ }
  const staticKeys = new Set(staticRows.map((edge) => edge.source + "\0" + edge.target));
  const runtimeEdges = [...runtimeCounts.entries()];
  const rogueEdges = runtimeEdges.filter(([key]) => !staticKeys.has(key)).map(([, edge]) => ({ ...edge, kind: "rogue" as const })).sort((a, b) => b.calls - a.calls).slice(0, limit);
  const liveKeys = new Set(runtimeEdges.map(([key]) => key));
  const ghostEdges = staticRows.filter((edge) => !liveKeys.has(edge.source + "\0" + edge.target)).map((edge) => ({ ...edge, calls: 0, kind: "ghost" as const })).slice(0, limit);

  let trace: { traceId: string; startedAt: number; durationMs: number; spans: ReturnType<typeof eventView>[] } | undefined;
  if (options.traceId) {
    const traceRows = db.prepare(`
      SELECT rowid, trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error
      FROM events WHERE trace_id = ? ORDER BY t0, rowid
    `).all(options.traceId) as EventRow[];
    if (!traceRows.length) throw new Error("Trace not found: " + options.traceId);
    const traceRowsBySpan = new Map(traceRows.map((row) => [row.span_id, row]));
    trace = {
      traceId: options.traceId,
      startedAt: Math.min(...traceRows.map((row) => row.t0)),
      durationMs: Math.max(...traceRows.map((row) => row.t1)) - Math.min(...traceRows.map((row) => row.t0)),
      spans: traceRows.map((row) => eventView(row, options.includeValues ?? false, traceDepth(row, traceRowsBySpan))),
    };
  }

  const expectations = (options.expectations ?? []).map((value) => {
    const expected = expectationParts(value);
    const matches = rows.filter((row) => row.module === expected.module && row.fn === expected.fn);
    return { ...expected, observed: matches.length > 0, calls: matches.length, errors: matches.filter((row) => row.error !== null).length };
  });
  const errorFree = errorRows.length === 0;
  const verification = mode === "verify" ? {
    passed: rows.length > 0 && expectations.every((expectation) => expectation.observed) && (options.allowErrors || errorFree),
    observedSpans: rows.length,
    errorFree,
    expectations,
  } : undefined;

  return {
    schemaVersion: 1,
    mode,
    generatedAt: now,
    window: options.traceId ? null : { since, until, durationMs: until - since },
    filters: { module: options.module ?? null, fn: options.fn ?? null, traceId: options.traceId ?? null },
    summary: {
      traces: traceGroups.size,
      spans: rows.length,
      errors: errorRows.length,
      errorRate: rows.length ? errorRows.length / rows.length : 0,
      firstSeen: rows.length ? Math.min(...rows.map((row) => row.t0)) : null,
      lastSeen: rows.length ? Math.max(...rows.map((row) => row.t1)) : null,
    },
    traces,
    hotspots,
    slowFunctions,
    errorGroups,
    recentErrors,
    graph: { rogueEdges, ghostEdges },
    ...(trace ? { trace } : {}),
    ...(verification ? { verification } : {}),
    caveats: [
      "Atlas records instrumented exported functions and class methods, not every log line or internal call.",
      "An absent span means the call was not observed in this database and selection; it does not prove the call never happened.",
      ...(options.includeValues ? [] : ["Captured arguments and results are hidden; rerun with --include-values only when needed."]),
    ],
  };
}
