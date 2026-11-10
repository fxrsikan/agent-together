import { execFileSync, exec } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Canvas, Scenario, Spec } from "@agent-together/schema";
import {
  failureTask,
  frontEndCode,
  judgePage,
  LAYER_NAMES,
  planPrompt,
  planScenario,
  replanPrompt,
  runScenario,
  scenarioBasis,
  scenarioLayers,
  SNAPSHOT_JS,
  type AcceptanceEnv,
  type Beat,
  type Layer,
  type LayerId,
  type PageDriver,
  type ScenarioPlan,
  type ScenarioResult,
} from "./acceptance.js";
import { buildPackage, dataFiles, instructions, isOwn, makeSandbox, removeTree, dataPatterns } from "./delivery.js";
import { walkFiles } from "./acceptance.js";
import type { Checkpoints } from "./checkpoints.js";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { zNames } from "./paths.js";
import { ProductProcess, saveRunConfig, type RunConfig } from "./product.js";
import { ensureGitignore, readProjectInfo } from "./project.js";
import type { TestRun } from "./tests.js";
import { versionCards } from "./engine.js";

/**
 * One acceptance of a version (phase one, M4): the evidence layers in order —
 * unit tests, the after-run checks, a build, the scenarios on a copy of the
 * product with real input (interface, interaction, persistence, the business
 * scenarios), the delivery package started for real — then the user goes
 * through each scenario by hand. Recorded in .agent-together/acceptance/<id>/.
 */

export interface AcceptanceRecord {
  id: string;
  version: number;
  startedAt: string;
  endedAt?: string;
  status: "running" | "passed" | "failed" | "stopped" | "error";
  note: string;
  /** The code as accepted: the stable version must be this. */
  checkpoint: { id: string; commit: string } | null;
  serviceMode: "mock" | "real";
  layers: Layer[];
  scenarios: ScenarioResult[];
  /** Project-relative zip of the delivery package, once built. */
  package: { zip: string; files: number } | null;
  /** The user's own walk through each scenario. */
  user: Record<string, { ok: boolean; note?: string; at: string }>;
  llmCalls: number;
}

