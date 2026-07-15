import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve, dirname, join } from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { configuredSourcePaths } from "./source-files.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function compilerOptions(root: string) {
  const config = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  return config ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, dirname(config)).options : {};
}

function localModule(root: string, from: string, specifier: string, options: ts.CompilerOptions): string | null {
  const resolvedByTypeScript = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule?.resolvedFileName;
  if (resolvedByTypeScript && SOURCE_EXTENSIONS.has(extname(resolvedByTypeScript))) {
    const module = relative(root, resolvedByTypeScript).replaceAll("\\", "/");
    if (!module.startsWith("../") && !module.includes("node_modules/")) return module;
  }
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const specifiedExtension = extname(base);
  const candidates = [
    base,
    ...(specifiedExtension ? RESOLUTION_EXTENSIONS.map((extension) => base.slice(0, -specifiedExtension.length) + extension) : []),
    ...RESOLUTION_EXTENSIONS.map((extension) => base + extension),
    ...RESOLUTION_EXTENSIONS.map((extension) => join(base, "index" + extension)),
  ];
  const resolved = candidates.find(existsSync);
  if (!resolved || !SOURCE_EXTENSIONS.has(extname(resolved))) return null;
  const module = relative(root, resolved).replaceAll("\\", "/");
  return module.startsWith("../") ? null : module;
}

function staticSpecifiers(source: string, filename: string) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isIdentifier(node.expression) && node.expression.text === "require" && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

export type StaticGraphResult = { modules: number; edges: number };

/** TypeScript's parser keeps the dependency surface small and handles TS/JS syntax without project compilation. */
export function refreshStaticGraph(db: Database.Database, projectRoot: string): StaticGraphResult {
  const capturedAt = Date.now();
  const rows: Array<{ from: string; to: string }> = [];
  const options = compilerOptions(projectRoot);
  const sourceFiles = configuredSourcePaths(projectRoot, { includeTests: true });
  const included = new Set(sourceFiles.map((filename) => relative(projectRoot, filename).replaceAll("\\", "/")));
  for (const filename of sourceFiles) {
    const source = readFileSync(filename, "utf8");
    const from = relative(projectRoot, filename).replaceAll("\\", "/");
    for (const specifier of staticSpecifiers(source, filename)) {
      const to = localModule(projectRoot, filename, specifier, options);
      if (to && included.has(to)) rows.push({ from, to });
    }
  }
  const unique = [...new Map(rows.map((row) => [row.from + "\0" + row.to, row])).values()];
  const write = db.transaction(() => {
    db.prepare("DELETE FROM static_graph").run();
    const insert = db.prepare("INSERT INTO static_graph (from_module, to_module, captured_at) VALUES (?, ?, ?)");
    for (const edge of unique) insert.run(edge.from, edge.to, capturedAt);
  });
  write();
  return { modules: new Set(unique.flatMap((edge) => [edge.from, edge.to])).size, edges: unique.length };
}
