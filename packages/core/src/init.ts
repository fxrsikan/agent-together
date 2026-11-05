import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Canvas, type CanvasEdge, type CanvasNode } from "@agent-together/schema";
import { importCandidates, importSpecifiers, SOURCE_FILE } from "./imports.js";
import { ownerOf } from "./owners.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-together", ".claude", ".codex", ".cursor", "dist", "out", "build", "coverage", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "target", ".gradle"]);
const MAX_SOURCE_BYTES = 512 * 1024;

/** Project files as posix paths: git's view (tracked + untracked, minus ignored) when available. */
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(rel);
        } else files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";

/** Workspace packages: every directory below the root holding a package.json. */
function findPackages(root: string, files: string[]): { dir: string; name: string }[] {
  return files
    .filter((f) => f.endsWith("/package.json") && !f.split("/").some((p) => SKIP_DIRS.has(p)))
    .map((f) => {
      const dir = f.slice(0, -"/package.json".length);
      let name = dir;
      try {
        name = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")).name ?? dir;
      } catch {}
      return { dir, name };
    })
    .sort((a, b) => b.dir.length - a.dir.length); // innermost first
}

interface Group {
  key: string;
  title: string;
  globs: string[];
  pkg?: string;
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);
/** Package entry files: they belong with their package, not on a card of their own. */
const ENTRY_FILE = /^(__init__\.py|index\.[cm]?[jt]sx?)$/;
/** Below this many source files directly in it, a lone source folder stays one card. */
const SPLIT_AT = 3;

/** The module a test file is about: "tests/test_job_queue.py" → "job_queue", "store.test.ts" → "store"; null when not one. */
function testedName(file: string): string | null {
  const name = file.split("/").pop()!;
  const m = /^test_(.+)\.py$/.exec(name) ?? /^(.+)_test\.(py|go)$/.exec(name) ?? /^(.+)\.(test|spec)\.[cm]?[jt]sx?$/.exec(name);
  return m ? m[1] : null;
}
const isTest = (file: string) => testedName(file) !== null || file.split("/").some((p) => TEST_DIRS.has(p));
const stem = (file: string) => file.split("/").pop()!.replace(/\.[^.]+$/, "");

/** Whether a glob of the forms this generator writes ("a/**", "a/*", "*", "a/b.py") covers a file. */
function covers(glob: string, file: string): boolean {
  if (glob.endsWith("/**")) return file.startsWith(glob.slice(0, -2));
  if (glob === "*") return !file.includes("/");
  if (glob.endsWith("/*")) return file.startsWith(glob.slice(0, -1)) && !file.slice(glob.length - 1).includes("/");
  return glob === file;
}

/**
 * First-pass canvas from code. In a monorepo each workspace package is a node;
 * otherwise each top-level directory of the source root (src/ when most code
 * lives there) is, and other top-level folders with code (scripts/…) get their
 * own. A lone source folder with several modules (a flat Python package) is split
 * into one card per module. Test files go to the card of the module they test
 * (tests/test_store.py → store), else to one tests card. Edges come from imports
 * between cards (JS/TS relative and workspace imports, Python imports).
 * Naming the cards and writing their goals is left to the user or the helper model.
 */
