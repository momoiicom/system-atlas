import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { refreshStaticGraph } from "./static-graph.js";
import { isTestModule } from "./source-files.js";

test("static graph resolves TypeScript through .js import specifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-static-"));
  mkdirSync(join(root, "node_modules", "external"), { recursive: true });
  writeFileSync(join(root, "node_modules", "external", "index.d.ts"), "export const external: string;");
  writeFileSync(join(root, "main.ts"), 'import { value } from "./value.js"; import { external } from "external"; export const result = value + external;');
  writeFileSync(join(root, "value.ts"), "export const value = 1;");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE static_graph (from_module TEXT NOT NULL, to_module TEXT NOT NULL, captured_at INTEGER NOT NULL)");
  const result = refreshStaticGraph(db, root);
  assert.deepEqual(result, { modules: 2, edges: 1 });
  assert.deepEqual(db.prepare("SELECT from_module, to_module FROM static_graph").all(), [{ from_module: "main.ts", to_module: "value.ts" }]);
  db.close();
});

test("static graph resolves local TypeScript path aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-static-alias-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  writeFileSync(join(root, "src", "main.ts"), 'import { value } from "@/value"; export const result = value;');
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE static_graph (from_module TEXT NOT NULL, to_module TEXT NOT NULL, captured_at INTEGER NOT NULL)");
  refreshStaticGraph(db, root);
  assert.deepEqual(db.prepare("SELECT from_module, to_module FROM static_graph").all(), [{ from_module: "src/main.ts", to_module: "src/value.ts" }]);
  db.close();
});

test("static graph keeps tests available while honoring other exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-static-config-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "generated"));
  writeFileSync(join(root, "atlas.config.ts"), 'export default { include: ["src/**"], exclude: ["src/**/*.test.ts", "src/generated/**"] };');
  writeFileSync(join(root, "outside.ts"), "export const outside = true;");
  writeFileSync(join(root, "src", "main.ts"), 'import { value } from "./value.js"; import { covered } from "./covered.test.js"; import { generated } from "./generated/output.js"; export const result = value + covered + generated;');
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;");
  writeFileSync(join(root, "src", "covered.test.ts"), "export const covered = 1;");
  writeFileSync(join(root, "src", "generated", "output.ts"), "export const generated = 1;");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE static_graph (from_module TEXT NOT NULL, to_module TEXT NOT NULL, captured_at INTEGER NOT NULL)");
  const result = refreshStaticGraph(db, root);
  assert.deepEqual(result, { modules: 3, edges: 2 });
  assert.deepEqual(db.prepare("SELECT from_module, to_module FROM static_graph ORDER BY to_module").all(), [
    { from_module: "src/main.ts", to_module: "src/covered.test.ts" },
    { from_module: "src/main.ts", to_module: "src/value.ts" },
  ]);
  db.close();
});

test("recognizes conventional test module paths", () => {
  assert.equal(isTestModule("src/api/server.test.ts"), true);
  assert.equal(isTestModule("src/__tests__/server.ts"), true);
  assert.equal(isTestModule("src/url/preflight-test-helpers.ts"), true);
  assert.equal(isTestModule("src/api/server.ts"), false);
});
