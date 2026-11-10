import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { Spec } from "@agent-together/schema";
import { globRe, walkFiles, type Layer } from "./acceptance.js";
import type { Checkpoints } from "./checkpoints.js";
import type { RunConfig } from "./product.js";

/**
 * Delivery (phase one, M4): the product's code and its business data are kept
 * apart. Acceptance runs on a copy without the data; a delivery package holds the
 * code with a start script and instructions; a stable version keeps a checkpoint,
 * a backup of the data, the acceptance record and the package. Going back to a
 * version restores the code and asks which data to use.
 */

/** Agent Together's own folders and the assistants' settings: never part of the product. */
const OWN = [".agent-together", ".claude", ".codex", ".cursor", ".git"];

/** "data/" or a folder name → everything under it; globs as written. */
export function dataPatterns(root: string, data: string[]): RegExp[] {
  return data
    .map((d) => d.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((d) => {
      if (d.endsWith("/")) return `${d}**`;
      if (!/[*?]/.test(d) && fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory()) return `${d}/**`;
      return d;
    })
    .map(globRe);
}

export const isOwn = (rel: string) => OWN.some((o) => rel === o || rel.startsWith(`${o}/`));

/** The product's data files now, project-relative. */
export function dataFiles(root: string, data: string[]): string[] {
  const res = dataPatterns(root, data);
  if (!res.length) return [];
  return walkFiles(root, (rel) => isOwn(rel)).filter((f) => res.some((re) => re.test(f)));
}

/** A digest of the data files' names and contents: equal digests, equal data. */
export function dataDigest(dir: string, files: string[]): string {
  const h = createHash("sha1");
  for (const f of [...files].sort()) {
    h.update(f);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function copyFiles(from: string, to: string, files: string[]) {
  for (const f of files) {
    const target = path.join(to, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, f), target);
  }
}

/** Removes a folder, unlinking a node_modules junction first so the real one is never touched. */
export function removeTree(dir: string) {
  const nm = path.join(dir, "node_modules");
  try {
    if (fs.lstatSync(nm).isSymbolicLink()) {
      try {
        fs.unlinkSync(nm);
      } catch {
        fs.rmdirSync(nm);
      }
    }
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A copy of the product to accept without touching the user's data: the code
 * only (no data files, none of Agent Together's folders), node_modules linked,
 * not copied. Returns the copy's folder.
 */
export function makeSandbox(root: string, data: string[], dir: string): string {
  removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  const res = dataPatterns(root, data);
  const files = walkFiles(root, (rel) => isOwn(rel)).filter((f) => !res.some((re) => re.test(f)));
  copyFiles(root, dir, files);
  const nm = path.join(root, "node_modules");
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, "node_modules"), "junction");
  return dir;
}

// ---------------------------------------------------------------------------
// Zip (stored names in UTF-8, deflated), so the package opens on any machine.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipFolder(dir: string, outFile: string, executable: (rel: string) => boolean = (r) => r.endsWith(".sh")): number {
  const files = walkFiles(dir);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel));
    const packed = zlib.deflateRawSync(data);
    const name = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the permission bits below count
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((executable(rel) ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...chunks, cd, end]));
  return files.length;
}

// ---------------------------------------------------------------------------
// The delivery package.

const DEFAULT_PORT = 3000;

export function startBat(config: RunConfig, serviceMode: "mock" | "real"): string {
  const install = config.install?.trim();
  return [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    "where node >nul 2>nul || (echo 需要先安装 Node.js：https://nodejs.org ，装好后再双击这个文件。& pause & exit /b 1)",
    install ? `if exist package.json if not exist node_modules (echo 第一次启动，正在安装需要的东西…& call ${install} || (echo 安装失败，请看上面的提示。& pause & exit /b 1))` : "",
    `if "%PORT%"=="" set PORT=${DEFAULT_PORT}`,
    `set AT_SERVICE_MODE=${serviceMode}`,
    'start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%' + (config.path && config.path !== "/" ? config.path : "/") + '"',
    "echo 程序正在运行。用完后关掉这个窗口就停止了。",
    config.start,
    "pause",
    "",
  ]
    .filter((l) => l !== "")
    .join("\r\n");
}

