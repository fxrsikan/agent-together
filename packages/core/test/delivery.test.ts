import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { Spec } from "@agent-together/schema";
import { buildPackage, Checkpoints, codeChangedSince, dataFiles, instructions, makeSandbox, removeTree, restorePreview, restoreVersion, startBat, Versions, zipFolder } from "@agent-together/core";

const write = (root: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** Reads a zip back: name → content. */
function unzip(file: string): Record<string, string> {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const flags = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    const localName = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localName, local + 30 + localName + size);
    out[name] = zlib.inflateRawSync(data).toString("utf8");
    at += 46 + nameLen;
  }
  return out;
}

const product = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-deliver-"));
  write(root, {
    "package.json": '{"scripts":{"start":"node server.js"}}',
    "server.js": "// server",
    "public/index.html": "<h1>小说</h1>",
    "manuscript/第一章.md": "雨夜",
    "storyboard.json": "[]",
    ".agent-together/canvas/canvas.json": "{}",
    ".claude/settings.json": "{}",
    "node_modules/x/index.js": "module.exports = 1",
  });
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.agent-together/acceptance/\n.agent-together/versions/\n");
  return root;
};
const DATA = ["manuscript/", "storyboard.json"];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

describe("code and data apart", () => {
  it("finds the data files by folder, name and glob", () => {
    const root = product();
    expect(dataFiles(root, DATA).sort()).toEqual(["manuscript/第一章.md", "storyboard.json"]);
    expect(dataFiles(root, ["manuscript"])).toEqual(["manuscript/第一章.md"]);
    expect(dataFiles(root, [])).toEqual([]);
  });

  it("accepts on a copy without data or Agent Together's folders, node_modules linked not copied", () => {
    const root = product();
    const box = path.join(os.tmpdir(), `at-box-${Date.now()}`);
    makeSandbox(root, DATA, box);
    expect(fs.existsSync(path.join(box, "server.js"))).toBe(true);
    expect(fs.existsSync(path.join(box, "manuscript"))).toBe(false);
    expect(fs.existsSync(path.join(box, "storyboard.json"))).toBe(false);
    expect(fs.existsSync(path.join(box, ".agent-together"))).toBe(false);
    expect(fs.lstatSync(path.join(box, "node_modules")).isSymbolicLink()).toBe(true);
    expect(read(box, "node_modules/x/index.js")).toBe("module.exports = 1");
    removeTree(box);
    expect(fs.existsSync(box)).toBe(false);
    expect(read(root, "node_modules/x/index.js")).toBe("module.exports = 1"); // the real one is untouched
  });
});

describe("the delivery package", { timeout: 30_000 }, () => {
  it("zips with UTF-8 names that read back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-zip-"));
    write(dir, { "启动.bat": "@echo off", "a/b.txt": "内容" });
    const zip = path.join(os.tmpdir(), `at-${Date.now()}.zip`);
    expect(zipFolder(dir, zip)).toBe(2);
    expect(unzip(zip)).toEqual({ "a/b.txt": "内容", "启动.bat": "@echo off" });
  });

  it("is the accepted checkpoint's code, without data, with a start script and instructions", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "at-pkgrepo-"));
    git(repo, "init", "-q");
    const root = path.join(repo, "短剧");
    fs.mkdirSync(root);
    const src = product();
    fs.cpSync(src, root, { recursive: true });
    const cp = new Checkpoints(root).create("验收前");
    write(root, { "server.js": "// changed after acceptance" });
    const spec = Spec.parse({ version: 1, goal: "把小说拆成镜头", data: "小说存在 manuscript/", scenarios: [{ id: "S-01", name: "写小说", steps: ["新建", "保存"] }], services: [{ name: "拆镜头服务", mode: "mock" }] });
    const readme = instructions(spec, { name: "短剧生产", serviceMode: "mock", data: DATA, limits: ["没有自动检查：权限"] });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "at-pkgout-"));
    const pkg = buildPackage({ root, commit: cp.commit, config: { start: "node server.js", data: DATA }, serviceMode: "mock", readme, outDir: out, name: "短剧生产-第1版" });
    const files = unzip(pkg.zip);
    expect(Object.keys(files).sort()).toEqual([".gitignore", "package.json", "public/index.html", "server.js", "start.sh", "使用说明.txt", "启动.bat"]);
    expect(files["server.js"]).toBe("// server");
    expect(files["启动.bat"]).toContain("node server.js");
    expect(files["启动.bat"]).toContain("set AT_SERVICE_MODE=mock");
    expect(files["使用说明.txt"]).toContain("双击「启动.bat」");
    expect(files["使用说明.txt"]).toContain("拆镜头服务用的是示例服务");
    expect(files["使用说明.txt"]).toContain("没有自动检查：权限");
  });

  it("installs dependencies on first start when the product has an install step", () => {
    expect(startBat({ start: "npm start", install: "npm install" }, "real")).toContain("call npm install");
    expect(startBat({ start: "node server.js" }, "mock")).not.toContain("install");
  });
});

