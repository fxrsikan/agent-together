import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { claudeCodeCompiler, claudeCodeRunner, installHooks } from "@agent-together/adapter-claude-code";
import { agentSkillsCompiler, codexRunner, installCodexHooks } from "@agent-together/adapter-codex";
import { cursorRulesCompiler, cursorRunner, installCursorHooks } from "@agent-together/adapter-cursor";
import {
  buildNodeContext,
  capabilityFromNode,
  Checkpoints,
  compileCapabilities,
  contextSections,
  createLlm,
  Daemon,
  dispatchPrompt,
  estimateTokens,
  loadLlmConfig,
  loadRaceConfig,
  openTerminal,
  Race,
} from "@agent-together/core";
import type { AgentRunner, Memory } from "@agent-together/schema";

const compilers = [claudeCodeCompiler, agentSkillsCompiler, cursorRulesCompiler];

/** Project to open: AGENT_TOGETHER_PROJECT, else the bundled demo, else ask. */
async function pickProject(): Promise<string | null> {
  const fromEnv = process.env.AGENT_TOGETHER_PROJECT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, ".agent-together"))) return path.resolve(fromEnv);
  const demo = path.resolve(app.getAppPath(), "../../examples/demo");
  if (fs.existsSync(path.join(demo, ".agent-together"))) return demo;
  const res = await dialog.showOpenDialog({ title: "选择包含 .agent-together 的项目", properties: ["openDirectory"] });
  return res.canceled ? null : res.filePaths[0];
}

