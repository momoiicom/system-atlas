import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { descriptionState, discoverFunctions, sourceForFunction } from "./descriptions.js";

test("description state marks a changed function as stale", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-description-"));
  const file = join(root, "worker.ts");
  writeFileSync(file, "export function work() { return 1; }");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE descriptions (module TEXT NOT NULL, fn TEXT NOT NULL, source_hash TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(module, fn, source_hash))");
  const first = descriptionState(db, root, "worker.ts", "work");
  assert.equal(first.available, true);
  assert.deepEqual(sourceForFunction(root, "worker.ts", "work"), { available: true, module: "worker.ts", fn: "work", source: "export function work() { return 1; }", hash: first.sourceHash, location: { line: 1, column: 1 } });
  db.prepare("INSERT INTO descriptions VALUES (?, ?, ?, ?, ?)").run("worker.ts", "work", first.sourceHash, "Returns one.", Date.now());
  assert.equal(descriptionState(db, root, "worker.ts", "work").description, "Returns one.");
  writeFileSync(file, "export function work() { return 2; }");
  const changed = descriptionState(db, root, "worker.ts", "work");
  assert.equal(changed.description, null);
  assert.equal(changed.stale, true);
  db.close();
});

test("static discovery includes CommonJS function and class-method exports", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-cjs-description-"));
  writeFileSync(join(root, "math.cjs"), "exports.double = function double(value) { return value * 2; }; exports.Calculator = class Calculator { increment(value) { return value + 1; } };");
  assert.deepEqual(discoverFunctions(root), [
    { module: "math.cjs", fn: "double" },
    { module: "math.cjs", fn: "Calculator.increment" },
  ]);
});
