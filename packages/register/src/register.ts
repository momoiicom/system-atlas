import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getAtlasRuntime } from "./runtime.js";
import { transformSource } from "./loader.js";

if (process.env.NODE_ENV === "production") {
  console.error("[atlas] Refusing to instrument a production process (NODE_ENV=production).");
} else {
  (globalThis as Record<symbol, unknown>)[Symbol.for("@atlas/runtime")] = getAtlasRuntime;
  const require = createRequire(import.meta.url);
  const Module = require("node:module") as { _extensions: Record<string, (module: { _compile: (source: string, filename: string) => void }, filename: string) => void> };
  for (const extension of [".cjs", ".js"]) {
    const original = Module._extensions[extension] ?? Module._extensions[".js"];
    Module._extensions[extension] = (module, filename) => {
      if (filename.includes("node_modules") || filename.includes("/@atlas/register/")) return original(module, filename);
      const transformed = transformSource(readFileSync(filename, "utf8"), filename, "commonjs");
      if (transformed) return module._compile(transformed, filename);
      return original(module, filename);
    };
  }
  register(new URL("./loader.js", import.meta.url), import.meta.url);
}
