import path from "node:path";

/** Source files Agent Together can read imports from: JS/TS and Python (regexes for now; tree-sitter comes later). */
export const SOURCE_FILE = /\.([cm]?[jt]sx?|py)$/;

const isPython = (file?: string) => !!file && file.endsWith(".py");

// import x from "y" · import "y" · export * from "y" · require("y") · import("y")
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

// Python, at the start of a line: "import a.b, c as d" and "from ..a.b import x, (y, z)".
const PY_IMPORT = /^[ \t]*import[ \t]+([\w., \t]+)/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([\w., \t*]+)/gm;

// Directory forms first: "../db" is far more often src/db/index.ts than src/db.ts.
const SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ""];

/**
 * The modules a file imports. JS/TS: the quoted specifiers. Python (when `file` ends
 * in .py): dotted names, with leading dots for relative imports; for `from m import n`
 * both "m" and "m.n" (n may be a submodule), so a reader can try both.
 */
export function importSpecifiers(code: string | undefined, file?: string): Set<string> {
  const text = code ?? "";
  if (!isPython(file)) return new Set([...text.matchAll(SPECIFIER)].map((m) => m[1]));
  const found = new Set<string>();
  for (const m of text.matchAll(PY_IMPORT)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) found.add(name);
    }
  }
  for (const m of text.matchAll(PY_FROM)) {
    const module = m[1];
    if (module.replace(/\./g, "")) found.add(module);
    for (const part of m[2].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name && name !== "*") found.add(module.endsWith(".") || !module ? `${module}${name}` : `${module}.${name}`);
    }
  }
  return found;
}

/** Files a Python module name may live in, relative to `base` ("" = project root). */
function pythonFiles(base: string, dotted: string): string[] {
  const rel = path.posix.join(base, ...dotted.split(".").filter(Boolean));
  return [`${rel}.py`, `${rel}/__init__.py`];
}

/**
 * Project-relative posix paths an import may point at, best guess first.
 * JS/TS, relative imports only: files that exist first, then directory forms, then
 * file forms; empty for packages. Python: only files that exist, for relative imports
 * from the importing file's package and for absolute ones from the root or src/
 * (third-party modules match nothing).
 */
export function importCandidates(fromFile: string, spec: string, exists: (rel: string) => boolean): string[] {
  if (isPython(fromFile)) {
    const dots = /^\.*/.exec(spec)![0].length;
    const module = spec.slice(dots);
    const bases = dots
      ? [path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), ...Array(dots - 1).fill(".."))).replace(/^\.$/, "")]
      : ["", "src"];
    const files = bases.flatMap((b) => (module ? pythonFiles(b, module) : [path.posix.join(b, "__init__.py")]));
    return files.filter(exists);
  }
  if (!spec.startsWith(".")) return [];
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const all = SUFFIXES.map((s) => target + s);
  return [...all.filter(exists), ...all.filter((c) => !exists(c))];
}