export function generateCanvas(root: string, files: string[]): Canvas {
  const sources = files.filter((f) => SOURCE_FILE.test(f) && !f.split("/").some((p) => SKIP_DIRS.has(p)));
  const pool = sources.length ? sources : files;
  const packages = findPackages(root, files);
  const loose = pool.filter((f) => !packages.some((p) => f.startsWith(`${p.dir}/`)));
  const code = loose.filter((f) => !isTest(f));
  const base = code.filter((f) => f.startsWith("src/")).length * 2 >= code.length && code.length ? "src/" : "";

  const groups = new Map<string, Group>();
  const add = (key: string, title: string, glob: string, pkg?: string) => {
    const g = groups.get(key) ?? { key, title, globs: [], pkg };
    if (!g.globs.includes(glob)) g.globs.push(glob);
    groups.set(key, g);
  };
  for (const f of pool) {
    const pkg = packages.find((p) => f.startsWith(`${p.dir}/`));
    if (pkg) add(pkg.dir, pkg.name, `${pkg.dir}/**`, pkg.name);
  }
  for (const f of sources.length ? code : loose) {
    if (f.startsWith(base)) {
      const rest = f.slice(base.length);
      const slash = rest.indexOf("/");
      const dir = slash === -1 ? "" : rest.slice(0, slash);
      add(dir, dir || (base ? `${base}（根目录文件）` : "根目录文件"), dir ? `${base}${dir}/**` : `${base}*`);
    } else {
      // Outside src/: scripts/, tools/… each a card; loose root files (setup.py…) one card.
      const slash = f.indexOf("/");
      const dir = slash === -1 ? "" : f.slice(0, slash);
      add(`outside:${dir}`, dir || "根目录文件", dir ? `${dir}/**` : "*");
    }
  }

  // A flat package (src/pdfedit/*.py) would be one card for the whole program: one per module instead.
  const inBase = [...groups.values()].filter((g) => !g.pkg && !g.key.startsWith("outside:") && g.key);
  if (inBase.length === 1) {
    const dir = inBase[0].key;
    const prefix = `${base}${dir}/`;
    const direct = code.filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"));
    if (direct.filter((f) => !ENTRY_FILE.test(f.split("/").pop()!)).length >= SPLIT_AT) {
      groups.delete(dir);
      for (const f of code.filter((f) => f.startsWith(prefix))) {
        const rest = f.slice(prefix.length);
        const sub = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : null;
        if (sub) add(`${dir}/${sub}`, `${dir}/${sub}`, `${prefix}${sub}/**`);
        else if (ENTRY_FILE.test(rest)) add(dir, `${dir}（入口）`, f);
        else add(`${dir}/${stem(f)}`, stem(f), f);
      }
    }
  }

  // Tests: with the module they test when that is clear, else on one tests card.
  if (sources.length) {
    const nameOf = (g: Group) => g.key.split("/").pop()!.replace(/^outside:/, "");
    const cards = [...groups.values()];
    const rest: string[] = [];
    for (const f of loose.filter(isTest)) {
      if (cards.some((g) => g.globs.some((glob) => covers(glob, f)))) continue; // already beside its code
      const target = cards.find((g) => !g.pkg && nameOf(g) === testedName(f));
      if (target) target.globs.push(f); // an exact path: more specific than the tests card's folder
      else rest.push(f);
    }
    // Everything else under a tests folder, including tests added later, goes to one card per folder.
    for (const f of rest) {
      const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : "";
      add(`tests:${top}`, top ? `测试（${top}）` : "测试", top ? `${top}/**` : f);
    }
  }

  const used = new Set<string>();
  const byPackage = new Map<string, string>(); // package name → node id
  const nodes: CanvasNode[] = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => {
    const key = g.key.replace(/^(outside|tests):/, "");
    const fallback = g.key.startsWith("tests:") ? "tests" : base.replace(/\/$/, "") || "root";
    let id = slug(g.pkg ? g.pkg.replace(/^@[^/]+\//, "") : key.split("/").pop() || fallback);
    while (used.has(id)) id += "-x";
    used.add(id);
    if (g.pkg) byPackage.set(g.pkg, id);
    return {
      id,
      kind: "module",
      title: g.title,
      intent: { goal: "", acceptance: [], tasks: [] },
      files: g.globs,
      status: "todo",
    };
  });
  const packageTarget = (spec: string) =>
    [...byPackage].find(([name]) => spec === name || spec.startsWith(`${name}/`))?.[1];

  const draft: Canvas = { version: 1, nodes, edges: [] };
  const known = new Set(files);
  const exists = (p: string) => known.has(p);
  const counts = new Map<string, number>();
  for (const f of sources) {
    const from = ownerOf(draft, f);
    const full = path.join(root, f);
    if (!from || !fs.existsSync(full) || fs.statSync(full).size > MAX_SOURCE_BYTES) continue;
    for (const spec of importSpecifiers(fs.readFileSync(full, "utf8"), f)) {
      const to = packageTarget(spec) ?? importCandidates(f, spec, exists).map((c) => ownerOf(draft, c)).find(Boolean)?.id;
      const key = to && to !== from.id ? `${from.id}\u0000${to}` : null;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const edges: CanvasEdge[] = [...counts].map(([key, n]) => {
    const [from, to] = key.split("\u0000");
    return { from, to, label: `${n} 处引用` };
  });

  layoutCanvas(nodes, edges);
  return Canvas.parse({ version: 1, nodes, edges });
}

/** Columns by dependency depth (callers left, dependencies right), rows in order. */
export function layoutCanvas(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const level = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const next = level.get(e.from)! + 1;
      if (next > level.get(e.to)! && next < nodes.length) {
        level.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  for (const n of nodes) {
    const col = level.get(n.id)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    n.position = { x: col * 320, y: row * 160 };
  }
}

/** Writes .agent-together/canvas/* and default rules for a project. Refuses to overwrite unless forced. */
export function initProject(root: string, { force = false } = {}): Canvas {
  const canvasDir = path.join(root, ".agent-together", "canvas");
  if (fs.existsSync(canvasDir) && !force) {
    throw new Error(`${canvasDir} already exists; pass --force to regenerate it`);
  }
  const canvas = generateCanvas(root, listFiles(root));
  fs.rmSync(canvasDir, { recursive: true, force: true });
  fs.mkdirSync(canvasDir, { recursive: true });
  for (const node of canvas.nodes) {
    fs.writeFileSync(path.join(canvasDir, `${node.id}.json`), JSON.stringify(node, null, 2) + "\n");
  }
  fs.writeFileSync(path.join(canvasDir, "_edges.json"), JSON.stringify(canvas.edges, null, 2) + "\n");
  const rules = path.join(root, ".agent-together", "rules.json");
  if (!fs.existsSync(rules)) {
    const defaults = { "scope-fence": "ask", "design-guard": "ask", "test-tampering": "ask", "repeated-failure": "warn", "repeated-read": "warn" };
    fs.writeFileSync(rules, JSON.stringify(defaults, null, 2) + "\n");
  }
  return canvas;
}
