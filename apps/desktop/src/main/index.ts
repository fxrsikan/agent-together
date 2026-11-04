import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { claudeCodeCompiler, claudeCodeRunner } from "@agent-together/adapter-claude-code";
import { agentSkillsCompiler, codexRunner } from "@agent-together/adapter-codex";
import { cursorAgentCommand, cursorRulesCompiler, cursorRunner } from "@agent-together/adapter-cursor";
import { grokAgentCommand, grokRunner } from "@agent-together/adapter-grok";
import {
  Evolution,
  ExperienceStore,
  buildNodeContext,
  capabilityFromNode,
  checkSetup,
  compileCapabilities,
  contextSections,
  createProject,
  dispatchPrompt,
  estimateTokens,
  loadRaceConfig,
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
import type { AgentRunner, CanvasEdge, CanvasNode, Memory } from "@agent-together/schema";
import { Session } from "./session";

const compilers = [claudeCodeCompiler, agentSkillsCompiler, cursorRulesCompiler];
const runners: Record<string, (model?: string) => AgentRunner> = { "claude-code": claudeCodeRunner, codex: codexRunner, cursor: cursorRunner, "grok-build": grokRunner };
type Agent = "claude-code" | "codex" | "cursor" | "grok-build";

/** Dev layout: the hook program is built in the sibling workspace package. */
const hookProgram = () => path.resolve(app.getAppPath(), "../../packages/hook/dist/agent-together-hook.js");

/** Interactive command line that starts each agent on a prompt in a new terminal window. */
function agentCommandLine(agent: Agent, prompt: string): string {
  const quoted = `"${prompt}"`;
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

// Recent projects and setup completion live in the app's own folder (not in projects).
const recentFile = () => path.join(app.getPath("userData"), "recent-projects.json");
const setupDoneFile = () => path.join(app.getPath("userData"), "setup-done.json");
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
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Agent Together",
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
  ipcMain.handle("agent-together:createProject", async (_e, parent: string, name: string, description: string) => {
    const folder = name.trim().replace(/[<>:"/\\|?*]+/g, "-");
    if (!folder) throw new Error("请填写项目名");
    const root = createProject(path.join(parent, folder), name.trim());
    if (description.trim()) writeProjectInfo(root, { description: description.trim() });
    const info = await switchTo(root);
    need().installHooks(hookProgram());
    return info;
  });
  ipcMain.handle("agent-together:openProject", async (_e, dir: string) => {
    const { root, created } = openProject(dir);
    const info = await switchTo(root);
    if (created) need().installHooks(hookProgram());
    return info;
  });
  ipcMain.handle("agent-together:closeProject", async () => {
    await session?.close();
    session = null;
    win.setTitle("Agent Together");
  });
  ipcMain.handle("agent-together:info", () => session?.info() ?? null);
  ipcMain.handle("agent-together:recentLog", () => need().daemon.store.recentLog(100));
  ipcMain.handle("agent-together:projectInfo", () => readProjectInfo(need().root));
  ipcMain.handle("agent-together:saveProjectInfo", (_e, patch: { description?: string; stack?: string; testCommand?: string }) =>
    writeProjectInfo(need().root, patch),
  );

  // Canvas: AI plan, then edit by hand. Every change is validated and written to .agent-together/canvas/.
  ipcMain.handle("agent-together:planCanvas", async (_e, description: string) => {
    const s = need();
    if (!s.llm) throw new Error("没有可用的模型：请先登录 claude 命令行，或设置 ANTHROPIC_API_KEY，或在项目的 .agent-together/llm.json 里配置");
    const plan = await planCanvas(s.llm, description);
    s.daemon.store.writeCanvas(plan.canvas);
    writeProjectInfo(s.root, { description: description.trim(), stack: plan.stack, ...(plan.testCommand ? { testCommand: plan.testCommand } : {}) });
    s.canvasChanged();
    return plan;
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
    if (s.daemon.observer.activeNodeId === id) s.daemon.setActiveNode(null);
    s.canvasChanged();
    return true;
  });
  ipcMain.handle("agent-together:saveEdges", (_e, edges: CanvasEdge[]) => {
    const s = need();
    const saved = s.daemon.store.saveEdges(edges);
    s.canvasChanged();
    return saved;
  });

  ipcMain.handle("agent-together:setActive", (_e, nodeId: string | null) => need().daemon.setActiveNode(nodeId));
  ipcMain.handle("agent-together:installHooks", () => need().installHooks(hookProgram()));

  // Context inspector: what the agent would get, with sizes; memories can be left out per dispatch.
  const nodeMemories = (s: Session, nodeId: string, without: string[] = []) => s.daemon.memory.forNode(nodeId).filter((m) => !without.includes(m.id));
  const contextFor = (s: Session, nodeId: string, task: string, without: string[] = []) =>
    buildNodeContext(s.daemon.canvas, nodeId, task, nodeMemories(s, nodeId, without), readProjectInfo(s.root));
  ipcMain.handle("agent-together:previewContext", (_e, nodeId: string, task: string, without: string[]) => {
    const s = need();
    return { markdown: contextFor(s, nodeId, task, without), memories: s.daemon.memory.forNode(nodeId) };
  });
  ipcMain.handle("agent-together:measureContext", (_e, markdown: string) => ({ tokens: estimateTokens(markdown), sections: contextSections(markdown) }));
  // Dispatch: checkpoint first, make the node active, write its context, open the agent on it.
  // `context`, when given, is the inspector's (possibly edited) text and is handed out as is.
  ipcMain.handle("agent-together:dispatch", (_e, nodeId: string, task: string, agent: Agent, context?: string) => {
    const s = need();
    s.startDispatch(nodeId, agent);
    const file = s.daemon.store.writeContext(nodeId, context ?? contextFor(s, nodeId, task));
    s.daemon.setActiveNode(nodeId);
    const node = s.daemon.canvas.nodes.find((n) => n.id === nodeId);
    if (node && node.status === "todo") {
      s.daemon.store.saveNode({ ...node, status: "in_progress", executor: agent });
      s.canvasChanged();
    }
    openTerminal(s.root, agentCommandLine(agent, dispatchPrompt(file)), `Agent Together - ${nodeId} - ${agent}`);
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
    const checkpoint = tests?.passed && s.hasGit ? s.checkpoints.create(`测试通过：${title}`, nodeId) : null;
    return { tests, checkpoint, audit };
  };
  ipcMain.handle("agent-together:runTests", (_e, nodeId: string | null) => testAndCheckpoint(need(), nodeId));
  ipcMain.handle("agent-together:testHistory", () => testHistory(need().root));
  ipcMain.handle("agent-together:testCommand", () => testCommandFor(need().root));

  // In-app dispatch: the agent runs headless in the project, its words stream to the window,
  // its actions go through the hooks to the observer as usual; then the tests run.
  ipcMain.handle("agent-together:runAgent", async (_e, nodeId: string, task: string, agent: Agent, context?: string) => {
    const s = need();
    if (s.running) throw new Error(`已有 AI 助手在运行（${s.running.nodeId}）`);
    s.startDispatch(nodeId, agent);
    const file = s.daemon.store.writeContext(nodeId, context ?? contextFor(s, nodeId, task));
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
    s.checkpoints.rollback(id);
    s.canvasChanged();
    return true;
  });

  ipcMain.handle("agent-together:evolutions", () => {
    const s = need();
    return { reports: new Evolution(s.root, s.llm).list(), running: s.racing, agents: raceAgents(s.root), candidate: testHistory(s.root).consecutiveFailures ?? {}, suggestions: new ExperienceStore().suggestions(s.root) };
  });
  ipcMain.handle("agent-together:evolve", async (_e, nodeId: string, task: string, agent: string) => {
    const s = need();
    if (s.racing) throw new Error("已有任务在比较，请等它结束");
    if (!runners[agent]) throw new Error("请选择一个可用的助手");
    s.racing = nodeId;
    try { return await new Evolution(s.root, s.llm).run(nodeId, task, runners[agent](loadRaceConfig(s.root).models?.[agent]), message => win.webContents.send("agent-together:raceProgress", message)); }
    finally { s.racing = null; }
  });
  ipcMain.handle("agent-together:approveEvolution", (_e, id: string, adopt: boolean) => {
    const s = need();
    if (s.racing) throw new Error("请等当前比较结束");
    const report = new Evolution(s.root, s.llm).approve(id, adopt);
    s.canvasChanged(); return report;
  });
  ipcMain.handle("agent-together:discardEvolution", (_e, id: string) => new Evolution(need().root, need().llm).discard(id));
  ipcMain.handle("agent-together:approveExperience", (_e, id: string, nodeId: string) => {
    const s = need();
    if (!s.daemon.canvas.nodes.some(n => n.id === nodeId)) throw new Error("找不到这条记录");
    const entry = new ExperienceStore().suggestions(s.root).find(e => e.id === id);
    if (!entry) throw new Error("找不到这条记录");
    const existing = s.daemon.memory.list().find(m => m.nodeId === nodeId && m.content === entry.text.trim());
    if (existing) s.daemon.memory.update(existing.id, { status: "active", evidence: entry.reports.join("\n") });
    else s.daemon.memory.add({ nodeId, kind: "decision", status: "active", content: entry.text, source: "experience:" + id, evidence: entry.reports.join("\n") });
    s.daemon.memory.syncAgentFiles(s.daemon.canvas); s.canvasChanged();
  });

  // Races: every agent in its own worktree; the report is kept, the human adopts one or discards all.
  const raceAgents = (root: string) => (loadRaceConfig(root).agents ?? ["claude-code", "codex"]).filter((a) => runners[a]);
  ipcMain.handle("agent-together:races", () => {
    const s = need();
    return { running: s.racing, reports: s.race?.list() ?? [], agents: raceAgents(s.root) };
  });
  ipcMain.handle("agent-together:race", async (_e, nodeId: string, task: string, context?: string) => {
    const s = need();
    if (!s.race) throw new Error("项目不在 git 仓库中，无法赛马");
    if (s.racing) throw new Error(`已有一场赛马在进行（${s.racing}）`);
    s.racing = nodeId;
    const models = loadRaceConfig(s.root).models ?? {};
    try {
      return await s.race.run(
        nodeId,
        task,
        raceAgents(s.root).map((a) => runners[a](models[a])),
        s.daemon.memory.forNode(nodeId),
        (message) => win.webContents.send("agent-together:raceProgress", message),
        context,
      );
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
    s.race!.adopt(id, contestantId);
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
