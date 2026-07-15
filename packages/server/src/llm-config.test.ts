import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atlasFileConfig, llmSettings } from "./llm-config.js";

test("reads server settings from atlas.config.json", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-config-"));
  writeFileSync(join(root, "atlas.config.json"), JSON.stringify({ dbPath: ".state/atlas.db", llm: { url: "http://localhost:9999", key: "key", model: "model" } }));
  assert.deepEqual(atlasFileConfig(root), { dbPath: ".state/atlas.db", llm: { url: "http://localhost:9999", key: "key", model: "model" } });
  assert.deepEqual(llmSettings(root, { PATH: "" }), { provider: "http", url: "http://localhost:9999", key: "key", model: "model" });
});

test("falls back to an authenticated Codex installation without exposing its token", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-codex-"));
  const codexHome = join(root, ".codex"), bin = join(root, "bin"), command = join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  mkdirSync(codexHome); mkdirSync(bin);
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "secret-token" } }));
  writeFileSync(command, "#!/bin/sh\n"); chmodSync(command, 0o755);
  assert.deepEqual(llmSettings(root, { CODEX_HOME: codexHome, PATH: bin }), { provider: "codex", command, codexHome, model: "" });
});
