import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import MagicString from "magic-string";
import { minimatch } from "minimatch";
import { atlasConfig } from "./config.js";

const ownPath = fileURLToPath(new URL(".", import.meta.url));
const runtimeUrl = new URL("./runtime.js", import.meta.url).href;
const skipped = /node_modules|@system-atlas[\\/]register|\.json$|\.wasm$/;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
}

function methodName(node: ts.MethodDeclaration) {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText();
}

function cjsExportName(node: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (ts.isIdentifier(node.expression) && node.expression.text === "exports") return node.name.text;
  if (node.name.text !== "exports" || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "module") return null;
  return "default";
}

export function transformSource(source: string, filename: string, format: string | undefined) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edit = new MagicString(source);
  const moduleName = relative(process.cwd(), filename).replaceAll("\\", "/");
  const config = atlasConfig();
  if (!config.include.some((pattern) => minimatch(moduleName, pattern)) || config.exclude.some((pattern) => minimatch(moduleName, pattern))) return null;
  let changed = false;
  let ordinal = 0;
  const cjsClasses = new Map<string, string>();
  if (format === "commonjs") {
    for (const statement of ast.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const name = cjsExportName(statement.expression.left);
      if (name && ts.isIdentifier(statement.expression.right)) cjsClasses.set(statement.expression.right.text, name);
    }
  }
  const runtime = "__atlas_runtime";
  const meta = (fn: string) => `{ module: ${JSON.stringify(moduleName)}, fn: ${JSON.stringify(fn)} }`;

  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const original = statement.name?.text || `default_${ordinal++}`;
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const privateName = `__atlas_original_${original}`;
      if (statement.name) {
        for (const modifier of statement.modifiers || []) if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) edit.remove(modifier.getStart(ast), modifier.end);
        edit.overwrite(statement.name.getStart(ast), statement.name.end, privateName);
        edit.appendRight(statement.end, `\n${isDefault ? "export default" : `export const ${original} =`} ${runtime}.wrap(${privateName}, ${meta(original)});\n`);
      } else if (isDefault) {
        const fnStart = statement.getStart(ast);
        const functionStart = source.indexOf("function", fnStart);
        const asyncPrefix = hasModifier(statement, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
        edit.overwrite(fnStart, statement.end, `const ${privateName} = ${asyncPrefix}${source.slice(functionStart, statement.end)}\nexport default ${runtime}.wrap(${privateName}, ${meta("default")});`);
      }
      changed = true;
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))) continue;
        edit.appendLeft(declaration.initializer.getStart(ast), runtime + ".wrap(");
        edit.appendRight(declaration.initializer.end, ", " + meta(declaration.name.text) + ")");
        changed = true;
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))) {
      edit.appendLeft(statement.expression.getStart(ast), runtime + ".wrap(");
      edit.appendRight(statement.expression.end, ", " + meta("default") + ")");
      changed = true;
    }
    if (ts.isClassDeclaration(statement) && statement.members.length && (hasModifier(statement, ts.SyntaxKind.ExportKeyword) || (statement.name && cjsClasses.has(statement.name.text)))) {
      const className = statement.name ? cjsClasses.get(statement.name.text) ?? statement.name.text : "default";
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword) || member.asteriskToken) continue;
        const bodyStart = member.body.getStart(ast) + 1;
        const bodyEnd = member.body.end - 1;
        edit.appendLeft(bodyStart, ` return ${runtime}.call(${meta(`${className}.${methodName(member)}`)}, this, arguments, () => {`);
        edit.appendRight(bodyEnd, " }); ");
        changed = true;
      }
    }
    if (format === "commonjs" && ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = cjsExportName(statement.expression.left);
      const right = statement.expression.right;
      if (name && (ts.isFunctionExpression(right) || ts.isArrowFunction(right) || ts.isIdentifier(right))) {
        edit.appendLeft(right.getStart(ast), runtime + ".wrap(");
        edit.appendRight(right.end, ", " + meta(name) + ");");
        changed = true;
      }
      if (name && ts.isClassExpression(right)) {
        for (const member of right.members) {
          if (!ts.isMethodDeclaration(member) || !member.body || hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword) || member.asteriskToken) continue;
          const bodyStart = member.body.getStart(ast) + 1;
          const bodyEnd = member.body.end - 1;
          edit.appendLeft(bodyStart, " return " + runtime + ".call(" + meta(name + "." + methodName(member)) + ", this, arguments, () => {");
          edit.appendRight(bodyEnd, " }); ");
          changed = true;
        }
      }
    }
  }
  if (!changed) return null;
  const prelude = format === "commonjs"
    ? "const " + runtime + " = globalThis[Symbol.for(\"@system-atlas/runtime\")]();\n"
    : "import { getAtlasRuntime as __atlas_get_runtime } from " + JSON.stringify(runtimeUrl) + ";\nconst " + runtime + " = __atlas_get_runtime();\n";
  edit.prepend(prelude);
  const map = edit.generateMap({ hires: true, includeContent: true, source: filename, file: filename + ".map" }).toString();
  return edit.toString() + "\n//# sourceMappingURL=data:application/json;base64," + Buffer.from(map).toString("base64") + "\n";
}

export async function load(url: string, context: { format?: string }, nextLoad: Function) {
  const result = await nextLoad(url, context);
  const raw = typeof result.source === "string" ? result.source : result.source instanceof Uint8Array ? Buffer.from(result.source).toString("utf8") : context.format === "commonjs" && url.startsWith("file:") ? readFileSync(fileURLToPath(url), "utf8") : null;
  if (!url.startsWith("file:") || skipped.test(url) || fileURLToPath(url).startsWith(ownPath) || !raw) return result;
  const source = transformSource(raw, fileURLToPath(url), context.format);
  return source ? { ...result, source, shortCircuit: true } : result;
}
