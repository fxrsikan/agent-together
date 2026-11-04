import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Canvas, type CanvasEdge, type CanvasNode } from "@agent-together/schema";
import { importCandidates, importSpecifiers, SOURCE_FILE } from "./imports.js";
import { ownerOf } from "./owners.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-together", ".claude", "dist", "out", "build", "coverage"]);
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
  glob: string;
  pkg?: string;
}

/**
 * First-pass canvas from code. In a monorepo each workspace package is a node;
 * otherwise each top-level directory of the source root (src/ when most code
 * lives there) is. Edges come from relative imports and imports of workspace
 * packages by name. Naming nodes as features and regrouping them is left to the
 * user (and later an LLM).
 */
export function generateCanvas(root: string, files: string[]): Canvas {
  const sources = files.filter((f) => SOURCE_FILE.test(f) && !f.split("/").some((p) => SKIP_DIRS.has(p)));
  const pool = sources.length ? sources : files;
  const packages = findPackages(root, files);
  const loose = pool.filter((f) => !packages.some((p) => f.startsWith(`${p.dir}/`)));
  const base = loose.filter((f) => f.startsWith("src/")).length * 2 >= loose.length && loose.length ? "src/" : "";

  const groups = new Map<string, Group>();
  for (const f of pool) {
    const pkg = packages.find((p) => f.startsWith(`${p.dir}/`));
    if (pkg) {
      groups.set(pkg.dir, { key: pkg.dir, title: pkg.name, glob: `${pkg.dir}/**`, pkg: pkg.name });
      continue;
    }
    if (!f.startsWith(base)) continue;
    const rest = f.slice(base.length);
    const slash = rest.indexOf("/");
    const dir = slash === -1 ? "" : rest.slice(0, slash);
    const title = dir || (base ? `${base}（根目录文件）` : "根目录文件");
    groups.set(dir, { key: dir, title, glob: dir ? `${base}${dir}/**` : `${base}*` });
  }

  const used = new Set<string>();
  const byPackage = new Map<string, string>(); // package name → node id
  const nodes: CanvasNode[] = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => {
    let id = slug(g.pkg ? g.pkg.replace(/^@[^/]+\//, "") : g.key || base.replace(/\/$/, "") || "root");
    while (used.has(id)) id += "-x";
    used.add(id);
    if (g.pkg) byPackage.set(g.pkg, id);
    return {
      id,
      kind: "module",
      title: g.title,
      intent: { goal: "", acceptance: [], tasks: [] },
      files: [g.glob],
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
    for (const spec of importSpecifiers(fs.readFileSync(full, "utf8"))) {
      const to = packageTarget(spec) ?? importCandidates(f, spec, exists).map((c) => ownerOf(draft, c)).find(Boolean)?.id;
      const key = to && to !== from.id ? `${from.id}\u0000${to}` : null;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const edges: CanvasEdge[] = [...counts].map(([key, n]) => {
    const [from, to] = key.split("\u0000");
    return { from, to, label: `${n} 处引用` };
  });

  layout(nodes, edges);
  return Canvas.parse({ version: 1, nodes, edges });
}

/** Columns by dependency depth (callers left, dependencies right), rows in order. */
function layout(nodes: CanvasNode[], edges: CanvasEdge[]) {
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
