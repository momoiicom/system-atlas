#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { generateSeenDescriptions } from "./descriptions.js";
import { diagnoseAtlas, diagnosticSourceEvidence, parseDiagnosticTime, type DiagnosticMode } from "./diagnostics.js";
import { createAtlasServer, openAtlasDb, resolveAtlasDbPath } from "./server.js";

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const values = (flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
const root = resolve(value("--project") || process.cwd());
const port = Number(value("--port") || process.env.ATLAS_PORT || 4400);
function atlasIsIgnored(projectRoot: string) {
  let directory = projectRoot;
  while (true) {
    const ignoreFile = resolve(directory, ".gitignore");
    if (existsSync(ignoreFile) && readFileSync(ignoreFile, "utf8").split(/\r?\n/).some((line) => line.trim() === ".atlas/" || line.trim() === ".atlas")) return true;
    if (existsSync(resolve(directory, ".git"))) return false;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function main() {
  if (args[0] === "diagnose") {
    const requestedMode = args[1] && !args[1].startsWith("-") ? args[1] : "overview";
    if (!["overview", "trace", "function", "verify"].includes(requestedMode)) throw new Error("Unknown diagnostic mode: " + requestedMode);
    const mode = requestedMode as DiagnosticMode;
    const now = Date.now();
    const traceId = value("--trace") || (mode === "trace" && args[2] && !args[2].startsWith("-") ? args[2] : undefined);
    const since = value("--since") ? parseDiagnosticTime(value("--since")!, now) : undefined;
    const until = value("--until") ? parseDiagnosticTime(value("--until")!, now) : undefined;
    const limit = value("--limit") ? Number(value("--limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer.");
    const dbPath = value("--db");
    const db = openAtlasDb(root, { readonly: true, dbPath });
    try {
      const report = diagnoseAtlas(db, {
        mode,
        now,
        since,
        until,
        limit,
        traceId,
        module: value("--module"),
        fn: value("--fn"),
        includeValues: args.includes("--include-values"),
        expectations: values("--expect"),
        allowErrors: args.includes("--allow-errors"),
      });
      const sources = args.includes("--include-source") ? diagnosticSourceEvidence(root, [
        ...report.hotspots,
        ...(report.trace?.spans ?? []),
        ...(value("--module") && value("--fn") ? [{ module: value("--module")!, fn: value("--fn")! }] : []),
      ]) : undefined;
      console.log(JSON.stringify({ ...report, ...(sources ? { sources } : {}), projectRoot: root, database: resolveAtlasDbPath(root, dbPath) }, null, 2));
      if (mode === "verify" && !report.verification?.passed) process.exitCode = 2;
    } finally { db.close(); }
  } else if (args[0] === "describe") {
    const db = openAtlasDb(root);
    try {
      const result = await generateSeenDescriptions(db, root);
      console.log("[atlas] Description batch: " + result.generated + " generated, " + result.cached + " cached, " + result.unavailable + " unavailable.");
    } finally { db.close(); }
  } else {
    if (!atlasIsIgnored(root)) console.warn("[atlas] Hint: add .atlas/ to this project's .gitignore. Atlas will not modify the target project for you.");
    await createAtlasServer(root, port);
    console.log("[atlas] Inspecting at http://127.0.0.1:" + port);
  }
}

main().catch((error) => {
  console.error("[atlas] " + (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
