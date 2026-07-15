import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { transformSource } from "./loader.js";

test("transforms ESM exports and emits an inline source map", () => {
  const output = transformSource("export function add(a, b) { return a + b; }", resolve(process.cwd(), "src/math.ts"), "module")!;
  assert.match(output, /__atlas_runtime\.wrap/);
  assert.match(output, /sourceMappingURL=data:application\/json;base64/);
});

test("transforms CommonJS function exports", () => {
  const output = transformSource("exports.add = function add(a, b) { return a + b; };", resolve(process.cwd(), "math.cjs"), "commonjs")!;
  assert.match(output, /globalThis\[Symbol\.for\("@system-atlas\/runtime"\)\]/);
  assert.match(output, /__atlas_runtime\.wrap/);
});

test("transforms exported arrow functions and default expressions", () => {
  const filename = resolve(process.cwd(), "src/callbacks.ts");
  const output = transformSource("export const plusOne = (value) => value + 1; export default (value) => value * 2;", filename, "module")!;
  assert.match(output, /plusOne = __atlas_runtime\.wrap/);
  assert.match(output, /export default __atlas_runtime\.wrap/);
});
