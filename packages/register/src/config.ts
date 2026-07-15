import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AtlasConfig } from "./types.js";

const require = createRequire(import.meta.url);
const defaults: AtlasConfig = { include: ["**/*"], exclude: ["node_modules/**"], capture: "values", redact: [/token|secret|password|authorization|apikey/i], dbPath: ".atlas/atlas.db", retentionHours: 24 };
type LooseConfig = Partial<Omit<AtlasConfig, "redact">> & { redact?: Array<RegExp | string> };

function readConfig(): LooseConfig {
  for (const name of ["atlas.config.json", "atlas.config.js", "atlas.config.ts"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    if (name.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8"));
    try {
      if (name.endsWith(".js")) {
        try { const loaded = require(path); return loaded.default ?? loaded; }
        catch {
          const mod: { exports: unknown } = { exports: {} };
          new Function("exports", "module", "require", readFileSync(path, "utf8").replace(/export\s+default\s+/, "module.exports = "))(mod.exports, mod, require);
          return mod.exports as LooseConfig;
        }
      }
      const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const mod: { exports: unknown } = { exports: {} };
      new Function("exports", "module", "require", source)(mod.exports, mod, require);
      return (mod.exports as { default?: LooseConfig }).default ?? mod.exports as LooseConfig;
    } catch (error) {
      console.warn(`[atlas] Could not read ${name}; using defaults: ${error instanceof Error ? error.message : error}`);
      return {};
    }
  }
  return {};
}

let cached: AtlasConfig | undefined;
export function atlasConfig(): AtlasConfig {
  if (cached) return cached;
  const file = readConfig();
  cached = { ...defaults, ...file, include: file.include ?? defaults.include, exclude: file.exclude ?? defaults.exclude, redact: [...defaults.redact, ...(file.redact ?? []).map((item) => typeof item === "string" ? new RegExp(item, "i") : item)] };
  return cached;
}
