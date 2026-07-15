#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { generateSeenDescriptions } from "./descriptions.js";
import { createAtlasServer, openAtlasDb } from "./server.js";

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
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

if (!atlasIsIgnored(root)) {
  console.warn("[atlas] Hint: add .atlas/ to this project's .gitignore. Atlas will not modify the target project for you.");
}

if (args[0] === "describe") {
  const db = openAtlasDb(root);
  generateSeenDescriptions(db, root).then((result) => {
    console.log("[atlas] Description batch: " + result.generated + " generated, " + result.cached + " cached, " + result.unavailable + " unavailable.");
    db.close();
  }).catch((error) => {
    console.error("[atlas] " + (error instanceof Error ? error.message : error));
    db.close();
    process.exitCode = 1;
  });
} else {
  createAtlasServer(root, port).then(() => {
    console.log("[atlas] Inspecting at http://127.0.0.1:" + port);
  }).catch((error) => {
    console.error("[atlas] " + (error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