async function main() {
  await app.whenReady();
  const root = await pickProject();
  if (!root) return app.quit();

  const llmConfig = loadLlmConfig(root);
  const llm = createLlm(llmConfig);
  const daemon = new Daemon(root, { llm, maxL2CallsPerSession: llmConfig.maxCallsPerSession });
  const port = await daemon.start();
  const checkpoints = new Checkpoints(root);
  const hasGit = checkpoints.available();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Agent Together",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });
  daemon.on("event", (record) => win.webContents.send("agent-together:event", record));
  daemon.on("active", (nodeId) => win.webContents.send("agent-together:active", nodeId));
  daemon.on("memory", (drafts) => win.webContents.send("agent-together:memoryDrafts", drafts));
  daemon.on("judgment", (j) => win.webContents.send("agent-together:judgment", j));
  daemon.on("l2error", (e) => win.webContents.send("agent-together:l2error", e));

  ipcMain.handle("agent-together:info", () => ({ root, port, hasGit, l2: llm?.name ?? null, activeNodeId: daemon.observer.activeNodeId }));
  ipcMain.handle("agent-together:canvas", () => daemon.canvas);
  ipcMain.handle("agent-together:setActive", (_e, nodeId: string | null) => daemon.setActiveNode(nodeId));
  ipcMain.handle("agent-together:installHooks", () => {
    // Dev layout: the hook program is built in the sibling workspace package.
    const hook = path.resolve(app.getAppPath(), "../../packages/hook/dist/agent-together-hook.js");
    return [
      installHooks(root, `node "${hook}"`),
      installCodexHooks(root, `node "${hook}" --platform codex`),
      ...installCursorHooks(root, `node "${hook}" --platform cursor`),
    ];
  });
  // Dispatch: checkpoint first, make the node active, write its neighbourhood context, open the agent on it.
  // Context inspector: what the agent would get, with sizes; memories can be left out per dispatch.
  const nodeMemories = (nodeId: string, without: string[] = []) => daemon.memory.forNode(nodeId).filter((m) => !without.includes(m.id));
  ipcMain.handle("agent-together:previewContext", (_e, nodeId: string, task: string, without: string[]) => {
    const markdown = buildNodeContext(daemon.canvas, nodeId, task, nodeMemories(nodeId, without));
    return { markdown, memories: daemon.memory.forNode(nodeId) };
  });
  ipcMain.handle("agent-together:measureContext", (_e, markdown: string) => ({ tokens: estimateTokens(markdown), sections: contextSections(markdown) }));
  // `context`, when given, is the inspector's (possibly edited) text and is handed out as is.
  ipcMain.handle("agent-together:dispatch", (_e, nodeId: string, task: string, agent: "claude-code" | "codex", context?: string) => {
    if (hasGit) checkpoints.create(`派发前（${agent}）`, nodeId);
    context ??= buildNodeContext(daemon.canvas, nodeId, task, nodeMemories(nodeId));
    const file = daemon.store.writeContext(nodeId, context);
    daemon.setActiveNode(nodeId);
    const cli = agent === "codex" ? "codex" : "claude";
    openTerminal(root, `${cli} "${dispatchPrompt(file)}"`, `Agent Together - ${nodeId} - ${agent}`);
    return file;
  });

  // Memories: approving or retiring one re-syncs the Agent Together block in CLAUDE.md.
  ipcMain.handle("agent-together:memories", () => daemon.memory.list());
  ipcMain.handle("agent-together:addMemory", (_e, nodeId: string | null, kind: Memory["kind"], content: string) => {
    const m = daemon.memory.add({ nodeId, kind, content, status: "active", source: "user" });
    daemon.memory.syncAgentFiles(daemon.canvas);
    return m;
  });
  ipcMain.handle("agent-together:setMemoryStatus", (_e, id: string, status: Memory["status"]) => {
    const m = daemon.memory.update(id, { status });
    daemon.memory.syncAgentFiles(daemon.canvas);
    return m;
  });
  // Node gene: save the node as a capability unit, then compile every capability for every platform.
  ipcMain.handle("agent-together:exportCapability", (_e, nodeId: string) => {
    const previous = daemon.capabilities.list().find((c) => c.nodeId === nodeId);
    const capability = daemon.capabilities.save(
      capabilityFromNode(daemon.canvas, nodeId, daemon.memory.forNode(nodeId), previous),
    );
    const [report] = compileCapabilities(root, [capability], compilers);
    return report;
  });
  ipcMain.handle("agent-together:compileCapabilities", () => {
    daemon.reload(); // observer capabilities take effect right away
    return compileCapabilities(root, daemon.capabilities.list(), compilers);
  });

  ipcMain.handle("agent-together:checkpoints",() => (hasGit ? checkpoints.list() : []));
  ipcMain.handle("agent-together:checkpoint", (_e, label: string) => checkpoints.create(label, daemon.observer.activeNodeId));
  ipcMain.handle("agent-together:rollback", async (_e, id: string) => {
    const target = checkpoints.list().find((c) => c.id === id);
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["回滚", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `把项目文件回滚到"${target?.label ?? id}"？`,
      detail: "当前状态会先自动存为一个检查点，回滚之后还可以再回来。被 git 忽略的文件不受影响。",
    });
    if (response !== 0) return false;
    checkpoints.rollback(id);
    daemon.reload();
    return true;
  });

  // Races: both agents in their own worktrees; the report is kept, the human adopts one or discards all.
  const race = hasGit ? new Race(root) : null;
  let racing: string | null = null; // node id while a race runs; one at a time
  const factories: Record<string, (model?: string) => AgentRunner> = { "claude-code": claudeCodeRunner, codex: codexRunner, cursor: cursorRunner };
  const raceAgents = () => (loadRaceConfig(root).agents ?? ["claude-code", "codex"]).filter((a) => factories[a]);
  ipcMain.handle("agent-together:races", () => ({ running: racing, reports: race?.list() ?? [], agents: raceAgents() }));
  ipcMain.handle("agent-together:race", async (_e, nodeId: string, task: string, context?: string) => {
    if (!race) throw new Error("项目不在 git 仓库中，无法赛马");
    if (racing) throw new Error(`已有一场赛马在进行（${racing}）`);
    racing = nodeId;
    const models = loadRaceConfig(root).models ?? {};
    try {
      return await race.run(
        nodeId,
        task,
        raceAgents().map((a) => factories[a](models[a])),
        daemon.memory.forNode(nodeId),
        (message) => win.webContents.send("agent-together:raceProgress", message),
        context,
      );
    } finally {
      racing = null;
    }
  });
  ipcMain.handle("agent-together:adoptRace", async (_e, id: string, contestantId: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["采用", "取消"],
      defaultId: 0,
      cancelId: 1,
      message: `把 ${contestantId} 的改动应用到项目？`,
      detail: "应用前会自动存一个检查点，之后可以回滚。其他参赛者的 worktree 会被清理。",
    });
    if (response !== 0) return false;
    race!.adopt(id, contestantId);
    daemon.reload();
    return true;
  });
  ipcMain.handle("agent-together:discardRace", (_e, id: string) => race!.discard(id));

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));

  app.on("window-all-closed", () => daemon.stop().then(() => app.quit()));
}

main();
