import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dispatchPrompt, exportSkill, installHooks, launchInTerminal } from "@loom/adapter-claude-code";
import { buildNodeContext, buildNodeGuide, Checkpoints, Daemon } from "@loom/core";
import type { Memory } from "@loom/schema";

/** Project to open: LOOM_PROJECT, else the bundled demo, else ask. */
async function pickProject(): Promise<string | null> {
  const fromEnv = process.env.LOOM_PROJECT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, ".loom"))) return path.resolve(fromEnv);
  const demo = path.resolve(app.getAppPath(), "../../examples/demo");
  if (fs.existsSync(path.join(demo, ".loom"))) return demo;
  const res = await dialog.showOpenDialog({ title: "选择包含 .loom 的项目", properties: ["openDirectory"] });
  return res.canceled ? null : res.filePaths[0];
}

async function main() {
  await app.whenReady();
  const root = await pickProject();
  if (!root) return app.quit();

  const daemon = new Daemon(root);
  const port = await daemon.start();
  const checkpoints = new Checkpoints(root);
  const hasGit = checkpoints.available();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Loom",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });
  daemon.on("event", (record) => win.webContents.send("loom:event", record));
  daemon.on("active", (nodeId) => win.webContents.send("loom:active", nodeId));
  daemon.on("memory", (drafts) => win.webContents.send("loom:memoryDrafts", drafts));

  ipcMain.handle("loom:info", () => ({ root, port, hasGit, activeNodeId: daemon.observer.activeNodeId }));
  ipcMain.handle("loom:canvas", () => daemon.canvas);
  ipcMain.handle("loom:setActive", (_e, nodeId: string | null) => daemon.setActiveNode(nodeId));
  ipcMain.handle("loom:installHooks", () => {
    // Dev layout: the hook program is built in the sibling workspace package.
    const hook = path.resolve(app.getAppPath(), "../../packages/hook/dist/loom-hook.js");
    return installHooks(root, `node "${hook}"`);
  });
  // Dispatch: checkpoint first, make the node active, write its neighbourhood context, open Claude Code on it.
  ipcMain.handle("loom:dispatch", (_e, nodeId: string, task: string) => {
    if (hasGit) checkpoints.create("派发前", nodeId);
    const context = buildNodeContext(daemon.canvas, nodeId, task, daemon.memory.forNode(nodeId));
    const file = daemon.store.writeContext(nodeId, context);
    daemon.setActiveNode(nodeId);
    launchInTerminal(root, dispatchPrompt(file), `Loom - ${nodeId}`);
    return file;
  });

  // Memories: approving or retiring one re-syncs the Loom block in CLAUDE.md.
  ipcMain.handle("loom:memories", () => daemon.memory.list());
  ipcMain.handle("loom:addMemory", (_e, nodeId: string | null, kind: Memory["kind"], content: string) => {
    const m = daemon.memory.add({ nodeId, kind, content, status: "active", source: "user" });
    daemon.memory.syncClaudeMd(daemon.canvas);
    return m;
  });
  ipcMain.handle("loom:setMemoryStatus", (_e, id: string, status: Memory["status"]) => {
    const m = daemon.memory.update(id, { status });
    daemon.memory.syncClaudeMd(daemon.canvas);
    return m;
  });
  ipcMain.handle("loom:exportSkill", (_e, nodeId: string) => {
    const node = daemon.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`unknown node: ${nodeId}`);
    return exportSkill(root, node, buildNodeGuide(daemon.canvas, nodeId, daemon.memory.forNode(nodeId)));
  });

  ipcMain.handle("loom:checkpoints",() => (hasGit ? checkpoints.list() : []));
  ipcMain.handle("loom:checkpoint", (_e, label: string) => checkpoints.create(label, daemon.observer.activeNodeId));
  ipcMain.handle("loom:rollback", async (_e, id: string) => {
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

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));

  app.on("window-all-closed", () => daemon.stop().then(() => app.quit()));
}

main();
