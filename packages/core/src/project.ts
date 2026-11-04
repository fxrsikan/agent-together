import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "./init.js";

/** What stays out of git inside .agent-together/: machine-local state. */
const DATA_GITIGNORE = ["runtime.json", "events/", "context/", "races/", "tests.json", "runs/", ""].join("\n");

/** Hook configs hold absolute paths to this machine's hook program, so a new project keeps them out of git. */
const PROJECT_GITIGNORE = ["node_modules/", ".claude/settings.local.json", ".codex/hooks.json", ".cursor/hooks.json", ""].join("\n");

export interface ProjectInfo {
  name: string;
  createdAt: string;
  /** What the product is, in the user's words; every dispatched agent reads it. */
  description?: string;
  /** Tech stack, e.g. from a generated plan. */
  stack?: string;
  /** Run from the project root after each in-app dispatch, e.g. "node --test". */
  testCommand?: string;
}

const infoFile = (root: string) => path.join(root, ".agent-together", "project.json");

export function readProjectInfo(root: string): ProjectInfo {
  const file = infoFile(root);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return { name: path.basename(root), createdAt: "" };
}

export function writeProjectInfo(root: string, patch: Partial<ProjectInfo>): ProjectInfo {
  const info = { ...readProjectInfo(root), ...patch };
  fs.writeFileSync(infoFile(root), JSON.stringify(info, null, 2) + "\n");
  return info;
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Sets up .agent-together/ in a folder: canvas from its files, default rules, project.json, data .gitignore. */
function setUp(root: string, name: string) {
  initProject(root);
  fs.writeFileSync(path.join(root, ".agent-together", ".gitignore"), DATA_GITIGNORE);
  fs.writeFileSync(infoFile(root), JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2) + "\n");
}

/**
 * A new, empty project: the folder (created if missing, must be empty otherwise),
 * a git repository (checkpoints, races and Codex need one), a .gitignore, and an
 * empty canvas to draw on or to fill with a generated plan.
 */
export function createProject(dir: string, name = path.basename(dir)): string {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error(`文件夹不是空的：${root}。已有代码请用"打开项目"。`);
  execFileSync("git", ["init", "-q"], { cwd: root });
  setUp(root, name); // before any file exists, so the canvas starts empty
  fs.writeFileSync(path.join(root, ".gitignore"), PROJECT_GITIGNORE);
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n`);
  return root;
}

/**
 * An existing folder. If it has no .agent-together/ yet, one is set up with a canvas
 * generated from its code (one node per top-level module). Returns the project
 * root and whether it was just set up. A folder outside git still opens, but
 * checkpoints and races stay off until it is a repository.
 */
export function openProject(dir: string): { root: string; created: boolean; git: boolean } {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`不是文件夹：${root}`);
  const created = !fs.existsSync(path.join(root, ".agent-together", "canvas"));
  if (created) setUp(root, path.basename(root));
  return { root, created, git: isGitRepo(root) };
}

/**
 * A node id from its title: the title's ASCII words as a slug ("Login form" →
 * "login-form"), else "node"; numbered when taken ("node-2").
 */
export function newNodeId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "node";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}
