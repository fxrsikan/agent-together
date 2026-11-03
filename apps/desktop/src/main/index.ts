import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { installHooks } from "@loom/adapter-claude-code";
import { Daemon } from "@loom/core";

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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Loom",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js") },
  });
  daemon.on("event", (record) => win.webContents.send("loom:event", record));
  daemon.on("active", (nodeId) => win.webContents.send("loom:active", nodeId));

  ipcMain.handle("loom:info", () => ({ root, port, activeNodeId: daemon.observer.activeNodeId }));
  ipcMain.handle("loom:canvas", () => daemon.canvas);
  ipcMain.handle("loom:setActive", (_e, nodeId: string | null) => daemon.setActiveNode(nodeId));
  ipcMain.handle("loom:installHooks", () => {
    // Dev layout: the hook program is built in the sibling workspace package.
    const hook = path.resolve(app.getAppPath(), "../../packages/hook/dist/loom-hook.js");
    return installHooks(root, `node "${hook}"`);
  });

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));

  app.on("window-all-closed", () => daemon.stop().then(() => app.quit()));
}

main();
