import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Canvas } from "@agent-together/schema";
import {
  checkSource,
  ensureGitignore,
  evidenceFor,
  generateCanvas,
  guessTestCommand,
  initGit,
  listFiles,
  ownerOf,
  openProject,
  parseImportProposal,
  projectDigest,
  readProjectInfo,
  staleSources,
  understandProject,
} from "@agent-together/core";
import { importCandidates, importSpecifiers } from "../src/imports.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "at-import-"));
function folder(files: Record<string, string>) {
  const root = tmp();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe("Python imports", () => {
  it("reads import and from-import lines, relative and absolute", () => {
    const code = "import os, notes.store as s\nfrom .tags import normalize\nfrom ..core import (a, b)\nfrom . import util\n  x = 'import fake'\n";
    expect([...importSpecifiers(code, "notes/search.py")].sort()).toEqual(
      ["..core", "..core.a", "..core.b", ".tags", ".tags.normalize", ".util", "notes.store", "os"].sort(),
    );
  });

  it("resolves only to files that exist, from the package, the root or src/", () => {
    const files = new Set(["notes/__init__.py", "notes/tags.py", "notes/store/__init__.py", "src/app/cli.py"]);
    const exists = (p: string) => files.has(p);
    expect(importCandidates("notes/search.py", ".tags", exists)).toEqual(["notes/tags.py"]);
    expect(importCandidates("notes/search.py", "notes.store", exists)).toEqual(["notes/store/__init__.py"]);
    expect(importCandidates("tests/test_x.py", "app.cli", exists)).toEqual(["src/app/cli.py"]);
    expect(importCandidates("notes/search.py", "os", exists)).toEqual([]);
  });

  it("links the cards of a Python project", () => {
    const root = folder({
      "notes/__init__.py": "",
      "notes/store.py": "import json\n",
      "cli/main.py": "from notes.store import load\n",
      "__pycache__/x.py": "import cli.main\n",
    });
    const canvas = generateCanvas(root, listFiles(root));
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(["cli", "notes"]);
    expect(canvas.edges).toEqual([{ from: "cli", to: "notes", label: "1 处引用" }]);
  });
});

describe("splitting existing code into cards", () => {
  it("splits a flat package by module, puts tests with their module and the rest on a tests card", () => {
    const root = folder({
      "src/pdfedit/__init__.py": "",
      "src/pdfedit/cli.py": "from pdfedit.store import load\n",
      "src/pdfedit/store.py": "",
      "src/pdfedit/ocr.py": "",
      "tests/test_store.py": "from pdfedit.store import load\n",
      "tests/test_end_to_end.py": "from pdfedit.cli import main\n",
      "scripts/release.py": "",
    });
    const canvas = generateCanvas(root, listFiles(root));
    const files = Object.fromEntries(canvas.nodes.map((n) => [n.id, n.files]));
    expect(files).toEqual({
      pdfedit: ["src/pdfedit/__init__.py"],
      cli: ["src/pdfedit/cli.py"],
      store: ["src/pdfedit/store.py", "tests/test_store.py"],
      ocr: ["src/pdfedit/ocr.py"],
      scripts: ["scripts/**"],
      tests: ["tests/**"],
    });
    // The exact path wins over the tests card's folder, so the store card owns its own test.
    expect(ownerOf(canvas, "tests/test_store.py")?.id).toBe("store");
    expect(ownerOf(canvas, "tests/test_new.py")?.id).toBe("tests");
    expect(canvas.edges).toEqual(expect.arrayContaining([{ from: "cli", to: "store", label: "1 处引用" }, { from: "tests", to: "cli", label: "1 处引用" }]));
  });

  it("keeps a source folder with few modules as one card", () => {
    const root = folder({ "src/app/main.py": "", "src/app/util.py": "" });
    expect(generateCanvas(root, listFiles(root)).nodes.map((n) => n.files)).toEqual([["src/app/**"]]);
  });
});

describe("guessTestCommand", () => {
  it("knows the usual test runners", () => {
    const at = (files: Record<string, string>) => guessTestCommand(folder(files), Object.keys(files));
    expect(at({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) })).toBe("npm test");
    expect(at({ "package.json": "{}", "src/a.test.js": "" })).toBe("node --test");
    expect(at({ "pyproject.toml": "", "tests/test_notes.py": "" })).toBe("python -m pytest");
    expect(at({ "go.mod": "module x" })).toBe("go test ./...");
    expect(at({ "Cargo.toml": "" })).toBe("cargo test");
    expect(at({ "pom.xml": "" })).toBe("mvn test");
    expect(at({ "App.csproj": "" })).toBe("dotnet test");
    expect(at({ "README.md": "" })).toBe("");
  });
});

const canvas = Canvas.parse({
  version: 1,
  nodes: [
    { id: "store", kind: "module", title: "store", files: ["src/store/**"] },
    { id: "cli", kind: "module", title: "cli", files: ["src/cli/**"] },
  ],
  edges: [],
});

