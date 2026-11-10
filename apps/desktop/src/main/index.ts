import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { claudeCodeCompiler, claudeCodeRunner } from "@agent-together/adapter-claude-code";
import { agentSkillsCompiler, codexRunner } from "@agent-together/adapter-codex";
import { cursorAgentCommand, cursorRulesCompiler, cursorRunner } from "@agent-together/adapter-cursor";
import { grokAgentCommand, grokRunner } from "@agent-together/adapter-grok";
import {
  draftRole,
  Evolution,
  ExperienceStore,
  buildNodeContext,
  capabilityFromNode,
  checkSetup,
  compileCapabilities,
  contextSections,
  createProject,
  listModels,
  guessTestCommand,
  initGit,
  listFiles,
  understandProject,
  checkSource,
  evidenceFor,
  staleSources,
  type ImportProposal,
  type ProposedItem,
  splitByVerifier,
  verifierKey,
  verifierLabel,
  projectModels,
  saveProjectModels,
  saveRaceAgents,
  dispatchPrompt,
  estimateTokens,
  loadRaceConfig,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
  newNodeId,
  openProject,
  openTerminal,
  planCanvas,
  backupCanvas,
  draftSpec,
  planFromSpec,
  requirementsTurn,
  SpecStore,
  specImpact,
  guessRunConfig,
  Engine,
  DEFAULT_LIMITS,
  versionCards,
  type DecisionOption,
  type EngineLimits,
  Acceptance,
  Versions,
  codeChangedSince,
  restorePreview,
  restoreVersion,
  saveRunConfig,
  proposeRunConfig,
  readRunConfig,
  verifyRunConfig,
  type RunConfig,
  type SpecPlan,
  readProjectInfo,
  runProjectTests,
  testCommandFor,
  testHistory,
  writeProjectInfo,
} from "@agent-together/core";
import { Capability, ranNoTests } from "@agent-together/schema";
import type { AgentRunner, CanvasEdge, CanvasNode, Memory } from "@agent-together/schema";
import { Session } from "./session";
import { openAcceptanceBrowser } from "./acceptance-browser";

const compilers = [claudeCodeCompiler, agentSkillsCompiler, cursorRulesCompiler];
const runners: Record<string, (model?: string) => AgentRunner> = { "claude-code": claudeCodeRunner, codex: codexRunner, cursor: cursorRunner, "grok-build": grokRunner };
type Agent = "claude-code" | "codex" | "cursor" | "grok-build";

/**
 * The observer hook program the agents run with the system's Node.js. Installed app:
 * the single-file bundle unpacked next to app.asar (Node cannot read inside asar).
 * Dev without a bundle: the build of the sibling workspace package.
 */
const hookProgram = () => {
  const bundled = path.join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), "out/hook/agent-together-hook.mjs");
  return fs.existsSync(bundled) ? bundled : path.resolve(app.getAppPath(), "../../packages/hook/dist/agent-together-hook.js");
};

/** Interactive command line that starts each agent on a prompt (and model) in a new terminal window. */
function agentCommandLine(agent: Agent, prompt: string, model?: string): string {
  const quoted = `${model && /^[\w.\-[\]=,:]+$/.test(model) ? `--model ${model} ` : ""}"${prompt}"`;
  switch (agent) {
    case "codex":
      return `codex ${quoted}`;
    case "cursor":
      return `"${cursorAgentCommand()}" ${quoted}`;
    case "grok-build":
      return `"${grokAgentCommand()}" ${quoted}`;
    default:
      return `claude ${quoted}`;
  }
}

// Recent projects, setup completion and default models live in the app's own folder (not in projects).
const recentFile = () => path.join(app.getPath("userData"), "recent-projects.json");
const setupDoneFile = () => path.join(app.getPath("userData"), "setup-done.json");
const modelsFile = () => path.join(app.getPath("userData"), "models.json");
const llmFile = () => path.join(app.getPath("userData"), "llm.json");
const APP_FILES = ["recent-projects.json", "setup-done.json", "models.json", "llm.json"];

/**
 * Before the app was named "Agent Together" its folder was named after the package
 * (@agent-together/desktop); carries the app's own files over once so recent projects stay.
 */
function carryOverOldAppData() {
  const old = path.join(app.getPath("appData"), "@agent-together", "desktop");
  for (const name of APP_FILES) {
    const from = path.join(old, name);
    const to = path.join(app.getPath("userData"), name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * On macOS and Linux an app started from the Dock or a launcher gets a bare PATH
 * (/usr/bin:/bin…), so node, git and the assistants' command lines installed with
 * Homebrew, nvm or npm are not found. Takes the PATH the user's login shell sets up.
 */
function useLoginShellPath() {
  if (process.platform === "win32") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__AGENT_TOGETHER_PATH__";
    const out = execFileSync(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const found = out.split(marker)[1];
    if (found) process.env.PATH = [...new Set([...found.split(":"), ...(process.env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  } catch {} // keep the PATH we have; the setup wizard will say what is missing
}

/** The helper model last chosen in any project (provider, model, baseUrl); a new project starts with it. */
function defaultLlm(): Pick<LlmConfig, "provider" | "model" | "baseUrl"> | null {
  try {
    return JSON.parse(fs.readFileSync(llmFile(), "utf8"));
  } catch {
    return null;
  }
}

/** Models last chosen in any project; a new project starts with them. */
function defaultModels(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(modelsFile(), "utf8"));
  } catch {
    return {};
  }
}
function recentProjects(): string[] {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), "utf8"));
  } catch {
    return [];
  }
}
function remember(root: string) {
  const list = [root, ...recentProjects().filter((r) => r !== root)].slice(0, 12);
  fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
  fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2));
}
function setupCompleted(): boolean {
  try {
    return Boolean(JSON.parse(fs.readFileSync(setupDoneFile(), "utf8")).completed);
  } catch {
    return false;
  }
}
function markSetupCompleted() {
  fs.mkdirSync(path.dirname(setupDoneFile()), { recursive: true });
  fs.writeFileSync(setupDoneFile(), JSON.stringify({ completed: true, at: new Date().toISOString() }, null, 2));
}

