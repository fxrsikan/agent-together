import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
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
  readProjectInfo,
  runProjectTests,
  testCommandFor,
  testHistory,
  writeProjectInfo,
} from "@agent-together/core";
import { Capability, ranNoTests } from "@agent-together/schema";
import type { AgentRunner, CanvasEdge, CanvasNode, Memory } from "@agent-together/schema";
import { Session } from "./session";

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
    buildNodeContext(s.daemon.canvas, nodeId, task, nodeMemories(s, nodeId, without), readProjectInfo(s.root), s.daemon.capabilities.list());
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
  ipcMain.handle("agent-together:runAgent", async (_e, nodeId: string, task: string, agent: Agent, context?: string) => {
    const s = need();
    if (s.running) throw new Error(`已有 AI 助手在运行（${s.running.nodeId}）`);
    const title = s.daemon.canvas.nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
    return s.exclusive(`让 AI 做「${title}」`, async () => {
    s.startDispatch(nodeId, agent);
    const file = s.daemon.store.writeContext(nodeId, context ?? contextFor(s, nodeId, task, agent));
    s.daemon.setActiveNode(nodeId);
    const node = s.daemon.canvas.nodes.find((n) => n.id === nodeId);
    if (node && node.status === "todo") s.daemon.store.saveNode({ ...node, status: "in_progress", executor: agent });
    s.canvasChanged();
    const stop = new AbortController();
    s.running = { nodeId, agent, stop };
    const send = (channel: string, payload: unknown) => win.webContents.send(`agent-together:${channel}`, payload);
    send("agentStatus", { nodeId, agent, state: "running" });
    try {
      const model = loadRaceConfig(s.root).models?.[agent];
      const run = await runners[agent](model).run(s.root, dispatchPrompt(file), 30 * 60_000, {
        signal: stop.signal,
        onText: (text) => send("agentText", { nodeId, text }),
      });
      send("agentStatus", { nodeId, agent, state: "testing" });
      const { tests, checkpoint, audit } = run.summary === "已停止" ? { tests: null, checkpoint: null, audit: s.audit(nodeId) } : await testAndCheckpoint(s, nodeId);
      s.canvasChanged();
      return { run, tests, checkpoint, audit };
    } finally {
      s.running = null;
      send("agentStatus", { nodeId, agent, state: "idle" });
    }
    });
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