describe("stable versions and going back", { timeout: 30_000 }, () => {
  const setup = () => {
    const root = product();
    git(root, "init", "-q");
    const checkpoints = new Checkpoints(root);
    const cp = checkpoints.create("第 1 版");
    const versions = new Versions(root);
    const record = versions.save(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        name: "短剧生产",
        goal: "",
        scenarios: [],
        cards: [],
        checkpoint: { id: cp.id, commit: cp.commit },
        acceptanceId: "a",
        layers: [],
        confirmed: [],
        serviceMode: "mock",
        mockAccepted: true,
        knownLimits: [],
        instructions: "",
        package: null,
      },
      DATA,
    );
    return { root, checkpoints, versions, record, cp };
  };

  it("backs up the data with the version and tells when the data changed since", () => {
    const { root, record, versions } = setup();
    expect(record.data.files).toBe(2);
    expect(read(versions.dataDir(1), "manuscript/第一章.md")).toBe("雨夜");
    expect(restorePreview(root, record, DATA).sameData).toBe(true);
    write(root, { "manuscript/第二章.md": "新的一章" });
    const preview = restorePreview(root, record, DATA);
    expect(preview).toMatchObject({ sameData: false, currentFiles: 3, backupFiles: 2 });
    expect(preview.note).toContain("可以用第 1 版的数据备份");
    // The bookkeeping lives outside checkpoints: a rollback cannot delete it.
    expect(git(root, "check-ignore", ".agent-together/versions/v1.json")).toBeTruthy();
  });

  it("goes back to the code of the version, with the backup or with the data as it is now", () => {
    const { root, checkpoints, record } = setup();
    write(root, { "server.js": "// version 2", "manuscript/第二章.md": "新的一章" });
    restoreVersion(root, checkpoints, record, "current", DATA);
    expect(read(root, "server.js")).toBe("// server");
    expect(read(root, "manuscript/第二章.md")).toBe("新的一章");
    expect(fs.existsSync(path.join(root, ".agent-together", "versions", "v1.json"))).toBe(true);

    write(root, { "server.js": "// version 2" });
    restoreVersion(root, checkpoints, record, "backup", DATA);
    expect(read(root, "server.js")).toBe("// server");
    expect(fs.existsSync(path.join(root, "manuscript", "第二章.md"))).toBe(false);
    expect(read(root, "manuscript/第一章.md")).toBe("雨夜");
  });

  it("notices code changed since acceptance, but not data or bookkeeping", () => {
    const { root, checkpoints, cp } = setup();
    write(root, { "manuscript/第二章.md": "x", ".agent-together/runs/r.json": "{}" });
    expect(codeChangedSince(root, checkpoints, cp.commit, DATA)).toEqual([]);
    write(root, { "public/index.html": "<h1>改了</h1>" });
    expect(codeChangedSince(root, checkpoints, cp.commit, DATA)).toEqual(["public/index.html"]);
  });
});
