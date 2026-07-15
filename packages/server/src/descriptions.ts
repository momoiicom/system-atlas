import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { llmSettings, type ResolvedLlmSettings } from "./llm-config.js";
import { configuredSourcePaths } from "./source-files.js";

type DescriptionRow = { description: string; source_hash: string; created_at: number };
export type FunctionSource = { module: string; fn: string; source: string; hash: string; location: { line: number; column: number } };
function exported(node: ts.Node) {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function publicMethod(member: ts.ClassElement): member is ts.MethodDeclaration {
  return ts.isMethodDeclaration(member) && !!member.body && !ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
}

function functionName(member: ts.MethodDeclaration) {
  return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
}

function cjsExportName(node: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (ts.isIdentifier(node.expression) && node.expression.text === "exports") return node.name.text;
  if (node.name.text !== "exports" || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "module") return null;
  return "default";
}

export function discoverFunctions(projectRoot: string, onlyModule?: string) {
  const result: Array<{ module: string; fn: string }> = [];
  const files = onlyModule ? [resolve(projectRoot, onlyModule)] : configuredSourcePaths(projectRoot);
  for (const path of files) {
    if (!existsSync(path)) continue;
    const module = relative(projectRoot, path).replaceAll("\\", "/");
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && exported(statement)) result.push({ module, fn: statement.name?.text ?? "default" });
      if (ts.isVariableStatement(statement) && exported(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) result.push({ module, fn: declaration.name.text });
      if (ts.isClassDeclaration(statement) && exported(statement)) {
        const className = statement.name?.text ?? "default";
        for (const member of statement.members) if (publicMethod(member)) result.push({ module, fn: className + "." + functionName(member) });
      }
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const name = cjsExportName(statement.expression.left);
        const right = statement.expression.right;
        if (name && (ts.isFunctionExpression(right) || ts.isArrowFunction(right))) result.push({ module, fn: name });
        if (name && ts.isClassExpression(right)) for (const member of right.members) if (publicMethod(member)) result.push({ module, fn: name + "." + functionName(member) });
      }
    }
  }
  return result;
}

function sourceFile(projectRoot: string, module: string) {
  const root = resolve(projectRoot);
  const path = resolve(root, module);
  if (!path.startsWith(root) || !existsSync(path)) return null;
  return { path, text: readFileSync(path, "utf8") };
}

function declarationSource(projectRoot: string, module: string, fn: string): FunctionSource | null {
  const loaded = sourceFile(projectRoot, module);
  if (!loaded) return null;
  const file = ts.createSourceFile(loaded.path, loaded.text, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fn) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fn && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found = node;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && cjsExportName(node.left) === fn && (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) found = node.right;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isClassExpression(node.right)) {
      const className = cjsExportName(node.left);
      for (const member of node.right.members) if (className && publicMethod(member) && className + "." + functionName(member) === fn) found = member;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(file);
        if (node.name.text + "." + name === fn) found = member;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) return null;
  const start = found.getStart(file);
  const source = loaded.text.slice(start, found.end);
  const position = file.getLineAndCharacterOfPosition(start);
  return { module, fn, source, hash: createHash("sha256").update(source).digest("hex"), location: { line: position.line + 1, column: position.character + 1 } };
}

export function sourceForFunction(projectRoot: string, module: string, fn: string) {
  const source = declarationSource(projectRoot, module, fn);
  return source ? { available: true, ...source } : { available: false };
}

export function descriptionState(db: Database.Database, projectRoot: string, module: string, fn: string) {
  const current = declarationSource(projectRoot, module, fn);
  if (!current) return { available: false, description: null, stale: false, sourceHash: null };
  const row = db.prepare("SELECT description, source_hash, created_at FROM descriptions WHERE module = ? AND fn = ? AND source_hash = ?").get(module, fn, current.hash) as DescriptionRow | undefined;
  const older = db.prepare("SELECT 1 FROM descriptions WHERE module = ? AND fn = ? LIMIT 1").get(module, fn);
  return { available: true, description: row?.description ?? null, stale: !row && !!older, sourceHash: current.hash, createdAt: row?.created_at ?? null, source: current };
}

function descriptionPrompt(source: FunctionSource) {
  return "Describe this function's intended behavior in one to three concise sentences. Return only the description. Do not inspect files, run commands, call tools, mention that you are an AI, or infer behavior not present in the source.\n\nModule: " + source.module + "\nFunction: " + source.fn + "\n\n" + source.source;
}

function askCodex(settings: Extract<ResolvedLlmSettings, { provider: "codex" }>, source: FunctionSource, projectRoot: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const args = ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-C", projectRoot];
    if (settings.model) args.push("--model", settings.model);
    args.push("-");
    const child = spawn(settings.command, args, { cwd: projectRoot, env: { ...process.env, CODEX_HOME: settings.codexHome }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Codex description timed out")); }, 120_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-4_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolvePromise(output.trim());
      else reject(new Error("Codex description failed" + (errors.trim() ? ": " + errors.trim() : "")));
    });
    child.stdin.end(descriptionPrompt(source));
  });
}

async function askModel(source: FunctionSource, projectRoot: string) {
  const settings = llmSettings(projectRoot);
  if (!settings) return null;
  if (settings.provider === "codex") return askCodex(settings, source, projectRoot);
  const response = await fetch(settings.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + settings.key },
    body: JSON.stringify({
      model: settings.model || undefined,
      messages: [
        { role: "user", content: descriptionPrompt(source) },
      ],
    }),
  });
  if (!response.ok) throw new Error("LLM returned " + response.status);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; output?: string; description?: string };
  const text = body.choices?.[0]?.message?.content ?? body.output ?? body.description;
  return typeof text === "string" ? text.trim() : null;
}

export async function generateDescription(db: Database.Database, projectRoot: string, module: string, fn: string) {
  const state = descriptionState(db, projectRoot, module, fn);
  if (!state.available) return { ...state, generated: false, reason: "source_not_found" };
  if (state.description) return { ...state, generated: false, reason: "cached" };
  const description = await askModel(state.source as FunctionSource, projectRoot);
  if (!description) return { ...state, generated: false, reason: "not_configured" };
  db.prepare("INSERT OR REPLACE INTO descriptions (module, fn, source_hash, description, created_at) VALUES (?, ?, ?, ?, ?)").run(module, fn, state.sourceHash, description, Date.now());
  return { ...descriptionState(db, projectRoot, module, fn), generated: true, reason: "generated" };
}

export async function generateSeenDescriptions(db: Database.Database, projectRoot: string) {
  const observed = db.prepare("SELECT DISTINCT module, fn FROM events").all() as Array<{ module: string; fn: string }>;
  const functions = [...new Map([...observed, ...discoverFunctions(projectRoot)].map((entry) => [entry.module + "\0" + entry.fn, entry])).values()].sort((a, b) => a.module.localeCompare(b.module) || a.fn.localeCompare(b.fn));
  const result = { attempted: functions.length, generated: 0, cached: 0, unavailable: 0 };
  for (const entry of functions) {
    const description = await generateDescription(db, projectRoot, entry.module, entry.fn);
    if (description.reason === "generated") result.generated++;
    else if (description.reason === "cached") result.cached++;
    else result.unavailable++;
  }
  return result;
}
