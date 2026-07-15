import ts from "typescript";
import { atlasFileConfig } from "./llm-config.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const DEFAULT_EXCLUDES = ["node_modules/**", ".atlas/**", ".git/**", "dist/**"];

function typescriptGlob(pattern: string) {
  return pattern.endsWith("/**") ? pattern + "/*" : pattern;
}

function testPattern(pattern: string) {
  return /(^|[/.*_-])(tests?|specs?|__tests__)([/.*_-]|$)/i.test(pattern);
}

export function isTestModule(module: string) {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[^/]+$|-test-helpers?\.[^/]+$/i.test(module);
}

export function configuredSourcePaths(root: string, options: { includeTests?: boolean } = {}): string[] {
  const config = atlasFileConfig(root);
  const include = (config.include?.length ? config.include : ["**/*"]).map(typescriptGlob);
  const configuredExcludes = options.includeTests ? (config.exclude ?? []).filter((pattern) => !testPattern(pattern)) : (config.exclude ?? []);
  const exclude = [...DEFAULT_EXCLUDES, ...configuredExcludes].map(typescriptGlob);
  return ts.sys.readDirectory(root, SOURCE_EXTENSIONS, exclude, include);
}
