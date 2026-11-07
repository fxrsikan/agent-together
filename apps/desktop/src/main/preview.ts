import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { session as sessions, shell, WebContentsView, type BrowserWindow } from "electron";

/** Something that went wrong in the product page: a console error, a failed request, a page that did not load. */
export interface PreviewProblem {
  kind: "console" | "network" | "load";
  message: string;
  url?: string;
  at: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The product, shown inside the app (phase one, M2). Its own WebContentsView, laid
 * over a placeholder in the window: a separate process with no preload, sandboxed,
 * in a per-project session, so the page can reach neither the app's IPC nor its
 * files. It only navigates within the product's own address; other links open in
 * the user's browser. It records console errors, failed requests and downloads,
 * which acceptance checks (M4) use as evidence.
 */
export class ProductPreview {
  private view: WebContentsView | null = null;
  private origin = "";
  private url = "";
  problems: PreviewProblem[] = [];
  downloads: { file: string; url: string; at: string; ok: boolean }[] = [];
  readonly downloadDir: string;
  private readonly partition: string;

  constructor(
    private readonly win: BrowserWindow,
    root: string,
    private readonly onProblem: (p: PreviewProblem) => void = () => undefined,
  ) {
    const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
    this.partition = `persist:product-${id}`;
    this.downloadDir = path.join(os.tmpdir(), "agent-together-downloads", id);
  }

  private problem(p: Omit<PreviewProblem, "at">) {
    const full = { ...p, at: new Date().toISOString() };
    this.problems = [...this.problems, full].slice(-100);
    this.onProblem(full);
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    const wc = view.webContents;
    const inside = (url: string) => !!this.origin && url.startsWith(this.origin);
    const outside = (url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    };
    wc.setWindowOpenHandler(({ url }) => {
      if (inside(url)) void wc.loadURL(url);
      else outside(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (!inside(url)) {
        e.preventDefault();
        outside(url);
      }
    });
    // Electron 45 passes one event object; older versions passed (event, level, message, line, source).
    wc.on("console-message", (...args: unknown[]) => {
      const e = args[0] as { level?: unknown; message?: string; lineNumber?: number; sourceId?: string };
      const level = e.level ?? args[1];
      const message = e.message ?? (args[2] as string);
      if (level === "error" || level === 3) this.problem({ kind: "console", message: String(message), url: e.sourceId ?? (args[4] as string | undefined) });
    });
    wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.problem({ kind: "load", message: `页面没有打开：${description}（${code}）`, url });
    });
    const ses = sessions.fromPartition(this.partition);
    ses.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (d) => {
      if (d.webContentsId === wc.id && d.statusCode >= 400) this.problem({ kind: "network", message: `${d.method} 请求返回 ${d.statusCode}`, url: d.url });
    });
    ses.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (d) => {
      if (d.webContentsId === wc.id && d.error !== "net::ERR_ABORTED") this.problem({ kind: "network", message: `${d.method} 请求失败：${d.error}`, url: d.url });
    });
    ses.on("will-download", (_e, item) => {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      const file = path.join(this.downloadDir, `${Date.now()}-${item.getFilename()}`);
      item.setSavePath(file);
      const url = item.getURL();
      item.once("done", (_d, state) => {
        this.downloads = [...this.downloads, { file, url, at: new Date().toISOString(), ok: state === "completed" }].slice(-50);
      });
    });
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.view = view;
    return view;
  }

  /** Where the placeholder is in the window, or null to hide the page (another tab, a dialog on top). */
  place(bounds: Bounds | null) {
    if (!bounds || bounds.width < 2 || bounds.height < 2) return this.view?.setVisible(false);
    const view = this.ensure();
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    view.setVisible(true);
  }

  async load(url: string) {
    const view = this.ensure();
    this.origin = new URL(url).origin;
    this.url = url;
    this.problems = [];
    await view.webContents.loadURL(url).catch(() => undefined); // a failure is recorded by did-fail-load
  }

  reload() {
    this.view?.webContents.reload();
  }

  /** Blank page when the product stops, so nothing stale stays on screen. */
  async clear() {
    this.origin = "";
    this.url = "";
    await this.view?.webContents.loadURL("about:blank").catch(() => undefined);
  }

  get currentUrl(): string {
    return this.view?.webContents.getURL() || this.url;
  }

  /** A PNG of what the page shows now. */
  async capture(): Promise<Buffer | null> {
    if (!this.view) return null;
    return (await this.view.webContents.capturePage()).toPNG();
  }

  /** Runs script in the product page (automation and checks; never handed to the page from outside). */
  evaluate<T = unknown>(js: string): Promise<T> {
    return this.ensure().webContents.executeJavaScript(js, true);
  }

  /** A real (trusted) mouse click at page coordinates. */
  click(x: number, y: number) {
    const wc = this.ensure().webContents;
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  /** Types text into whatever has focus, as keyboard input. */
  type(text: string) {
    this.ensure().webContents.insertText(text);
  }

  destroy() {
    if (!this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
  }
}
