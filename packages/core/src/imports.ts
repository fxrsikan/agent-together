import path from "node:path";

/** JS/TS source files Agent Together can read imports from (v0.1; tree-sitter comes later). */
export const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

// import x from "y" · import "y" · export * from "y" · require("y") · import("y")
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

// Directory forms first: "../db" is far more often src/db/index.ts than src/db.ts.
const SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ""];

export function importSpecifiers(code: string | undefined): Set<string> {
  return new Set([...(code ?? "").matchAll(SPECIFIER)].map((m) => m[1]));
}

/**
 * Project-relative posix paths a relative import may point at, best guess first:
 * files that exist come first, then directory forms, then file forms. Empty for packages.
 */
export function importCandidates(fromFile: string, spec: string, exists: (rel: string) => boolean): string[] {
  if (!spec.startsWith(".")) return [];
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const all = SUFFIXES.map((s) => target + s);
  return [...all.filter(exists), ...all.filter((c) => !exists(c))];
}