async function main() {
  useLoginShellPath();
  await app.whenReady();
  carryOverOldAppData();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Agent Together",
    // The installed app takes its icon from the exe; in dev, use the source image.
    ...(app.isPackaged ? {} : { icon: path.join(app.getAppPath(), "build/icon.png") }),
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });

  let session: Session | null = null;
  const need = (): Session => {
    if (!session) throw new Error("还没有打开项目");
    return session;
  };
  const switchTo = async (root: string) => {
    await session?.close();
    session = null;
    session = await Session.open(root, win);
    try {
      session.daemon.memory.refreshAgentFiles(); // older versions mirrored every card's memories
    } catch {}
    attachEngine(session);
    attachAcceptance(session);
    remember(root);
    win.setTitle(`${session.name} - Agent Together`);
    win.webContents.send("agent-together:project", session.info());
    return session.info();
  };

  // First-launch setup wizard: probes live in packages/core (testable); completion in userData.
  ipcMain.handle("agent-together:setupCheck", () => checkSetup());
  ipcMain.handle("agent-together:setupCompleted", () => setupCompleted());
  ipcMain.handle("agent-together:setupMarkDone", () => {
    markSetupCompleted();
  });
  // The page names an assistant; the command comes from the probe here, never from the page.
  ipcMain.handle("agent-together:setupOpenTerminal", async (_e, id: string) => {
    const report = await checkSetup();
    const command = report.requirements.find((r) => r.id === id)?.loginCommand;
    if (!command) throw new Error("这个助手现在不需要登录，或者还没装好");
    openTerminal(app.getPath("home"), command, "Agent Together - 安装向导");
  });
  ipcMain.handle("agent-together:setupCopy", (_e, text: string) => {
    clipboard.writeText(text);
  });

  // Projects: start screen, create, open, switch.
  ipcMain.handle("agent-together:recentProjects", () =>
    recentProjects().map((root) => {
      const exists = fs.existsSync(path.join(root, ".agent-together"));
      return { root, exists, name: exists ? readProjectInfo(root).name : path.basename(root) };
    }),
  );
  ipcMain.handle("agent-together:chooseFolder", async (_e, title: string) => {
    const res = await dialog.showOpenDialog(win, { title, properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });
  /** Switching or closing the project would cut off whatever it is doing. */
  const notBusy = () => {
    if (session?.busy) throw new Error(`正在${session.busy}，等它结束再换项目`);
  };
  ipcMain.handle("agent-together:createProject", async (_e, parent: string, name: string, description: string) => {
    notBusy();
    const folder = name.trim().replace(/[<>:"/\\|?*]+/g, "-");
    if (!folder) throw new Error("请填写项目名");
    const root = createProject(path.join(parent, folder), name.trim());
    if (description.trim()) writeProjectInfo(root, { description: description.trim() });
    saveProjectModels(root, defaultModels());
    const llm = defaultLlm();
    if (llm) saveLlmConfig(root, llm);
    const info = await switchTo(root);
    need().installHooks(hookProgram());
    return info;
  });
  ipcMain.handle("agent-together:openProject", async (_e, dir: string) => {
    notBusy();
    const { root, created } = openProject(dir);
    if (created) {
      // Like a new project: start with the models last chosen (before the session reads them).
      saveProjectModels(root, defaultModels());
      const llm = defaultLlm();
      if (llm) saveLlmConfig(root, llm);
    }
    const info = await switchTo(root);
    if (created) need().installHooks(hookProgram());
    return info;
  });
  ipcMain.handle("agent-together:closeProject", async () => {
    notBusy();
    await session?.close();
    session = null;
    win.setTitle("Agent Together");
  });
  ipcMain.handle("agent-together:info", () => session?.info() ?? null);
  ipcMain.handle("agent-together:busy", () => session?.busy ?? null);
  ipcMain.handle("agent-together:recentLog", () => need().daemon.store.recentLog(100));
  ipcMain.handle("agent-together:projectInfo", () => readProjectInfo(need().root));
  // Which model each assistant uses: per project, remembered as the default for new ones.
  let modelList: ReturnType<typeof listModels> | null = null;
  ipcMain.handle("agent-together:listModels", (_e, refresh?: boolean) => {
    // Listing runs the assistants' command lines (a few seconds), so it is done once per app start.
    if (!modelList || refresh) modelList = listModels();
    return modelList;
  });
  ipcMain.handle("agent-together:projectModels", () => projectModels(need().root));
  // The helper model: plans canvases, drafts roles, proposes evolution strategies, reviews each turn.
  ipcMain.handle("agent-together:llmSettings", () => {
    const s = need();
    const { provider, model, baseUrl } = loadLlmConfig(s.root);
    return { provider: provider ?? "auto", model: model ?? "", baseUrl: baseUrl ?? "", name: s.llm?.name ?? null };
  });
  ipcMain.handle("agent-together:saveLlmSettings", async (_e, patch: Pick<LlmConfig, "provider" | "model" | "baseUrl">) => {
    const s = need();
    if (s.running || s.racing) throw new Error("AI 助手正在工作，等它做完再换");
    if (patch.provider === "openai-compatible" && (!patch.baseUrl?.trim() || !patch.model?.trim())) {
      throw new Error("请填好服务地址和模型名");
    }
    const saved = saveLlmConfig(s.root, patch);
    fs.mkdirSync(path.dirname(llmFile()), { recursive: true });
    fs.writeFileSync(llmFile(), JSON.stringify({ provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl }, null, 2));
    return switchTo(s.root); // the observer and helper start again with the new model
  });
  ipcMain.handle("agent-together:saveProjectModels", (_e, models: Record<string, string>) => {
    saveProjectModels(need().root, models);
    fs.mkdirSync(path.dirname(modelsFile()), { recursive: true });
    fs.writeFileSync(modelsFile(), JSON.stringify(projectModels(need().root), null, 2));
    return projectModels(need().root);
  });
  ipcMain.handle("agent-together:saveProjectInfo", (_e, patch: { description?: string; stack?: string; testCommand?: string }) =>
    writeProjectInfo(need().root, patch),
  );

  // Canvas: AI plan, then edit by hand. Every change is validated and written to .agent-together/canvas/.
  ipcMain.handle("agent-together:planCanvas", async (_e, description: string) => {
    const s = need();
    if (!s.llm) throw new Error("没有可用的帮手模型：请在右边「帮手模型」里选一个，或先登录 claude 命令行");
    const plan = await planCanvas(s.llm, description);
    s.daemon.store.writeCanvas({ ...plan.canvas, nodes: plan.canvas.nodes.map(({ role, ...node }) => node) });
    writeProjectInfo(s.root, { description: description.trim(), stack: plan.stack, ...(plan.testCommand ? { testCommand: plan.testCommand } : {}) });
    s.canvasChanged();
    return plan;
  });
  /*
   * Requirements first (phase one, M1): a conversation with the helper model as product
   * manager, a requirements spec with usage scenarios the user confirms, then the canvas
   * planned from it (or the existing canvas migrated, after the user has seen the plan).
   */
  const specContext = (s: Session) => ({ name: s.name, description: readProjectInfo(s.root).description, canvas: s.daemon.canvas });
  const needLlm = (s: Session) => {
    if (!s.llm) throw new Error("没有可用的帮手模型：请在右边「帮手模型」里选一个，或先登录 claude 命令行");
    return s.llm;
  };
  const specState = (s: Session) => {
    const store = new SpecStore(s.root);
    const spec = store.load();
    const confirmed = store.confirmed();
    return {
      spec,
      confirmed,
      conversation: store.conversation(),
      decisions: store.decisions(),
      impact: spec ? specImpact(confirmed, spec, s.daemon.canvas) : null,
      pendingPlan: s.pendingPlan,
      cards: s.daemon.canvas.nodes.length,
      hasLlm: !!s.llm,
    };
  };
  ipcMain.handle("agent-together:specState", () => specState(need()));
  // The user says something (or, with no text, asks for the last reply again after a failure); the product manager answers.
  ipcMain.handle("agent-together:specSay", async (_e, text?: string) => {
    const s = need();
    const llm = needLlm(s);
    const store = new SpecStore(s.root);
    if (text?.trim()) store.say({ role: "user", text: text.trim() });
    const turn = await requirementsTurn(llm, store.conversation(), specContext(s));
    store.say({ role: "assistant", text: turn.text, questions: turn.questions, ready: turn.ready });
    return specState(s);
  });
  ipcMain.handle("agent-together:specDraft", async () => {
    const s = need();
    const store = new SpecStore(s.root);
    const spec = await draftSpec(needLlm(s), store.conversation(), specContext(s), store.load() ?? store.confirmed());
    store.save(spec);
    return specState(s);
  });
  ipcMain.handle("agent-together:specSave", (_e, spec: unknown) => {
    const s = need();
    new SpecStore(s.root).save(spec);
    return specState(s);
  });
  ipcMain.handle("agent-together:specConfirm", (_e, input: unknown) => {
    const s = need();
    const store = new SpecStore(s.root);
    const saved = store.save(input);
    const impact = specImpact(store.confirmed(), saved, s.daemon.canvas);
    const detail = store.confirmed()
      ? [
          impact.scenarios.added.length && `新增场景：${impact.scenarios.added.map((x) => `${x.id} ${x.name}`).join("；")}`,
          impact.scenarios.removed.length && `去掉场景：${impact.scenarios.removed.map((x) => `${x.id} ${x.name}`).join("；")}`,
          impact.scenarios.changed.length && `修改场景：${impact.scenarios.changed.map((x) => `${x.id} ${x.name}`).join("；")}`,
          impact.cards.length && `涉及卡片：${impact.cards.map((c) => c.title).join("、")}`,
        ].filter(Boolean).join("\n")
      : saved.scenarios.map((x) => `${x.id} ${x.name}`).join("\n");
    const spec = store.confirm(saved, detail || undefined);
    if (!readProjectInfo(s.root).description?.trim() && spec.goal) writeProjectInfo(s.root, { description: spec.goal });
    return specState(s);
  });
  /** Writes a planned canvas: a backup and a checkpoint first, then the cards, then the scenarios' links to them. */
  const applySpecPlan = async (s: Session, plan: SpecPlan) =>
    s.exclusive("按需求调整画布", () => {
      const store = new SpecStore(s.root);
      const migrating = s.daemon.canvas.nodes.length > 0;
      const backup = migrating ? backupCanvas(s.root) : null;
      if (migrating && s.hasGit) s.checkpoints.create("按需求调整画布之前", null);
      // Proposed roles are drafts until the user saves them: cards do not point at them yet.
      const canvas = s.daemon.store.writeCanvas({ ...plan.canvas, nodes: plan.canvas.nodes.map(({ role, ...node }) => node) });
      const info = readProjectInfo(s.root);
      writeProjectInfo(s.root, {
        ...(plan.stack && (!migrating || !info.stack) ? { stack: plan.stack } : {}),
        ...(plan.testCommand && !info.testCommand ? { testCommand: plan.testCommand } : {}),
      });
      store.linkCards(canvas);
      if (migrating)
        store.decide(
          "migrate-canvas",
          `按需求调整了画布：保留 ${plan.changes.filter((c) => c.change === "keep").length} 张，修改 ${plan.changes.filter((c) => c.change === "change").length} 张，新增 ${plan.changes.filter((c) => c.change === "new").length} 张，去掉 ${plan.removed.length} 张`,
          backup ? `原画布备份在 ${path.relative(s.root, backup)}` : undefined,
        );
      s.pendingPlan = null;
      s.canvasChanged();
      return { backup: backup ? path.relative(s.root, backup) : null };
    });
  // Plans the canvas from the confirmed spec. An empty canvas is written at once; an existing one waits for the user's review.
  ipcMain.handle("agent-together:specPlan", async () => {
    const s = need();
    const confirmed = new SpecStore(s.root).confirmed();
    if (!confirmed || new SpecStore(s.root).load()?.status !== "confirmed") throw new Error("先确认需求说明，再生成画布");
    const existing = s.daemon.canvas.nodes.length ? s.daemon.canvas : null;
    const plan = await planFromSpec(needLlm(s), confirmed, existing, existing ? listFiles(s.root) : []);
    if (existing) {
      s.pendingPlan = plan;
      return { plan, applied: false, backup: null };
    }
    const { backup } = await applySpecPlan(s, plan);
    return { plan, applied: true, backup };
  });
  ipcMain.handle("agent-together:specApplyPlan", async () => {
    const s = need();
    if (!s.pendingPlan) throw new Error("没有待采用的调整方案，请重新生成");
    return applySpecPlan(s, s.pendingPlan);
  });
  ipcMain.handle("agent-together:specDiscardPlan", () => {
    need().pendingPlan = null;
  });

  /*
   * The product (phase one, M2): how to start it, starting and stopping it, its page
   * shown in the window, and the user's verdict on the sample-data prototype.
   */
  const serviceMode = (s: Session): "mock" | "real" => {
    const services = new SpecStore(s.root).load()?.services ?? [];
    return services.length && services.every((v) => v.mode === "real") ? "real" : "mock";
  };
  const productState = (s: Session) => {
    const spec = new SpecStore(s.root).load();
    const config = readRunConfig(s.root);
    return {
      status: s.product.current,
      config,
      guess: config ? null : guessRunConfig(s.root, listFiles(s.root)),
      logs: s.product.logs(120),
      problems: s.preview.problems.slice(-30),
      /** How usable the preview is: the sample-data prototype, or a functional version. */
      stage: !spec ? null : spec.services.some((v) => v.mode === "mock") ? ("prototype" as const) : ("functional" as const),
      prototypeConfirmedAt: spec?.prototypeConfirmedAt ?? null,
      hasSpec: !!spec,
      hasLlm: !!s.llm,
    };
  };
  ipcMain.handle("agent-together:productState", () => productState(need()));
  // Finds how to start the product (the files first, else the helper model) and tries it for real; saved only when it worked.
  ipcMain.handle("agent-together:productDetect", async () => {
    const s = need();
    const files = listFiles(s.root);
    const config = guessRunConfig(s.root, files) ?? (s.llm ? await proposeRunConfig(s.llm, s.root, files) : null);
    if (!config) return { ok: false, error: "从文件看不出怎么启动这个产品。可以等 AI 写好服务器入口后再试，或者在下面手动填启动命令。", logs: [], config: null };
    await s.product.stop();
    return verifyRunConfig(s.root, config, serviceMode(s));
  });
  ipcMain.handle("agent-together:productSaveConfig", async (_e, config: RunConfig) => {
    const s = need();
    if (!config.start?.trim()) throw new Error("请填写启动命令");
    await s.product.stop();
    return verifyRunConfig(s.root, config, serviceMode(s));
  });
  ipcMain.handle("agent-together:productStart", async () => {
    const s = need();
    const config = readRunConfig(s.root);
    if (!config) throw new Error("还不知道怎么启动这个产品，先点「找出启动方式」");
    const status = await s.product.start(config, serviceMode(s));
    if (status.state === "running" && status.url) await s.preview.load(status.url);
    return productState(s);
  });
  ipcMain.handle("agent-together:productStop", async () => {
    const s = need();
    await s.product.stop();
    await s.preview.clear();
    return productState(s);
  });
  ipcMain.handle("agent-together:previewPlace", (_e, bounds: { x: number; y: number; width: number; height: number } | null) => session?.preview.place(bounds));
  ipcMain.handle("agent-together:previewReload", () => need().preview.reload());
  ipcMain.handle("agent-together:previewOpenExternal", () => {
    const url = need().product.current.url;
    if (url) void shell.openExternal(url);
  });
  ipcMain.handle("agent-together:prototypeVerdict", (_e, ok: boolean, feedback?: string) => {
    const s = need();
    if (!ok && !feedback?.trim()) throw new Error("说说哪里要改");
    new SpecStore(s.root).prototypeVerdict(ok, feedback);
    return productState(s);
  });

  // Importing existing code: a checklist to finish the first-pass canvas drawn from the folders.
  ipcMain.handle("agent-together:importStatus", () => {
    const s = need();
    const info = readProjectInfo(s.root);
    const nodes = s.daemon.canvas.nodes;
    return {
      imported: !!info.imported,
      reviewed: !!info.importReviewed,
      hasGit: s.hasGit,
      cards: nodes.length,
      emptyCards: nodes.filter((n) => !n.intent.goal.trim()).length,
      testCommand: testCommandFor(s.root),
      guessedTest: guessTestCommand(s.root, listFiles(s.root)),
      helper: s.llm?.name ?? null,
    };
  });
  ipcMain.handle("agent-together:understandProject", async (_e, only?: string) => {
    const s = need();
    if (!s.llm) throw new Error("没有可用的帮手模型：请在右边「帮手模型」里选一个，或先登录 claude 命令行");
    return understandProject(s.llm, s.root, s.daemon.canvas, listFiles(s.root), only);
  });
  // The page sends back what the user kept; citations are checked again here, never taken on trust.
  ipcMain.handle("agent-together:applyImportProposal", (_e, proposal: ImportProposal, chosen: string[]) => {
    const s = need();
    const canvas = s.daemon.canvas;
    const files = new Set(listFiles(s.root));
    for (const p of proposal.nodes.filter((n) => chosen.includes(n.id))) {
      const node = canvas.nodes.find((n) => n.id === p.id);
      if (!node) continue;
      const recheck = (i: ProposedItem): ProposedItem => {
        const sources = i.sources.map((src) => checkSource(s.root, canvas, node.id, src, files));
        return { text: i.text, sources, verified: sources.length > 0 && sources.every((x) => x.ok) };
      };
      const card = { goal: recheck(p.goal), acceptance: p.acceptance.map(recheck), unknowns: p.unknowns };
      s.daemon.store.saveNode({
        ...node,
        title: p.title || node.title,
        intent: { ...node.intent, goal: card.goal.text, acceptance: card.acceptance.map((a) => a.text), tasks: p.tasks },
        evidence: evidenceFor(s.root, card),
      });
    }
    const info = readProjectInfo(s.root);
    writeProjectInfo(s.root, {
      ...(proposal.description && !info.description ? { description: proposal.description } : {}),
      ...(proposal.stack && !info.stack ? { stack: proposal.stack } : {}),
      ...(proposal.testCommand && !info.testCommand ? { testCommand: proposal.testCommand } : {}),
    });
    s.canvasChanged();
  });
  // Cards whose description was written from code that has changed since: id -> changed files.
  ipcMain.handle("agent-together:staleCards", () => {
    const s = need();
    return Object.fromEntries(
      s.daemon.canvas.nodes.filter((n) => n.evidence).map((n) => [n.id, staleSources(s.root, n)] as const).filter(([, changed]) => changed.length),
    );
  });
  ipcMain.handle("agent-together:initGit", () => {
    const s = need();
    initGit(s.root);
    return switchTo(s.root); // checkpoints, races and evolution switch on
  });
  ipcMain.handle("agent-together:reviewImport", () => writeProjectInfo(need().root, { importReviewed: true }));
  ipcMain.handle("agent-together:roles", () => need().daemon.capabilities.list().filter((c) => c.kind === "agent"));
  ipcMain.handle("agent-together:draftRole", (_e, sentence: string) => draftRole(need().llm, sentence));
  ipcMain.handle("agent-together:saveRole", (_e, input: unknown) => {
    const s = need();
    const parsed = Capability.safeParse(input);
    if (!parsed.success) throw new Error("角色没有填完整：请检查编号、使用说明和工作说明");
    const role = parsed.data;
    if (role.kind !== "agent") throw new Error("只能保存角色");
    if (s.daemon.capabilities.list().some((c) => c.id === role.id)) {
      throw new Error("这个名字已经用过，请换一个角色编号");
    }
    s.daemon.capabilities.save(role);
    compileCapabilities(s.root, s.daemon.capabilities.list(), compilers);
    s.canvasChanged();
    return role;
  });
  ipcMain.handle("agent-together:canvas", () => need().daemon.canvas);
  ipcMain.handle("agent-together:addNode", (_e, title: string, kind: CanvasNode["kind"], position?: { x: number; y: number }) => {
    const s = need();
    const id = newNodeId(title, s.daemon.canvas.nodes.map((n) => n.id));
    const node = s.daemon.store.saveNode({ id, kind, title, position });
    s.canvasChanged();
    return node;
  });
  ipcMain.handle("agent-together:saveNode", (_e, node: CanvasNode) => {
    const s = need();
    const saved = s.daemon.store.saveNode(node);
    s.canvasChanged();
    return saved;
  });
  ipcMain.handle("agent-together:moveNodes", (_e, moves: { id: string; x: number; y: number }[]) => {
    const s = need();
    const nodes = s.daemon.canvas.nodes;
    for (const m of moves) {
      const node = nodes.find((n) => n.id === m.id);
      if (node) s.daemon.store.saveNode({ ...node, position: { x: Math.round(m.x), y: Math.round(m.y) } });
    }
    s.daemon.reload(); // positions only: no redraw needed
  });
  ipcMain.handle("agent-together:deleteNode", async (_e, id: string) => {
    const s = need();
    const node = s.daemon.canvas.nodes.find((n) => n.id === id);
    if (s.running?.nodeId === id) throw new Error(`AI 正在做「${node?.title ?? id}」，做完之前不能删除这张卡片`);
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["删除", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `删除卡片"${node?.title ?? id}"？`,
      detail: "只删除画布上的卡片和它的连线，不删除代码文件。",
    });
    if (response !== 0) return false;
    s.daemon.store.deleteNode(id);
    if (s.daemon.observer.activeNodeId === id) s.setActiveNode(null);
    s.canvasChanged();
    return true;
  });
  ipcMain.handle("agent-together:saveEdges", (_e, edges: CanvasEdge[]) => {
    const s = need();
    const saved = s.daemon.store.saveEdges(edges);
    s.canvasChanged();
    return saved;
  });

  ipcMain.handle("agent-together:setActive", (_e, nodeId: string | null) => need().setActiveNode(nodeId));
  ipcMain.handle("agent-together:installHooks", () => need().installHooks(hookProgram()));

  // Context inspector: what the agent would get, with sizes; memories can be left out per dispatch.
  // By default a memory proven with another assistant or model is left out (see splitByVerifier).
  const verifierFor = (s: Session, agent: string) => verifierKey(agent, loadRaceConfig(s.root).models?.[agent]);
  const defaultWithout = (s: Session, nodeId: string, agent: string) =>
    splitByVerifier(s.daemon.memory.forNode(nodeId), verifierFor(s, agent)).other.map((m) => m.id);
  const nodeMemories = (s: Session, nodeId: string, without: string[]) => s.daemon.memory.forNode(nodeId).filter((m) => !without.includes(m.id));
  const contextFor = (s: Session, nodeId: string, task: string, agent: string, without = defaultWithout(s, nodeId, agent)) =>
    buildNodeContext(s.daemon.canvas, nodeId, task, nodeMemories(s, nodeId, without), projectForContext(s, nodeId), s.daemon.capabilities.list());
  /** What every dispatch says about the project: description, stack, run conventions for web products, and the card's scenarios. */
  const projectForContext = (s: Session, nodeId: string) => {
    const spec = new SpecStore(s.root).confirmed() ?? new SpecStore(s.root).load();
    const mine = new Set(s.daemon.canvas.nodes.find((n) => n.id === nodeId)?.scenarios ?? []);
    return { ...readProjectInfo(s.root), webApp: !!spec || !!readRunConfig(s.root), scenarios: spec?.scenarios.filter((x) => mine.has(x.id)) ?? [] };
  };
  ipcMain.handle("agent-together:previewContext", (_e, nodeId: string, task: string, without: string[] | null, agent: string) => {
    const s = need();
    const effective = without ?? defaultWithout(s, nodeId, agent);
    const memories = s.daemon.memory.forNode(nodeId);
    const line = (m: Memory) => estimateTokens(`- （决策）${m.content}\n`);
    return {
      markdown: contextFor(s, nodeId, task, agent, effective),
      memories,
      without: effective,
      verifier: verifierLabel(verifierFor(s, agent)),
      labels: Object.fromEntries(memories.filter((m) => m.verifiedWith).map((m) => [m.id, verifierLabel(m.verifiedWith!)])),
      // What memories cost: the ones in this context, plus the project-wide ones that are
      // also in CLAUDE.md / AGENTS.md, which every agent reads when it starts.
      memoryTokens: memories.filter((m) => !effective.includes(m.id)).reduce((sum, m) => sum + line(m), 0),
      mirroredTokens: s.daemon.memory.list().filter((m) => m.status === "active" && m.nodeId === null).reduce((sum, m) => sum + line(m), 0),
    };
  });
  ipcMain.handle("agent-together:measureContext", (_e, markdown: string) => ({ tokens: estimateTokens(markdown), sections: contextSections(markdown) }));
  // Dispatch: checkpoint first, make the node active, write its context, open the agent on it.
  // `context`, when given, is the inspector's (possibly edited) text and is handed out as is.
  ipcMain.handle("agent-together:dispatch", (_e, nodeId: string, task: string, agent: Agent, context?: string) => {
    const s = need();
    if (s.busy) throw new Error(`正在${s.busy}，等它结束再试`);
    s.startDispatch(nodeId, agent);
    const file = s.daemon.store.writeContext(nodeId, context ?? contextFor(s, nodeId, task, agent));
    s.setActiveNode(nodeId);
    const node = s.daemon.canvas.nodes.find((n) => n.id === nodeId);
    if (node && node.status === "todo") {
      s.daemon.store.saveNode({ ...node, status: "in_progress", executor: agent });
      s.canvasChanged();
    }
    openTerminal(s.root, agentCommandLine(agent, dispatchPrompt(file), loadRaceConfig(s.root).models?.[agent]), `Agent Together - ${nodeId} - ${agent}`);
    return file;
  });

  /**
   * Tests after an agent's work: run the project's test command, and when it passes
   * save a checkpoint, so a green state is always one click away.
   */
  const testAndCheckpoint = async (s: Session, nodeId: string | null) => {
    // Before the tests: check every change since dispatch, including ones the hooks never saw.
    const audit = s.audit(nodeId);
    const tests = await runProjectTests(s.root, nodeId);
    win.webContents.send("agent-together:tests", tests);
    const title = s.daemon.canvas.nodes.find((n) => n.id === nodeId)?.title ?? "项目";
    // A green run that ran no test at all ("0/0") is no evidence: no "tests passed" checkpoint for it.
    const checkpoint = tests?.passed && !ranNoTests(tests) && s.hasGit ? s.checkpoints.create(`测试通过：${title}`, nodeId) : null;
    return { tests, checkpoint, audit };
  };
  ipcMain.handle("agent-together:runTests", (_e, nodeId: string | null) => need().exclusive("跑测试", () => testAndCheckpoint(need(), nodeId)));
  ipcMain.handle("agent-together:testHistory", () => testHistory(need().root));
  ipcMain.handle("agent-together:testCommand", () => testCommandFor(need().root));

  // In-app dispatch: the agent runs headless in the project, its words stream to the window,
  // its actions go through the hooks to the observer as usual; then the tests run.
  /**
   * One assistant run on a card, the way every dispatch in the app goes: checkpoint and
   * watch, context, the run itself (its words streamed to the window), then the
   * after-run check and the tests. Grants let an integration card also write the
   * files it connects, for this run only.
   */
  const executeAgent = async (
    s: Session,
    nodeId: string,
    task: string,
    agent: string,
    opts: { context?: string; grants?: string[]; timeoutMs?: number; signal?: AbortSignal; channel?: "agentText" | "engineText" } = {},
  ) => {
    if (!runners[agent]) throw new Error(`不认识的助手：${agent}`);
    const grants = opts.grants ?? [];
    s.startDispatch(nodeId, agent, grants);
    const file = s.daemon.store.writeContext(nodeId, opts.context ?? contextFor(s, nodeId, task, agent));
    s.daemon.setActiveNode(nodeId);
    s.daemon.observer.grants = grants;
    const node = s.daemon.canvas.nodes.find((n) => n.id === nodeId);
    if (node && node.status === "todo") s.daemon.store.saveNode({ ...node, status: "in_progress", executor: agent });
    s.canvasChanged();
    const stop = new AbortController();
    opts.signal?.addEventListener("abort", () => stop.abort());
    s.running = { nodeId, agent, stop };
    const send = (channel: string, payload: unknown) => win.webContents.send(`agent-together:${channel}`, payload);
    send("agentStatus", { nodeId, agent, state: "running" });
    try {
      const model = loadRaceConfig(s.root).models?.[agent];
      const run = await runners[agent](model).run(s.root, dispatchPrompt(file), opts.timeoutMs ?? 30 * 60_000, {
        signal: stop.signal,
        onText: (text) => send(opts.channel ?? "agentText", { nodeId, text }),
      });
      send("agentStatus", { nodeId, agent, state: "testing" });
      const { tests, checkpoint, audit } = run.summary === "已停止" ? { tests: null, checkpoint: null, audit: s.audit(nodeId) } : await testAndCheckpoint(s, nodeId);
      s.canvasChanged();
      return { run, tests, checkpoint, audit };
    } finally {
      s.running = null;
      s.daemon.observer.grants = [];
      send("agentStatus", { nodeId, agent, state: "idle" });
    }
  };

  // In-app dispatch: the agent runs headless in the project, its words stream to the window,
  // its actions go through the hooks to the observer as usual; then the tests run.
  ipcMain.handle("agent-together:runAgent", async (_e, nodeId: string, task: string, agent: Agent, context?: string) => {
    const s = need();
    if (s.running) throw new Error(`已有 AI 助手在运行（${s.running.nodeId}）`);
    const title = s.daemon.canvas.nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
    return s.exclusive(`让 AI 做「${title}」`, () => executeAgent(s, nodeId, task, agent, { context }));
  });

  /*
   * Automatic progress (phase one, M3): the engine decides what comes next; each step
   * is an executeAgent run, then (once the integration card is in) a real start of the
   * product. The run holds the project lock while it runs.
   */
  function attachEngine(s: Session) {
    const AUTO = "自动制作";
    const integrationDone = () => s.daemon.canvas.nodes.some((n) => n.id === "integration" && n.status === "done");
    s.engine = new Engine(s.root, {
      canvas: () => s.daemon.canvas,
      spec: () => new SpecStore(s.root).confirmed(),
      auditRequired: s.hasGit,
      checkpoint: (label, nodeId) => (s.hasGit ? s.checkpoints.create(label, nodeId).id : null),
      rollback: (id) => {
        s.checkpoints.rollback(id);
        s.canvasChanged();
      },
      markDone: (nodeId) => {
        const node = s.daemon.canvas.nodes.find((n) => n.id === nodeId);
        if (node) s.daemon.store.saveNode({ ...node, status: "done" });
        s.canvasChanged();
      },
      exec: async ({ nodeId, task, grants, timeoutMs, signal }) => {
        const agent = s.engine?.current?.agent ?? "claude-code";
        const outcome = await executeAgent(s, nodeId, task, agent, { grants, timeoutMs, signal, channel: "engineText" });
        // Once the cards that wire the product together are in, it has to start: try it for real.
        let productError: string | null = null;
        const passedSoFar = outcome.run.ok && outcome.tests?.passed;
        if (passedSoFar && (nodeId === "integration" || integrationDone())) {
          const config = readRunConfig(s.root) ?? guessRunConfig(s.root, listFiles(s.root));
          if (!config) productError = "还找不到启动命令（没有 start 脚本或 server.js 这类入口文件）";
          else {
            const shown = s.product.current.state === "running";
            await s.product.stop();
            const check = await verifyRunConfig(s.root, config, serviceMode(s));
            if (!check.ok) productError = [check.error ?? "没能启动", ...check.logs.slice(-8)].join("\n");
            else if (shown) {
              // The preview was open: show the new version there.
              const status = await s.product.start(check.config, serviceMode(s));
              if (status.state === "running" && status.url) await s.preview.load(status.url);
            }
          }
        }
        return { run: outcome.run, tests: outcome.tests, audit: outcome.audit as never, productError };
      },
      onChange: (run) => {
        if (run.status === "running" && s.busy !== AUTO) s.setBusy(AUTO);
        if (run.status !== "running" && s.busy === AUTO) s.setBusy(null);
        win.webContents.send("agent-together:runState", run);
        // Changes from acceptance are in: accept again, as the plan says ("修好后再验收一次").
        if (run.kind === "fix" && run.status === "done" && !run.tasks.some((t) => t.state === "skipped")) {
          setTimeout(() => {
            if (session === s && !s.busy) {
              try {
                startAcceptance(s);
              } catch {}
            }
          }, 500);
        }
      },
    });
  }
  const runInfo = (s: Session) => {
    const confirmed = new SpecStore(s.root).confirmed();
    const cards = versionCards(s.daemon.canvas, confirmed);
    return {
      run: s.engine?.current ?? null,
      open: !!s.engine?.open,
      version: confirmed?.version ?? null,
      confirmed: !!confirmed,
      /** What a new run would work through, in order. */
      upcoming: cards.map((n) => ({ id: n.id, title: n.title })),
      agents: Object.keys(runners),
      models: loadRaceConfig(s.root).models ?? {},
      limits: DEFAULT_LIMITS,
    };
  };
  ipcMain.handle("agent-together:runInfo", () => runInfo(need()));
  ipcMain.handle("agent-together:runStart", (_e, agent: string, limits?: Partial<EngineLimits>) => {
    const s = need();
    if (!runners[agent]) throw new Error("请选择一个助手");
    if (s.busy) throw new Error(`正在${s.busy}，等它结束再开始制作`);
    if (!new SpecStore(s.root).confirmed()) throw new Error("先在「需求与反馈」里确认第一版的需求，再开始制作");
    s.engine!.start({ agent, model: loadRaceConfig(s.root).models?.[agent], limits });
    return runInfo(s);
  });
  ipcMain.handle("agent-together:runPause", () => (need().engine!.pause(), runInfo(need())));
  ipcMain.handle("agent-together:runResume", () => {
    const s = need();
    if (s.busy && s.busy !== "自动制作") throw new Error(`正在${s.busy}，等它结束再继续`);
    s.engine!.resume();
    return runInfo(s);
  });
  ipcMain.handle("agent-together:runStop", () => (need().engine!.stop(), runInfo(need())));
  ipcMain.handle("agent-together:runDecide", (_e, option: DecisionOption) => (need().engine!.decide(option), runInfo(need())));
  ipcMain.handle("agent-together:runResumeInterrupted", () => {
    const s = need();
    if (s.busy) throw new Error(`正在${s.busy}，等它结束再继续`);
    s.engine!.resumeInterrupted();
    return runInfo(s);
  });
  /*
   * Acceptance and delivery (phase one, M4): the evidence layers and the scenarios
   * on a copy of the product in a hidden page of its own, then the user's own walk
   * through each scenario; failures and "doesn't match" go back to the assistant as
   * fix tasks; when everything holds, a stable version with its data backup and a
   * delivery package. Acceptance holds the project lock while it runs.
   */
  const ACCEPT = "自动验收";
  function attachAcceptance(s: Session) {
    s.acceptance = new Acceptance(s.root, {
      llm: s.llm,
      spec: () => new SpecStore(s.root).confirmed(),
      canvas: () => s.daemon.canvas,
      runConfig: () => readRunConfig(s.root),
      serviceMode: () => serviceMode(s),
      checkpoint: (label) => {
        if (!s.hasGit) return null;
        const c = s.checkpoints.create(label, null);
        return { id: c.id, commit: c.commit };
      },
      runTests: () => runProjectTests(s.root, null),
      openDriver: (dir) => openAcceptanceBrowser(dir),
      onChange: (record) => win.webContents.send("agent-together:acceptanceState", record),
    });
  }
  const startAcceptance = (s: Session) => {
    if (s.busy) throw new Error(`正在${s.busy}，等它结束再验收`);
    if (s.engine?.open) throw new Error("自动制作还没结束，先把它做完或结束");
    s.setBusy(ACCEPT);
    try {
      s.acceptance!.start();
    } catch (err) {
      s.setBusy(null);
      throw err;
    }
    void s.acceptance!.settled().finally(() => {
      if (s.busy === ACCEPT) s.setBusy(null);
      // Write the results into the spec: which scenarios passed, with which services.
      const r = s.acceptance?.current;
      if (r && (r.status === "passed" || r.status === "failed")) {
        const ok = r.serviceMode === "real" ? "real-passed" : "mock-passed";
        new SpecStore(s.root).markScenarios(Object.fromEntries(r.scenarios.map((x) => [x.id, x.status === "passed" ? ok : "failed"])));
      }
    });
  };
  /** Which card a fix goes to: the integration card when the scenario uses it (it may write the cards it connects), else the scenario's last card. */
  const fixCard = (s: Session, tasks: string[]): string | null => {
    const ids = new Set(s.daemon.canvas.nodes.map((n) => n.id));
    if (ids.has("integration") && (tasks.includes("integration") || !tasks.length)) return "integration";
    return [...tasks].reverse().find((t) => ids.has(t)) ?? (ids.has("integration") ? "integration" : null);
  };
  const acceptanceInfo = (s: Session) => {
    const a = s.acceptance!;
    const spec = new SpecStore(s.root).confirmed();
    const record = a.current;
    const config = readRunConfig(s.root);
    const versions = new Versions(s.root).list();
    return {
      record,
      running: a.busy,
      missing: a.missing(),
      fixes: a.fixes().map((f) => ({ scenarioId: f.scenarioId, card: fixCard(s, f.tasks), task: f.task })),
      scenarios: (spec?.scenarios ?? []).map((x) => ({ id: x.id, name: x.name, steps: x.steps, expected: x.expected, dataChecks: x.dataChecks, errorChecks: x.errorChecks, input: x.input, status: x.status })),
      version: spec?.version ?? null,
      cardsLeft: spec ? versionCards(s.daemon.canvas, spec).length : 0,
      mockServices: (spec?.services ?? []).filter((v) => v.mode === "mock" || serviceMode(s) === "mock").map((v) => v.name),
      data: config?.data ?? null,
      hasRunConfig: !!config,
      hasLlm: !!s.llm,
      hasGit: s.hasGit,
      versions,
      agents: Object.keys(runners),
    };
  };
  ipcMain.handle("agent-together:acceptanceInfo", () => acceptanceInfo(need()));
  ipcMain.handle("agent-together:acceptanceStart", () => {
    const s = need();
    startAcceptance(s);
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:acceptanceStop", () => {
    const s = need();
    s.acceptance!.stop();
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:acceptanceConfirm", (_e, scenarioId: string, ok: boolean, note?: string) => {
    const s = need();
    s.acceptance!.confirm(scenarioId, ok, note ?? "");
    if (!ok) new SpecStore(s.root).decide("acceptance-feedback", `亲手验收 ${scenarioId}：不符合`, note);
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:acceptanceSetData", (_e, data: string[]) => {
    const s = need();
    const config = readRunConfig(s.root);
    if (!config) throw new Error("还不知道怎么启动产品：先在「产品预览」里让它能启动");
    saveRunConfig(s.root, { ...config, data: data.map((d) => d.trim()).filter((d) => d && !d.includes("..")) });
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:acceptanceForgetPlan", (_e, scenarioId: string) => {
    const s = need();
    s.acceptance!.forgetPlan(scenarioId);
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:acceptanceShot", (_e, rel: string) => {
    const file = need().acceptance!.file(rel);
    return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  });
  ipcMain.handle("agent-together:acceptanceFix", (_e, agent: string) => {
    const s = need();
    if (!runners[agent]) throw new Error("请选择一个助手");
    if (s.busy) throw new Error(`正在${s.busy}，等它结束再改`);
    const fixes = s.acceptance!
      .fixes()
      .map((f) => {
        // The bug can be in any card the scenario is built from: the fix may write their files, for this run only.
        const cards = f.tasks.length ? f.tasks : s.daemon.canvas.nodes.map((n) => n.id);
        const grants = s.daemon.canvas.nodes.filter((n) => cards.includes(n.id)).flatMap((n) => n.files);
        return { nodeId: fixCard(s, f.tasks), task: f.task, grants };
      })
      .filter((f): f is { nodeId: string; task: string; grants: string[] } => !!f.nodeId);
    if (!fixes.length) throw new Error("没有要改的地方，或者对不上画布上的卡片");
    s.engine!.start({ agent, model: loadRaceConfig(s.root).models?.[agent], fixes });
    return acceptanceInfo(s);
  });
  ipcMain.handle("agent-together:versionSave", async (_e, mockAccepted: boolean) => {
    const s = need();
    return s.exclusive("保存稳定版本", () => {
      const a = s.acceptance!;
      const r = a.current;
      const spec = new SpecStore(s.root).confirmed();
      if (!r || !spec) throw new Error("还没有验收");
      const missing = a.missing();
      if (missing.length) throw new Error(missing.join("；"));
      if (!r.checkpoint) throw new Error("这个项目没有用 git，存不了检查点，也就保存不了稳定版本");
      const config = readRunConfig(s.root);
      const data = config?.data ?? [];
      const changed = codeChangedSince(s.root, s.checkpoints, r.checkpoint.commit, data);
      if (changed.length) throw new Error(`验收之后代码又改过了（${changed.slice(0, 3).join("、")}${changed.length > 3 ? " 等" : ""}），要重新验收`);
      const mock = acceptanceInfo(s).mockServices;
      if (mock.length && !mockAccepted) throw new Error(`${mock.join("、")}用的还是示例服务：确认先这样交付，才能保存`);
      const versions = new Versions(s.root);
      let pkg: string | null = null;
      if (r.package) {
        const target = path.join(versions.dir, `v${spec.version}`, path.basename(r.package.zip));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(a.file(r.package.zip), target);
        pkg = path.relative(s.root, target).replace(/\\/g, "/");
      }
      const done = s.daemon.canvas.nodes.filter((n) => n.status === "done");
      const record = versions.save(
        {
          version: spec.version,
          savedAt: new Date().toISOString(),
          name: s.name,
          goal: spec.goal,
          scenarios: r.scenarios.map((x) => ({ id: x.id, name: x.name, status: r.serviceMode === "real" ? "real-passed" : "mock-passed" })),
          cards: done.map((n) => ({ id: n.id, title: n.title })),
          checkpoint: r.checkpoint,
          acceptanceId: r.id,
          layers: r.layers,
          confirmed: Object.entries(r.user)
            .filter(([, u]) => u.ok)
            .map(([id, u]) => ({ id, at: u.at })),
          serviceMode: r.serviceMode,
          mockAccepted: mock.length > 0 && mockAccepted,
          knownLimits: [...(mock.length ? [`${mock.join("、")}用的是示例服务`] : []), ...a.limits()],
          instructions: "",
          package: pkg,
        },
        data,
      );
      const store = new SpecStore(s.root);
      if (mock.length) store.decide("mock-delivery", `第 ${spec.version} 版先用示例服务交付：${mock.join("、")}`);
      store.decide("stable-version", `保存了第 ${spec.version} 版稳定版本：${r.scenarios.length} 个场景通过并亲手确认`, `检查点 ${r.checkpoint.id}；数据备份 ${record.data.files} 个文件`);
      return acceptanceInfo(s);
    });
  });
  ipcMain.handle("agent-together:versionRestorePreview", (_e, version: number) => {
    const s = need();
    const record = new Versions(s.root).get(version);
    if (!record) throw new Error(`没有第 ${version} 版`);
    return restorePreview(s.root, record, readRunConfig(s.root)?.data ?? []);
  });
  ipcMain.handle("agent-together:versionRestore", async (_e, version: number, data: "backup" | "current") => {
    const s = need();
    return s.exclusive(`回到第 ${version} 版`, async () => {
      const record = new Versions(s.root).get(version);
      if (!record) throw new Error(`没有第 ${version} 版`);
      await s.product.stop();
      await s.preview.clear();
      const currentData = readRunConfig(s.root)?.data ?? [];
      const { safety } = restoreVersion(s.root, s.checkpoints, record, data, currentData);
      s.canvasChanged();
      new SpecStore(s.root).decide("restore-version", `回到第 ${version} 版，${data === "backup" ? "用当时的数据备份" : "保留现在的数据"}`, `回去之前的状态存成了检查点 ${safety}`);
      // Back means usable: start it once for real.
      const config = readRunConfig(s.root);
      const check = config ? await verifyRunConfig(s.root, config, serviceMode(s)) : { ok: false, error: "这个版本里没有启动方式" };
      return { ok: check.ok, error: check.error ?? null, safety, info: acceptanceInfo(s) };
    });
  });
  ipcMain.handle("agent-together:versionShowPackage", (_e, version: number) => {
    const s = need();
    const record = new Versions(s.root).get(version);
    if (!record?.package) throw new Error("这个版本没有启动包");
    shell.showItemInFolder(path.join(s.root, record.package));
  });

  ipcMain.handle("agent-together:stopAgent", () => need().running?.stop.abort());

  // Memories: approving or retiring one re-syncs the Agent Together block in CLAUDE.md and AGENTS.md.
  ipcMain.handle("agent-together:memories", () => need().daemon.memory.list());
  ipcMain.handle("agent-together:addMemory", (_e, nodeId: string | null, kind: Memory["kind"], content: string) => {
    const { daemon } = need();
    const m = daemon.memory.add({ nodeId, kind, content, status: "active", source: "user" });
    daemon.memory.syncAgentFiles(daemon.canvas);
    return m;
  });
  ipcMain.handle("agent-together:setMemoryStatus", (_e, id: string, status: Memory["status"]) => {
    const { daemon } = need();
    const m = daemon.memory.update(id, { status });
    daemon.memory.syncAgentFiles(daemon.canvas);
    return m;
  });
  // Node gene: save the node as a capability unit, then compile every capability for every platform.
  ipcMain.handle("agent-together:exportCapability", (_e, nodeId: string) => {
    const { daemon, root } = need();
    const previous = daemon.capabilities.list().find((c) => c.nodeId === nodeId);
    const capability = daemon.capabilities.save(capabilityFromNode(daemon.canvas, nodeId, daemon.memory.forNode(nodeId), previous));
    const [report] = compileCapabilities(root, [capability], compilers);
    return report;
  });
  ipcMain.handle("agent-together:compileCapabilities", () => {
    const { daemon, root } = need();
    daemon.reload(); // observer capabilities take effect right away
    return compileCapabilities(root, daemon.capabilities.list(), compilers);
  });

  ipcMain.handle("agent-together:checkpoints", () => {
    const s = need();
    return s.hasGit ? s.checkpoints.list() : [];
  });
  ipcMain.handle("agent-together:checkpoint", (_e, label: string) => {
    const s = need();
    return s.checkpoints.create(label, s.daemon.observer.activeNodeId);
  });
  ipcMain.handle("agent-together:rollback", async (_e, id: string) => {
    const s = need();
    const target = s.checkpoints.list().find((c) => c.id === id);
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["回滚", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `把项目文件回滚到"${target?.label ?? id}"？`,
      detail: "当前状态会先自动存为一个检查点，回滚之后还可以再回来。被 git 忽略的文件不受影响。",
    });
    if (response !== 0) return false;
    await s.exclusive("回滚", () => s.checkpoints.rollback(id));
    s.canvasChanged();
    return true;
  });

  ipcMain.handle("agent-together:evolutions", (_e, agent?: string) => {
    const s = need();
    return {
      reports: new Evolution(s.root, s.llm).list(),
      running: s.racing,
      agents: Object.keys(runners), // evolution: any one assistant, not only the ones that race
      candidate: testHistory(s.root).consecutiveFailures ?? {},
      // Proven with the assistant and model the user is about to evolve with, first.
      suggestions: new ExperienceStore().suggestions(s.root, agent ? verifierFor(s, agent) : undefined),
    };
  });
  ipcMain.handle("agent-together:evolve", async (_e, nodeId: string, task: string, agent: string) => {
    const s = need();
    if (s.racing) throw new Error("已有任务在比较，请等它结束");
    if (!runners[agent]) throw new Error("请选择一个可用的助手");
    s.racing = nodeId;
    try {
      return await s.exclusive("比较几种做法（进化）", () => new Evolution(s.root, s.llm).run(
        nodeId,
        task,
        runners[agent](loadRaceConfig(s.root).models?.[agent]),
        (message) => win.webContents.send("agent-together:raceProgress", message),
        loadRaceConfig(s.root).models?.[agent],
      ));
    } finally {
      s.racing = null;
    }
  });
  ipcMain.handle("agent-together:approveEvolution", async (_e, id: string, adopt: boolean) => {
    const s = need();
    if (s.racing) throw new Error("请等当前比较结束");
    const report = await s.exclusive(adopt ? "采用进化的代码" : "记下进化的做法", () => new Evolution(s.root, s.llm).approve(id, adopt));
    s.canvasChanged();
    return report;
  });
  ipcMain.handle("agent-together:discardEvolution", (_e, id: string) =>
    new Evolution(need().root, need().llm).discard(id),
  );
  ipcMain.handle("agent-together:approveExperience", (_e, id: string, nodeId: string) => {
    const s = need();
    if (!s.daemon.canvas.nodes.some((n) => n.id === nodeId)) throw new Error("找不到这条记录");
    const entry = new ExperienceStore().suggestions(s.root).find((e) => e.id === id);
    if (!entry) throw new Error("找不到这条记录");
    const existing = s.daemon.memory
      .list()
      .find((m) => m.nodeId === nodeId && m.content === entry.text.trim());
    if (existing) {
      s.daemon.memory.update(existing.id, { status: "active", evidence: entry.reports.join("\n") });
    } else {
      s.daemon.memory.add({
        nodeId,
        kind: "decision",
        status: "active",
        content: entry.text,
        source: "experience:" + id,
        evidence: entry.reports.join("\n"),
      });
    }
    s.daemon.memory.syncAgentFiles(s.daemon.canvas);
    s.canvasChanged();
  });

  // Races: every agent in its own worktree; the report is kept, the human adopts one or discards all.
  const raceAgents = (root: string) => (loadRaceConfig(root).agents ?? ["claude-code", "codex"]).filter((a) => runners[a]);
  ipcMain.handle("agent-together:races", () => {
    const s = need();
    return { running: s.racing, reports: s.race?.list() ?? [], agents: raceAgents(s.root), all: Object.keys(runners) };
  });
  ipcMain.handle("agent-together:saveRaceAgents", (_e, agents: string[]) => {
    const s = need();
    const chosen = agents.filter((a) => runners[a]);
    if (chosen.length < 2) throw new Error("赛马至少要两个 AI 助手");
    return saveRaceAgents(s.root, chosen);
  });
  ipcMain.handle("agent-together:race", async (_e, nodeId: string, task: string, context?: string) => {
    const s = need();
    if (!s.race) throw new Error("项目不在 git 仓库中，无法赛马");
    if (s.racing) throw new Error(`已有一场赛马在进行（${s.racing}）`);
    s.racing = nodeId;
    const models = loadRaceConfig(s.root).models ?? {};
    const race = s.race;
    try {
      return await s.exclusive("赛马", () => race.run(
        nodeId,
        task,
        // Each contestant gets the memories proven with its own assistant and model (or with none).
        raceAgents(s.root).map((a) => ({
          id: a,
          runner: runners[a](models[a]),
          memories: splitByVerifier(s.daemon.memory.forNode(nodeId), verifierKey(a, models[a])).fit,
        })),
        s.daemon.memory.forNode(nodeId),
        (message) => win.webContents.send("agent-together:raceProgress", message),
        context,
      ));
    } finally {
      s.racing = null;
    }
  });
  ipcMain.handle("agent-together:adoptRace", async (_e, id: string, contestantId: string) => {
    const s = need();
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["采用", "取消"],
      defaultId: 0,
      cancelId: 1,
      message: `把 ${contestantId} 的改动应用到项目？`,
      detail: "应用前会自动存一个检查点，之后可以回滚。其他参赛者的独立工作区会被清理。",
    });
    if (response !== 0) return false;
    await s.exclusive("采用赛马结果", () => s.race!.adopt(id, contestantId));
    s.canvasChanged();
    return true;
  });
  ipcMain.handle("agent-together:discardRace", (_e, id: string) => need().race!.discard(id));

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));

  // AGENT_TOGETHER_PROJECT opens a project straight away (development, scripts); otherwise the start screen.
  const fromEnv = process.env.AGENT_TOGETHER_PROJECT;
  if (fromEnv) await switchTo(openProject(fromEnv).root);

  app.on("window-all-closed", () => (session ? session.close() : Promise.resolve()).then(() => app.quit()));
}

main();
