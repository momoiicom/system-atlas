import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

type LlmSettings = { url?: string; key?: string; model?: string };
export type ResolvedLlmSettings =
  | { provider: "http"; url: string; key: string; model: string }
  | { provider: "codex"; command: string; codexHome: string; model: string };
export type AtlasFile = { llm?: LlmSettings; dbPath?: string; include?: string[]; exclude?: string[] };
const require = createRequire(import.meta.url);

export function atlasFileConfig(projectRoot: string): AtlasFile {
  for (const name of ["atlas.config.json", "atlas.config.js", "atlas.config.ts"]) {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) continue;
    try {
      if (name.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8")) as AtlasFile;
      const source = name.endsWith(".ts")
        ? ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
        : readFileSync(path, "utf8").replace(/export\s+default\s+/, "module.exports = ");
      const mod: { exports: unknown } = { exports: {} };
      new Function("exports", "module", "require", source)(mod.exports, mod, require);
      return ((mod.exports as { default?: AtlasFile }).default ?? mod.exports) as AtlasFile;
    } catch (error) {
      console.warn("[atlas] Could not read " + name + " for LLM settings: " + (error instanceof Error ? error.message : error));
      return {};
    }
  }
  return {};
}

function executable(name: string, path = process.env.PATH ?? "") {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

function hasCodexFileAuth(codexHome: string) {
  const path = resolve(codexHome, "auth.json");
  if (!existsSync(path)) return false;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
    return typeof auth.OPENAI_API_KEY === "string" || typeof auth.tokens?.access_token === "string";
  } catch { return false; }
}

export function llmSettings(projectRoot: string, env: NodeJS.ProcessEnv = process.env): ResolvedLlmSettings | null {
  const config = atlasFileConfig(projectRoot).llm ?? {};
  const url = env.ATLAS_LLM_URL ?? config.url;
  const key = env.ATLAS_LLM_KEY ?? config.key;
  const model = env.ATLAS_LLM_MODEL ?? config.model ?? "";
  if (url && key) return { provider: "http", url, key, model };

  const codexHome = resolve(env.CODEX_HOME ?? resolve(homedir(), ".codex"));
  const command = executable(process.platform === "win32" ? "codex.exe" : "codex", env.PATH);
  return command && hasCodexFileAuth(codexHome) ? { provider: "codex", command, codexHome, model } : null;
}