describe("import proposals", () => {
  it("keeps only the canvas's own cards and copes with bad replies", () => {
    const reply = JSON.stringify({
      description: "记账工具",
      stack: "Node.js",
      testCommand: "npm test",
      nodes: [
        { id: "store", title: "账本存储", goal: "读写账本", acceptance: ["a", "b", "c", "d", "e"], tasks: ["补测试"] },
        { id: "store", title: "重复" },
        { id: "made-up", title: "不存在" },
        { id: "cli", goal: "命令行" },
      ],
    });
    const p = parseImportProposal("```json\n" + reply + "\n```", canvas)!;
    expect(p.nodes.map((n) => n.id)).toEqual(["store", "cli"]);
    expect(p.nodes[0].acceptance).toHaveLength(4);
    expect(p.nodes[1].title).toBe("cli"); // missing title: keep the folder name
    expect(parseImportProposal("oops", canvas)).toBeNull();
    expect(parseImportProposal(JSON.stringify({ nodes: [{ id: "made-up" }] }), canvas)).toBeNull();
  });

  it("keeps the code digest within its budget and falls back to a guessed test command", async () => {
    const root = folder({ "README.md": "# Ledger", "src/store/index.js": "x".repeat(50_000), "src/cli/main.js": "y", "src/store/a.test.js": "" });
    const files = listFiles(root);
    const digest = projectDigest(root, canvas, files, 6000);
    expect(digest.length).toBeLessThanOrEqual(6000);
    expect(digest).toContain("# Ledger");
    expect(digest).toContain("src/cli/main.js");
    let prompt = "";
    const llm = { name: "fake", complete: async (p: string) => ((prompt = p), JSON.stringify({ nodes: [{ id: "cli", goal: "g" }] })) };
    const p = await understandProject(llm, root, canvas, files);
    expect(prompt).toContain("不要改卡片 id");
    expect(p.testCommand).toBe("node --test");
  });
});

describe("citations", () => {
  const cited = () => {
    const root = folder({
      "src/store/index.js": "export function load() {\n  return [];\n}\n",
      "src/cli/main.js": "load();\n",
    });
    return { root, files: listFiles(root) };
  };

  it("checks each cited range: the card's own file, lines inside it", () => {
    const { root, files } = cited();
    const set = new Set(files);
    const ok = checkSource(root, canvas, "store", { path: "./src/store/index.js", line: 1, end_line: 3 }, set);
    expect(ok).toMatchObject({ ok: true, path: "src/store/index.js" });
    expect(ok.excerpt).toBe("1| export function load() {\n2|   return [];\n3| }");
    expect(checkSource(root, canvas, "store", { path: "src/store/index.js", line: 2, end_line: 9 }, set)).toMatchObject({ ok: false, problem: "行号不对（这个文件共 3 行）" });
    expect(checkSource(root, canvas, "store", { path: "src/cli/main.js", line: 1 }, set).problem).toBe("这是「cli」的文件");
    expect(checkSource(root, canvas, "store", { path: "src/store/made-up.js", line: 1 }, set).problem).toBe("项目里没有这个文件");
    expect(checkSource(root, canvas, "store", { path: "../outside.js", line: 1 }, set).ok).toBe(false);
  });

  it("marks a statement verified only when it cites something and every citation checks out", () => {
    const { root, files } = cited();
    const reply = JSON.stringify({
      nodes: [
        {
          id: "store",
          goal: { text: "读写账本", sources: [{ path: "src/store/index.js", line: 1, end_line: 3 }] },
          acceptance: [
            { text: "load 返回数组", sources: [{ path: "src/store/index.js", line: 2 }] },
            { text: "编出来的", sources: [{ path: "src/store/index.js", line: 40 }] },
            { text: "没有出处", sources: [] },
          ],
          unknowns: ["看不出账本存在哪"],
        },
      ],
    });
    const card = parseImportProposal(reply, canvas, root, files)!.nodes[0];
    expect(card.goal.verified).toBe(true);
    expect(card.acceptance.map((a) => a.verified)).toEqual([true, false, false]);
    expect(card.unknowns).toEqual(["看不出账本存在哪"]);
  });

  it("numbers the digest's lines so the model can cite them", () => {
    const { root, files } = cited();
    expect(projectDigest(root, canvas, files)).toContain("2|   return [];");
    expect(projectDigest(root, canvas, files, 40_000, "cli")).not.toContain("src/store/index.js");
  });

  it("keeps verified citations with file hashes and notices when the code changes", () => {
    const { root, files } = cited();
    const card = parseImportProposal(
      JSON.stringify({ nodes: [{ id: "store", goal: { text: "g", sources: [{ path: "src/store/index.js", line: 1 }] }, acceptance: [{ text: "bad", sources: [{ path: "x.js", line: 1 }] }], unknowns: ["u"] }] }),
      canvas,
      root,
      files,
    )!.nodes[0];
    const evidence = evidenceFor(root, card);
    expect(evidence.sources).toEqual([{ path: "src/store/index.js", line: 1 }]); // the unverified one is not kept
    expect(Object.keys(evidence.files)).toEqual(["src/store/index.js"]);
    expect(evidence.unknowns).toEqual(["u"]);
    expect(evidence.commit).toBeUndefined(); // no git here
    const node = { ...canvas.nodes[0], evidence };
    expect(staleSources(root, node)).toEqual([]);
    fs.writeFileSync(path.join(root, "src/store/index.js"), "export function load() {\r\n  return [];\r\n}\r\n");
    expect(staleSources(root, node)).toEqual([]); // line endings alone are no change
    fs.appendFileSync(path.join(root, "src/store/index.js"), "export const x = 1;\n");
    expect(staleSources(root, node)).toEqual(["src/store/index.js"]);
  });
});

describe("opening existing code", () => {
  it("marks the project as imported and adds hook configs to .gitignore, keeping its lines", () => {
    const root = folder({ ".gitignore": "dist/\n.env", "src/a.js": "" });
    expect(openProject(root).created).toBe(true);
    expect(readProjectInfo(root).imported).toBe(true);
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore.startsWith("dist/\n.env\n")).toBe(true);
    expect(ignore).toContain(".claude/settings.local.json");
    expect(ensureGitignore(root)).toEqual([]); // nothing twice
  });

  it("turns on git only when asked, without committing", () => {
    const root = folder({ "src/a.js": "" });
    expect(openProject(root).git).toBe(false);
    initGit(root);
    expect(openProject(root).git).toBe(true);
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: "ignore" })).toThrow();
  });
});