export function startSh(config: RunConfig, serviceMode: "mock" | "real"): string {
  const install = config.install?.trim();
  return [
    "#!/bin/sh",
    'cd "$(dirname "$0")"',
    'command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js：https://nodejs.org"; exit 1; }',
    install ? `if [ -f package.json ] && [ ! -d node_modules ]; then echo "第一次启动，正在安装需要的东西…"; ${install} || exit 1; fi` : "",
    `export PORT="\${PORT:-${DEFAULT_PORT}}"`,
    `export AT_SERVICE_MODE=${serviceMode}`,
    `(sleep 2; (open "http://localhost:$PORT${config.path && config.path !== "/" ? config.path : "/"}" || xdg-open "http://localhost:$PORT/") >/dev/null 2>&1) &`,
    'echo "程序正在运行。按 Ctrl+C 停止。"',
    `exec ${config.start}`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The instructions that go into the package and the version record. */
export function instructions(spec: Spec, opts: { name: string; serviceMode: "mock" | "real"; data: string[]; limits: string[] }): string {
  const scenarios = spec.scenarios
    .map((s, i) => `${i + 1}. ${s.name}\n${s.steps.map((st) => `   - ${st}`).join("\n")}`)
    .join("\n\n");
  const mock = spec.services.filter((s) => s.mode === "mock" || opts.serviceMode === "mock");
  return `${opts.name}（第 ${spec.version} 版）

${spec.goal}

怎么启动
- Windows：双击「启动.bat」。第一次会先安装需要的东西（电脑上要先装好 Node.js：https://nodejs.org）。浏览器会自动打开 http://localhost:${DEFAULT_PORT}/ 。用完关掉黑色的窗口就停止了。
- macOS：在终端里运行 sh start.sh。

能做什么（这一版按这些使用场景验收过）
${scenarios}

数据存在哪里
${spec.data || "（没有写）"}${opts.data.length ? `\n在这个文件夹里的位置：${opts.data.join("、")}。备份时把它们一起复制走。` : ""}

已知限制
${[...(mock.length ? [`${mock.map((s) => s.name).join("、")}用的是示例服务（按固定规则给结果），还不是真实服务。`] : []), ...opts.limits].map((l) => `- ${l}`).join("\n") || "- 没有"}
`;
}

export interface PackageResult {
  dir: string;
  zip: string;
  files: number;
}

/**
 * Builds the delivery package from a checkpoint (the code exactly as accepted):
 * the product's files without data and without Agent Together's folders, plus
 * 启动.bat, start.sh and 使用说明.txt, folded into a zip.
 */
export function buildPackage(opts: { root: string; commit: string | null; config: RunConfig; serviceMode: "mock" | "real"; readme: string; outDir: string; name: string }): PackageResult {
  const dir = path.join(opts.outDir, opts.name);
  removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  const data = dataPatterns(opts.root, opts.config.data ?? []);
  if (opts.commit) {
    const git = (args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync("git", args, { cwd: opts.root, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const prefix = git(["rev-parse", "--show-prefix"]);
    const top = git(["rev-parse", "--show-toplevel"]);
    const index = path.join(os.tmpdir(), `agent-together-pkg-index-${process.pid}-${Date.now()}`);
    try {
      // The project's own tree (it may be a subfolder of the repository), written out from the top level.
      git(["read-tree", prefix ? `${opts.commit}:${prefix.replace(/\/$/, "")}` : opts.commit], { GIT_INDEX_FILE: index });
      execFileSync("git", ["checkout-index", "-a", "-f", `--prefix=${dir.replace(/\\/g, "/")}/`], { cwd: top, env: { ...process.env, GIT_INDEX_FILE: index }, stdio: ["ignore", "pipe", "pipe"] });
    } finally {
      fs.rmSync(index, { force: true });
    }
    for (const f of walkFiles(dir)) if (isOwn(f) || data.some((re) => re.test(f))) fs.rmSync(path.join(dir, f), { force: true });
    for (const o of OWN) fs.rmSync(path.join(dir, o), { recursive: true, force: true });
  } else {
    copyFiles(opts.root, dir, walkFiles(opts.root, (rel) => isOwn(rel)).filter((f) => !data.some((re) => re.test(f))));
  }
  fs.writeFileSync(path.join(dir, "启动.bat"), startBat(opts.config, opts.serviceMode));
  fs.writeFileSync(path.join(dir, "start.sh"), startSh(opts.config, opts.serviceMode), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "使用说明.txt"), opts.readme.replace(/\r?\n/g, "\r\n"));
  const zip = path.join(opts.outDir, `${opts.name}.zip`);
  const files = zipFolder(dir, zip);
  return { dir, zip, files };
}

// ---------------------------------------------------------------------------
// Stable versions.

export interface VersionRecord {
  version: number;
  savedAt: string;
  name: string;
  goal: string;
  scenarios: { id: string; name: string; status: string }[];
  cards: { id: string; title: string }[];
  checkpoint: { id: string; commit: string } | null;
  acceptanceId: string;
  layers: Layer[];
  /** What the user confirmed by hand, per scenario. */
  confirmed: { id: string; at: string }[];
  serviceMode: "mock" | "real";
  /** The user accepted delivering with sample services; recorded on purpose. */
  mockAccepted: boolean;
  knownLimits: string[];
  instructions: string;
  /** Project-relative, under .agent-together/versions/. */
  package: string | null;
  data: { paths: string[]; files: number; digest: string };
}

export class Versions {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = path.join(root, ".agent-together", "versions");
  }

  list(): VersionRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^v\d+\.json$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as VersionRecord;
        } catch {
          return null;
        }
      })
      .filter((v): v is VersionRecord => !!v)
      .sort((a, b) => b.version - a.version);
  }

  get(version: number): VersionRecord | null {
    return this.list().find((v) => v.version === version) ?? null;
  }

  dataDir(version: number) {
    return path.join(this.dir, `v${version}`, "data");
  }

  /** Saves the record, backing up the product's data files as they are now. Saving the same version again replaces it. */
  save(record: Omit<VersionRecord, "data">, dataPaths: string[]): VersionRecord {
    const files = dataFiles(this.root, dataPaths);
    const backup = this.dataDir(record.version);
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(backup, { recursive: true });
    copyFiles(this.root, backup, files);
    const full: VersionRecord = { ...record, data: { paths: dataPaths, files: files.length, digest: dataDigest(this.root, files) } };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `v${record.version}.json`), JSON.stringify(full, null, 2) + "\n");
    return full;
  }
}