export interface AcceptanceDeps {
  llm: Llm | null;
  spec: () => Spec | null;
  canvas: () => Canvas;
  runConfig: () => RunConfig | null;
  serviceMode: () => "mock" | "real";
  checkpoint: (label: string) => { id: string; commit: string } | null;
  runTests: () => Promise<TestRun | null>;
  /** A fresh browser page for the acceptance, apart from the user's preview. */
  openDriver: (downloadDir: string) => Promise<PageDriver & { close(): void }>;
  onChange?: (record: AcceptanceRecord) => void;
  /** Lets tests swap the product process (and so skip a real server). */
  product?: (root: string) => ProductProcess;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
const layer = (id: LayerId, status: Layer["status"] = "pending", detail = ""): Layer => ({ id, name: LAYER_NAMES[id], status, detail });
const ORDER: LayerId[] = ["tests", "audit", "build", "interface", "interaction", "persistence", "scenarios", "delivery"];

/** Where the product keeps data, asked of the helper model when the run configuration does not say. */
export function dataPathsPrompt(spec: Spec, files: string[], hints: string[] = []): string {
  return `一个本地网页产品把业务数据存在项目文件夹里。根据下面的说明、文件列表和代码里读写文件的地方，列出所有业务数据（用户用产品时产生、保存的内容，比如作品、记录、登记的名单、项目信息），不是代码、测试或配置。宁可多列一个数据文件，也不要漏掉：漏掉的数据在验收时会混进去，在回到旧版本时会丢。

数据说明：${spec.data || "（没有）"}

文件（项目根目录）：
${files.slice(0, 300).join("\n")}

代码里读写文件的地方：
${hints.join("\n") || "（没找到）"}

只输出 JSON：{"data":["data/","manuscript/","storyboard.json"]}。文件夹以 / 结尾。还没有产生的数据文件也按代码写上。看不出来就输出 {"data":[]}。`;
}

/** Lines of the product's source that name files it reads or writes: what tells data from code. */
export function dataHints(root: string, max = 80): string[] {
  const re = /(writeFile|appendFile|createWriteStream|mkdir|readFile|_FILE\s*=|_DIR\s*=|DATA_DIR|\.(json|md|csv|txt|db|sqlite)['"`])/;
  const out: string[] = [];
  for (const f of walkFiles(root, (rel, isDir) => isOwn(rel) || (isDir && /^(test|tests|__tests__|public|dist|build|coverage)$/.test(path.basename(rel))))) {
    if (!/\.(m?js|cjs|ts|py)$/.test(f) || /\.test\.|\.spec\./.test(f)) continue;
    const lines = fs.readFileSync(path.join(root, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (out.length < max && re.test(l) && l.length < 240) out.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  return out;
}

export async function proposeDataPaths(llm: Llm, spec: Spec, files: string[], hints: string[] = []): Promise<string[]> {
  const raw = parseJsonObject<{ data?: unknown }>(await llm.complete(dataPathsPrompt(spec, files, hints), { timeoutMs: 90_000, maxTokens: 600 }));
  return Array.isArray(raw?.data) ? raw.data.filter((d): d is string => typeof d === "string" && !!d.trim() && !d.includes("..")) : [];
}

/** Files of the product's code that changed since the commit (data and Agent Together's own folders aside). */
export function codeChangedSince(root: string, checkpoints: Checkpoints, commit: string, data: string[]): string[] {
  const now = checkpoints.snapshot("compare");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const prefix = git(["rev-parse", "--show-prefix"]).trim();
  const res = dataPatterns(root, data);
  return zNames(git(["diff-tree", "-r", "-z", "--name-only", commit, now, "--", "."]))
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f))
    .filter((f) => !isOwn(f) && !res.some((re) => re.test(f)));
}

function sh(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) =>
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim().slice(-2000) })),
  );
}

export class Acceptance {
  readonly dir: string;
  private record: AcceptanceRecord | null;
  private running: Promise<void> | null = null;
  private stopAsked = false;

  constructor(
    readonly root: string,
    private readonly deps: AcceptanceDeps,
  ) {
    this.dir = path.join(root, ".agent-together", "acceptance");
    this.record = this.latestOnDisk();
    if (this.record?.status === "running") {
      this.record.status = "stopped";
      this.record.note = "上次验收没有做完（程序被关掉了），需要重新验收";
      this.save();
    }
  }

