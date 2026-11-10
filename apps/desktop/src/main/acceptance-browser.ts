import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, session as sessions } from "electron";
import type { PageDriver } from "@agent-together/core";

type Key = Parameters<PageDriver["press"]>[0];
const KEYS: Record<Key, { code: number; text: string }> = {
  Enter: { code: 13, text: "\r" },
  Escape: { code: 27, text: "" },
  Tab: { code: 9, text: "" },
  Backspace: { code: 8, text: "" },
  End: { code: 35, text: "" },
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * The page acceptance drives (phase one, M4): a hidden window of its own, apart
 * from the user's preview, in a fresh in-memory session (no cookies or storage
 * from before). Input goes through the DevTools protocol, so clicks and typing
 * are real, trusted input events; confirm() and alert() boxes are answered as the
 * script says and their text kept for checks; console errors, failed requests and
 * downloads are recorded as evidence.
 */
export async function openAcceptanceBrowser(downloadDir: string): Promise<PageDriver & { close(): void }> {
  const partition = `acceptance-${Date.now()}`;
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  let origin = "";
  // One page: links that open a window load here instead; other sites are not visited.
  wc.setWindowOpenHandler(({ url }) => {
    if (origin && url.startsWith(origin)) void wc.loadURL(url);
    return { action: "deny" };
  });

  const problems: string[] = [];
  const downloads: { file: string; ok: boolean }[] = [];
  wc.on("console-message", (...args: unknown[]) => {
    const e = args[0] as { level?: unknown; message?: string };
    const level = e.level ?? args[1];
    if (level === "error" || level === 3) problems.push(`控制台错误：${String(e.message ?? args[2]).slice(0, 300)}`);
  });
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) problems.push(`页面没有打开：${description}（${url}）`);
  });
  const ses = sessions.fromPartition(partition);
  ses.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (d) => {
    if (d.statusCode >= 400) problems.push(`${d.method} 请求返回 ${d.statusCode}：${d.url}`);
  });
  ses.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (d) => {
    if (d.error !== "net::ERR_ABORTED") problems.push(`${d.method} 请求失败：${d.error}（${d.url}）`);
  });
  ses.on("will-download", (_e, item) => {
    fs.mkdirSync(downloadDir, { recursive: true });
    const file = path.join(downloadDir, `${Date.now()}-${item.getFilename()}`);
    item.setSavePath(file);
    item.once("done", (_d, state) => downloads.push({ file, ok: state === "completed" }));
  });

  // A window that has never loaded a page does not answer the DevTools protocol: give it a blank one first.
  await wc.loadURL("about:blank");
  const dbg = wc.debugger;
  dbg.attach("1.3");
  if ((await withTimeout(dbg.sendCommand("Page.enable"), 15_000)) === null) {
    win.destroy();
    throw new Error("验收用的浏览器页面没有响应");
  }
  await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  let accept = true;
  const dialogs: string[] = [];
  dbg.on("message", (_e, method, params: { message?: string }) => {
    if (method !== "Page.javascriptDialogOpening") return;
    dialogs.push(String(params.message ?? ""));
    void dbg.sendCommand("Page.handleJavaScriptDialog", { accept }).catch(() => undefined);
  });

  const press = async (key: Key) => {
    const k = KEYS[key];
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code });
  };

  return {
    async goto(url) {
      origin = new URL(url).origin;
      await wc.loadURL(url).catch(() => undefined); // a failure is recorded by did-fail-load
    },
    reload: () =>
      new Promise<void>((resolve) => {
        const done = () => resolve();
        wc.once("did-stop-loading", done);
        wc.reload();
        setTimeout(done, 15_000);
      }),
    eval: (js) => wc.executeJavaScript(js, true),
    async click(x, y) {
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      // A confirm() opened by this click holds the release until it is answered, which the handler above does.
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    },
    async type(text) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await dbg.sendCommand("Input.insertText", { text: lines[i] });
        if (i < lines.length - 1) await press("Enter");
      }
    },
    press,
    answerDialogs(a) {
      accept = a;
    },
    dialogs: () => [...dialogs],
    async screenshot() {
      // capturePage answers at once for a hidden window; the protocol's screenshot waits for a new frame that may never come.
      const img = await withTimeout(wc.capturePage(), 5000).catch(() => null);
      return img && !img.isEmpty() ? img.toPNG() : null;
    },
    url: () => wc.getURL(),
    takeProblems: () => problems.splice(0),
    downloads: () => [...downloads],
    close() {
      try {
        dbg.detach();
      } catch {}
      if (!win.isDestroyed()) win.destroy();
      void ses.clearStorageData().catch(() => undefined);
    },
  };
}
