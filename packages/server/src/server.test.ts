import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { clearTraceEvents } from "./server.js";

test("clears trace events without touching other Atlas data", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events (trace_id TEXT NOT NULL); CREATE TABLE descriptions (description TEXT NOT NULL);");
  db.prepare("INSERT INTO events (trace_id) VALUES (?), (?), (?)").run("trace-a", "trace-a", "trace-b");
  db.prepare("INSERT INTO descriptions (description) VALUES (?)").run("keep me");

  assert.deepEqual(clearTraceEvents(db), { deletedTraces: 2, deletedSpans: 3 });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM descriptions").get() as { count: number }).count, 1);
  db.close();
});