export interface RestorePreview {
  version: number;
  /** The data now is the same as the version's backup. */
  sameData: boolean;
  currentFiles: number;
  backupFiles: number;
  /** In plain words: what the choice means. */
  note: string;
}

export function restorePreview(root: string, record: VersionRecord, currentData: string[]): RestorePreview {
  const paths = [...new Set([...record.data.paths, ...currentData])];
  const now = dataFiles(root, paths);
  const sameData = dataDigest(root, now) === record.data.digest;
  const newer = new Versions(root).list().filter((v) => v.version > record.version);
  const note = sameData
    ? "现在的数据和保存这个版本时一样。"
    : `现在的数据（${now.length} 个文件）和保存第 ${record.version} 版时的备份（${record.data.files} 个文件）不一样。${
        newer.length ? `之后的第 ${newer.map((v) => v.version).join("、")} 版用过这些数据，可能改过数据的格式，第 ${record.version} 版不一定能读懂。` : ""
      }可以用第 ${record.version} 版的数据备份（之后新加的内容不在里面），也可以保留现在的数据。`;
  return { version: record.version, sameData, currentFiles: now.length, backupFiles: record.data.files, note };
}

/**
 * Puts the code back as it was at the version's checkpoint, then the data the user
 * chose: the version's backup, or the data as it is now. The state before is
 * saved as a checkpoint first (by the rollback), so this can be undone.
 */
export function restoreVersion(root: string, checkpoints: Checkpoints, record: VersionRecord, data: "backup" | "current", currentData: string[]): { safety: string } {
  if (!record.checkpoint) throw new Error("这个版本没有检查点，回不去");
  const paths = [...new Set([...record.data.paths, ...currentData])];
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "agent-together-data-"));
  try {
    const now = dataFiles(root, paths);
    copyFiles(root, keep, now);
    const safety = checkpoints.rollback(record.checkpoint.id);
    for (const f of dataFiles(root, paths)) fs.rmSync(path.join(root, f), { force: true });
    if (data === "current") copyFiles(keep, root, now);
    else {
      const backup = new Versions(root).dataDir(record.version);
      copyFiles(backup, root, fs.existsSync(backup) ? walkFiles(backup) : []);
    }
    return { safety: safety.id };
  } finally {
    fs.rmSync(keep, { recursive: true, force: true });
  }
}
