import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { diagnoseAtlas, diagnosticSourceEvidence, parseDiagnosticTime } from "./diagnostics.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      rowid INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT,
      module TEXT NOT NULL, fn TEXT NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL,
      args TEXT, result TEXT, error TEXT
    );
    CREATE TABLE static_graph (from_module TEXT NOT NULL, to_module TEXT NOT NULL, captured_at INTEGER NOT NULL);
  `);
  const insert = db.prepare("INSERT INTO events (trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("trace-a", "root", null, "src/api.ts", "handle", 1_000, 1_100, '[{"id":1}]', '{"ok":true}', null);
  insert.run("trace-a", "child", "root", "src/work.ts", "process", 1_010, 1_090, '[1]', null, "Error: broken\n at process");
  insert.run("trace-b", "other", null, "src/work.ts", "process", 1_200, 1_220, '[2]', "2", null);
  db.prepare("INSERT INTO static_graph (from_module, to_module, captured_at) VALUES (?, ?, ?), (?, ?, ?)").run("src/api.ts", "src/work.ts", 900, "src/api.ts", "src/unused.ts", 900);
  return db;
}

test("summarizes hotspots, errors, and graph evidence", () => {
  const db = fixture();
  const report = diagnoseAtlas(db, { now: 2_000, since: 0, until: 2_000, limit: 5 });
  assert.deepEqual(report.summary, { traces: 2, spans: 3, errors: 1, errorRate: 1 / 3, firstSeen: 1_000, lastSeen: 1_220 });
  assert.equal(report.hotspots[0].fn, "process");
  assert.equal(report.hotspots[0].calls, 2);
  assert.deepEqual(report.graph.rogueEdges, []);
  assert.equal(report.graph.ghostEdges[0].target, "src/unused.ts");
  db.close();
});

test("hides captured values unless explicitly requested", () => {
  const db = fixture();
  const hidden = diagnoseAtlas(db, { mode: "trace", traceId: "trace-a", now: 2_000, since: 0 });
  assert.equal(hidden.window, null);
  assert.equal(hidden.summary.spans, 2);
  assert.equal("arguments" in hidden.trace!.spans[0], false);
  assert.equal(hidden.trace!.spans[1].depth, 1);
  const shown = diagnoseAtlas(db, { mode: "trace", traceId: "trace-a", includeValues: true, now: 2_000, since: 0 });
  assert.deepEqual((shown.trace!.spans[0] as { arguments: unknown }).arguments, [{ id: 1 }]);
  db.close();
});

test("verifies expected calls and rejects observed errors", () => {
  const db = fixture();
  const failed = diagnoseAtlas(db, { mode: "verify", expectations: ["src/work.ts#process"], now: 2_000, since: 0 });
  assert.equal(failed.verification!.passed, false);
  assert.equal(failed.verification!.expectations[0].calls, 2);
  const passed = diagnoseAtlas(db, { mode: "verify", expectations: ["src/api.ts#handle"], module: "src/api.ts", now: 2_000, since: 0 });
  assert.equal(passed.verification!.passed, true);
  db.close();
});

test("parses relative, Unix, and ISO diagnostic times", () => {
  assert.equal(parseDiagnosticTime("10m", 1_000_000), 400_000);
  assert.equal(parseDiagnosticTime("1700000000"), 1_700_000_000_000);
  assert.equal(parseDiagnosticTime("2026-07-21T00:00:00Z"), Date.parse("2026-07-21T00:00:00Z"));
});

test("resolves observed functions to exact source definitions", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-diagnostic-source-"));
  try {
    writeFileSync(join(root, "worker.ts"), "const ignored = 1;\nexport function work(value: number) {\n  return value * 2;\n}\n");
    const sources = diagnosticSourceEvidence(root, [{ module: "worker.ts", fn: "work" }, { module: "worker.ts", fn: "work" }]);
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0].location, { line: 2, column: 1 });
    assert.match(sources[0].source!, /return value \* 2/);
    assert.equal(sources[0].file, join(root, "worker.ts"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