  private latestOnDisk(): AcceptanceRecord | null {
    if (!fs.existsSync(this.dir)) return null;
    const ids = fs.readdirSync(this.dir).filter((f) => /^\d{8}-\d+/.test(f)).sort().reverse();
    for (const id of ids) {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.dir, id, "record.json"), "utf8"));
      } catch {}
    }
    return null;
  }

  get current(): AcceptanceRecord | null {
    return this.record ? structuredClone(this.record) : null;
  }

  get busy(): boolean {
    return !!this.running;
  }

  private runDir(id = this.record!.id) {
    return path.join(this.dir, id);
  }

  /** Absolute path of a screenshot or package named in the record (project-relative). */
  file(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (path.relative(this.dir, abs).startsWith("..")) throw new Error("不是验收记录里的文件");
    return abs;
  }

  private save() {
    if (!this.record) return;
    fs.mkdirSync(this.runDir(), { recursive: true });
    fs.writeFileSync(path.join(this.runDir(), "record.json"), JSON.stringify(this.record, null, 2) + "\n");
    this.deps.onChange?.(this.current!);
  }

  private setLayer(id: LayerId, status: Layer["status"], detail: string) {
    const l = this.record!.layers.find((x) => x.id === id)!;
    l.status = status;
    l.detail = detail;
    this.save();
  }

  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  stop() {
    if (this.running) this.stopAsked = true;
  }

  start(): AcceptanceRecord {
    if (this.running) throw new Error("正在验收");
    const spec = this.deps.spec();
    if (!spec?.scenarios.length) throw new Error("先确认这一版的需求和使用场景，才能按场景验收");
    const config = this.deps.runConfig();
    if (!config?.start) throw new Error("还不知道怎么启动产品：先在「产品预览」里让它能启动");
    const at = new Date();
    this.record = {
      id: `${stamp(at)}-accept`,
      version: spec.version,
      startedAt: at.toISOString(),
      status: "running",
      note: "开始验收",
      checkpoint: null,
      serviceMode: this.deps.serviceMode(),
      layers: ORDER.map((id) => layer(id)),
      scenarios: spec.scenarios.map((s) => ({ id: s.id, name: s.name, status: "pending", beats: [], replans: 0, networkProblems: [] })),
      package: null,
      // What the user said does not match stays until they say it matches; a "matches" is asked again after changes.
      user: Object.fromEntries(Object.entries(this.record?.version === spec.version ? this.record.user : {}).filter(([, u]) => !u.ok)),
      llmCalls: 0,
    };
    this.stopAsked = false;
    this.save();
    this.running = this.run(spec, config)
      .catch((err) => {
        const r = this.record!;
        r.status = "error";
        r.note = `验收没能做完：${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        const r = this.record!;
        r.endedAt = new Date().toISOString();
        if (this.stopAsked && r.status === "running") {
          r.status = "stopped";
          r.note = "验收被结束了";
        }
        for (const l of r.layers) if (l.status === "pending" || l.status === "running") l.status = "skipped";
        this.save();
        this.running = null;
      });
    return this.current!;
  }

  /** The user's walk through one scenario: it matches, or what does not. */
  confirm(scenarioId: string, ok: boolean, note = ""): AcceptanceRecord {
    const r = this.record;
    if (!r) throw new Error("还没有验收记录");
    if (!r.scenarios.some((s) => s.id === scenarioId)) throw new Error(`没有场景 ${scenarioId}`);
    if (!ok && !note.trim()) throw new Error("写一下哪里不符合");
    r.user[scenarioId] = { ok, ...(ok ? {} : { note: note.trim() }), at: new Date().toISOString() };
    this.save();
    return this.current!;
  }

  /** Everything automatic passed. */
  get autoPassed(): boolean {
    return this.record?.status === "passed";
  }

  /** What is still missing before the version can be saved as stable, in plain words; empty when nothing. */
  missing(): string[] {
    const r = this.record;
    if (!r) return ["还没有验收"];
    const out: string[] = [];
    if (r.status !== "passed") out.push("自动验收还没有全部通过");
    const notYet = r.scenarios.filter((s) => !r.user[s.id]?.ok);
    if (notYet.length) out.push(`还要你亲手确认：${notYet.map((s) => s.id).join("、")}`);
    return out;
  }

  /** What to hand to the assistant: automatic failures and the user's "doesn't match" notes, each with its evidence. */
  fixes(): { scenarioId: string | null; task: string; tasks: string[] }[] {
    const r = this.record;
    const spec = this.deps.spec();
    if (!r || !spec) return [];
    const shots = path.join(this.runDir(), "shots");
    const out: { scenarioId: string | null; task: string; tasks: string[] }[] = [];
    const finished = r.status === "passed" || r.status === "failed" || r.status === "error";
    // Acceptance could not go on because of the product (it would not start, say): that is the first thing to fix.
    if (r.status === "error" && /启动不了/.test(r.note)) out.push({ scenarioId: null, task: `按使用场景验收时停住了：${r.note}\n\n请修好，让产品能正常启动和使用。`, tasks: [] });
    for (const l of r.layers) {
      if (!finished || l.status !== "failed" || ["interface", "interaction", "persistence", "scenarios"].includes(l.id)) continue;
      out.push({ scenarioId: null, task: `验收时「${l.name}」没有通过：${l.detail}\n\n请修好。`, tasks: [] });
    }
    for (const s of r.scenarios) {
      const tasks = spec.scenarios.find((x) => x.id === s.id)?.tasks ?? [];
      // An acceptance that did not finish (stopped, the app closed) is no evidence against the product.
      if (finished && (s.status === "failed" || s.status === "error")) out.push({ scenarioId: s.id, task: s.error ? `按使用场景验收「${s.id} ${s.name}」时出错：${s.error}` : failureTask(s, shots), tasks });
      const u = r.user[s.id];
      if (u && !u.ok) out.push({ scenarioId: s.id, task: `用户亲手走了一遍「${s.id} ${s.name}」，说不符合：\n${u.note}\n\n请按用户说的改，改完这个场景要仍然按需求走通。`, tasks });
    }
    return out;
  }

  private async run(spec: Spec, config: RunConfig) {
    const r = this.record!;
    ensureGitignore(this.root);
    const stopped = () => this.stopAsked;

    // Where the data is: the sandbox starts without it, the package leaves it out.
    let data = config.data;
    if (!data) {
      data = fs.existsSync(path.join(this.root, "data")) ? ["data/"] : [];
      if (!data.length && this.deps.llm) {
        r.llmCalls++;
        data = await proposeDataPaths(this.deps.llm, spec, fs.readdirSync(this.root), dataHints(this.root)).catch(() => []);
      }
      config = saveRunConfig(this.root, { ...config, data });
    }

    r.checkpoint = this.deps.checkpoint(`验收前（第 ${r.version} 版）`);
    r.note = "跑单元测试";
    this.setLayer("tests", "running", "");
    const tests = await this.deps.runTests();
    if (!tests) this.setLayer("tests", "failed", "项目没有测试命令");
    else if (!tests.passed) this.setLayer("tests", "failed", `测试没有通过（${tests.fail ?? "?"} 个失败）：${tests.output.split("\n").filter((l) => /✖|fail|error/i.test(l)).slice(0, 3).join("；")}`);
    else if (!tests.pass) this.setLayer("tests", "failed", "测试命令跑了，但一个测试都没有");
    else this.setLayer("tests", "passed", `${tests.pass} 个测试全部通过（${tests.command}）`);

    const left = versionCards(this.deps.canvas(), spec);
    this.setLayer(
      "audit",
      left.length ? "failed" : "passed",
      left.length ? `还有 ${left.length} 张卡片没有通过检查：${left.map((n) => n.title).join("、")}` : "这一版的卡片都做完了，每张都通过了事后检查和测试",
    );
    if (stopped()) return;

    const sandbox = path.join(os.tmpdir(), "agent-together-accept", createHash("sha1").update(this.root).digest("hex").slice(0, 10));
    const env: NodeJS.ProcessEnv = { AT_DATA_DIR: path.join(sandbox, "data") };
    const product = this.deps.product?.(sandbox) ?? new ProductProcess(sandbox);
    let driver: (PageDriver & { close(): void }) | null = null;
    try {
      r.note = "准备一份不带数据的产品副本";
      this.save();
      makeSandbox(this.root, data, sandbox);

      const pkgJson = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(sandbox, "package.json"), "utf8"));
        } catch {
          return null;
        }
      })();
      const build = config.build ?? (pkgJson?.scripts?.build ? "npm run build" : null);
      if (build) {
        this.setLayer("build", "running", build);
        const b = await sh(build, sandbox, 10 * 60_000);
        this.setLayer("build", b.ok ? "passed" : "failed", b.ok ? `${build} 成功` : `${build} 失败：${b.output.split("\n").slice(-3).join("；")}`);
      } else this.setLayer("build", "skipped", "这个产品不需要构建，直接运行");
      if (stopped()) return;

      r.note = "启动产品副本";
      this.save();
      const status = await product.start(config, r.serviceMode, 90_000, env);
      if (status.state !== "running" || !status.url) throw new Error(`产品副本启动不了：${status.error ?? "没有响应"}`);
      let base = new URL(status.url).origin;

      const shotsDir = path.join(this.runDir(), "shots");
      fs.mkdirSync(shotsDir, { recursive: true });
      driver = await this.deps.openDriver(path.join(sandbox, ".downloads"));
      const d = driver;
      const acceptEnv: AcceptanceEnv = {
        driver: d,
        root: sandbox,
        base: () => base,
        restart: async () => {
          const again = await product.start(config, r.serviceMode, 90_000, env);
          if (again.state !== "running" || !again.url) throw new Error(`重启后产品启动不了：${again.error ?? "没有响应"}`);
          base = new URL(again.url).origin;
          return base;
        },
        saveShot: (name, png) => {
          const file = path.join(shotsDir, `${name}.png`);
          fs.writeFileSync(file, png);
          return path.relative(this.root, file).replace(/\\/g, "/");
        },
        judge: this.deps.llm
          ? async (q, page) => {
              r.llmCalls++;
              return judgePage(this.deps.llm!, q, page, judgeContext);
            }
          : undefined,
        stopped,
      };

      let judgeContext = "";
      const keep = `${sandbox}-before-errors`;
      const sandboxData = [...data, "data/"];
      const code = frontEndCode(sandbox);
      const plansDir = path.join(this.dir, "plans");
      const done: Scenario[] = [];
      for (const scenario of spec.scenarios) {
        if (stopped()) return;
        const slot = r.scenarios.find((s) => s.id === scenario.id)!;
        slot.status = "running";
        judgeContext = `${scenario.id} ${scenario.name}\n输入：\n${scenario.input}\n期望：\n${scenario.expected.join("\n")}`;
        r.note = `按场景验收：${scenario.id} ${scenario.name}`;
        this.save();
        await d.goto(`${base}${config.path && config.path !== "/" ? config.path : "/"}`);
        let beats = this.cachedPlan(plansDir, scenario);
        if (!beats) {
          if (!this.deps.llm) throw new Error("第一次验收需要帮手模型来写验收脚本，请先在设置里打开帮手模型");
          r.note = `写验收脚本：${scenario.id}`;
          this.save();
          const snapshot = await d.eval<string>(SNAPSHOT_JS).catch(() => "（读不到页面）");
          r.llmCalls++;
          beats = await planScenario(this.deps.llm, planPrompt(spec, scenario, code, done, snapshot), scenario.id);
          this.savePlan(plansDir, scenario, beats);
          r.note = `按场景验收：${scenario.id} ${scenario.name}`;
          this.save();
        }
        const llm = this.deps.llm;
        const { result, beats: finalBeats } = await runScenario(scenario, beats, acceptEnv, {
          replan: llm
            ? async (doneBeats, failed, rest) => {
                r.llmCalls++;
                const snapshot = await d.eval<string>(SNAPSHOT_JS).catch(() => "（读不到页面）");
                return planScenario(llm, replanPrompt(spec, scenario, code, doneBeats, failed, rest, snapshot), `${scenario.id}-r`).catch(() => null);
              }
            : null,
          onBeat: (partial) => {
            Object.assign(slot, partial, { status: "running" });
            this.save();
          },
          // What the error checks provoke stays out of the next scenario: data back as before them, product restarted.
          beforeErrors: async () => {
            fs.rmSync(keep, { recursive: true, force: true });
            fs.mkdirSync(keep, { recursive: true });
            for (const f of dataFiles(sandbox, sandboxData)) {
              fs.mkdirSync(path.dirname(path.join(keep, f)), { recursive: true });
              fs.copyFileSync(path.join(sandbox, f), path.join(keep, f));
            }
          },
          afterErrors: async () => {
            await product.stop();
            for (const f of dataFiles(sandbox, sandboxData)) fs.rmSync(path.join(sandbox, f), { force: true });
            for (const f of walkFiles(keep)) {
              fs.mkdirSync(path.dirname(path.join(sandbox, f)), { recursive: true });
              fs.copyFileSync(path.join(keep, f), path.join(sandbox, f));
            }
            await acceptEnv.restart();
          },
        });
        Object.assign(slot, result);
        if (result.replans) this.savePlan(plansDir, scenario, finalBeats);
        done.push(scenario);
        this.save();
      }
      for (const l of scenarioLayers(r.scenarios, spec.scenarios, r.serviceMode)) this.setLayer(l.id, l.status, l.detail);
    } finally {
      driver?.close();
      await product.stop();
      try {
        removeTree(sandbox);
        fs.rmSync(`${sandbox}-before-errors`, { recursive: true, force: true });
      } catch {} // a file still held open: the next acceptance replaces it
    }
    if (stopped()) return;

    // The delivery package, from the code exactly as accepted, started for real.
    r.note = "做交付的启动包并试启动";
    this.setLayer("delivery", "running", "");
    const out = path.join(os.tmpdir(), "agent-together-package", createHash("sha1").update(this.root).digest("hex").slice(0, 10));
    const name = `${readProjectInfo(this.root).name}-第${r.version}版`;
    const readme = instructions(spec, { name: readProjectInfo(this.root).name, serviceMode: r.serviceMode, data, limits: this.limits() });
    const probe = this.deps.product?.(path.join(out, name)) ?? new ProductProcess(path.join(out, name));
    try {
      const pkg = buildPackage({ root: this.root, commit: r.checkpoint?.commit ?? null, config, serviceMode: r.serviceMode, readme, outDir: out, name });
      const zip = path.join(this.runDir(), `${name}.zip`);
      fs.copyFileSync(pkg.zip, zip);
      r.package = { zip: path.relative(this.root, zip).replace(/\\/g, "/"), files: pkg.files };
      const needsInstall = !!(config.install || (fs.existsSync(path.join(pkg.dir, "package.json")) && Object.keys(JSON.parse(fs.readFileSync(path.join(pkg.dir, "package.json"), "utf8")).dependencies ?? {}).length));
      const started = await probe.start({ ...config, install: config.install ?? (needsInstall ? "npm install" : undefined) }, r.serviceMode, 180_000, { AT_DATA_DIR: path.join(pkg.dir, "data") });
      this.setLayer(
        "delivery",
        started.state === "running" ? "passed" : "failed",
        started.state === "running" ? `启动包（${pkg.files} 个文件，含「启动.bat」和使用说明）在一个新文件夹里启动成功` : `启动包启动不了：${started.error ?? "没有响应"}`,
      );
    } catch (err) {
      this.setLayer("delivery", "failed", `做启动包失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await probe.stop();
      try {
        removeTree(out);
      } catch {}
    }

    const failed = r.layers.filter((l) => l.status === "failed");
    r.status = failed.length ? "failed" : "passed";
    r.note = failed.length
      ? `自动验收没有通过：${failed.map((l) => l.name).join("、")}`
      : `自动验收全部通过。下一步：按场景亲手走一遍，每个场景选「符合」或「不符合」`;
  }

  /** Known limits for the instructions: what was not checked automatically. */
  limits(): string[] {
    const r = this.record;
    if (!r) return [];
    return r.scenarios.flatMap((s) => s.beats.filter((b) => b.status === "manual").map((b) => `没有自动检查：「${b.ref}」（${b.manual}）`));
  }

  private cachedPlan(dir: string, scenario: Scenario): Beat[] | null {
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(dir, `${scenario.id}.json`), "utf8")) as ScenarioPlan;
      return plan.basis === scenarioBasis(scenario) && plan.beats.length ? plan.beats : null;
    } catch {
      return null;
    }
  }

  private savePlan(dir: string, scenario: Scenario, beats: Beat[]) {
    fs.mkdirSync(dir, { recursive: true });
    const plan: ScenarioPlan = { scenarioId: scenario.id, basis: scenarioBasis(scenario), createdAt: new Date().toISOString(), beats };
    fs.writeFileSync(path.join(dir, `${scenario.id}.json`), JSON.stringify(plan, null, 2) + "\n");
  }

  /** Forget a scenario's script, so the next acceptance writes it again. */
  forgetPlan(scenarioId: string) {
    fs.rmSync(path.join(this.dir, "plans", `${scenarioId}.json`), { force: true });
  }

  dataFilesNow(data: string[]) {
    return dataFiles(this.root, data);
  }
}
