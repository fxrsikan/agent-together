import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Scenario, Spec } from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { RUN_CONVENTIONS } from "./product.js";

/**
 * Scenario acceptance (phase one, M4). Each confirmed scenario becomes a plan of
 * beats, one per line of the scenario (a step, an expected result, a data check,
 * an error check), each with concrete page actions and checks. The plan is
 * written once by the helper model, reading the product's front-end code, and kept:
 * re-running acceptance replays it without the model. Pass or fail is decided by
 * the checks themselves, on the real page with real input; a "judge" check (the
 * model reads the page) is the exception and is labelled as such.
 */

/** How an element is found: by what the user sees first, a CSS selector when that is clearer. */
export interface Target {
  /** Visible text of a button, link or other element. */
  text?: string;
  /** Label of a form field (its <label>, aria-label or placeholder). */
  label?: string;
  placeholder?: string;
  css?: string;
  /** button, link, textbox, checkbox, … narrows a text match. */
  role?: string;
  /** Which match, from 0, when there are several. */
  nth?: number;
  /** Look only inside the element matching this CSS selector (the first visible one, or `withinNth`). */
  within?: string;
  withinNth?: number;
}

export type Action =
  | { do: "goto"; path: string }
  | { do: "click"; target: Target }
  | { do: "fill"; target: Target; value: string }
  /** Types at the end of what the field already holds. */
  | { do: "append"; target: Target; value: string }
  | { do: "press"; key: "Enter" | "Escape" | "Tab" }
  /** How to answer the next confirm()/alert() box. */
  | { do: "dialog"; accept: boolean }
  | { do: "wait"; text: string; timeoutMs?: number }
  /** Keeps an element's text under a name; a later check's text can use {{name}}. */
  | { do: "remember"; name: string; target: Target }
  | { do: "reload" }
  /** Stops the product and starts it again (the browser then reopens the same page). */
  | { do: "restart" }
  | { check: "text"; text: string; present?: boolean; within?: Target }
  | { check: "count"; target: Target; count: number }
  | { check: "dialog"; text: string }
  /** A project-relative file (a glob matches any file) that contains all of these. */
  | { check: "file"; path: string; contains: string[] }
  | { check: "download"; contains: string[] }
  /** The helper model reads the page and answers; used only when no exact check fits. */
  | { check: "judge"; question: string };

export type BeatSource = "pre" | "step" | "expected" | "data" | "error";

export interface Beat {
  id: string;
  source: BeatSource;
  /** The scenario line it comes from, word for word. */
  ref: string;
  /** What it does, in plain words. */
  say: string;
  actions: Action[];
  /** Set when it cannot be checked automatically: why. Left to the user. */
  manual?: string;
}

export interface ScenarioPlan {
  scenarioId: string;
  /** Hash of the scenario: a changed scenario gets a new plan. */
  basis: string;
  createdAt: string;
  beats: Beat[];
}

export type BeatStatus = "pending" | "running" | "passed" | "failed" | "manual" | "skipped";

export interface BeatResult {
  id: string;
  source: BeatSource;
  ref: string;
  say: string;
  status: BeatStatus;
  /** What went wrong, in plain words. */
  error?: string;
  /** "locate": an element was not found (the plan may be out of date); "check": the product did something else. */
  failure?: "locate" | "check" | "other";
  /** Acceptance-relative path of the page as it looked after the beat. */
  shot?: string;
  /** Console errors and failed requests during the beat. */
  problems?: string[];
  manual?: string;
  /** A judge check decided it: the model's reason. */
  judged?: string;
  actions: Action[];
}

/** The page the acceptance drives: a real browser page with real input (the desktop app provides it). */
export interface PageDriver {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Runs script in the page; returns its (JSON-able) value. */
  eval<T = unknown>(js: string): Promise<T>;
  click(x: number, y: number): Promise<void>;
  /** Types text into the focused element; "\n" becomes Enter. */
  type(text: string): Promise<void>;
  press(key: "Enter" | "Escape" | "Tab" | "Backspace" | "End"): Promise<void>;
  /** How to answer the next dialogs. */
  answerDialogs(accept: boolean): void;
  /** Dialog messages seen so far, oldest first. */
  dialogs(): string[];
  screenshot(): Promise<Buffer | null>;
  url(): string;
  /** Console errors and failed requests since the last call. */
  takeProblems(): string[];
  /** Downloaded files so far. */
  downloads(): { file: string; ok: boolean }[];
}

export interface AcceptanceEnv {
  driver: PageDriver;
  /** The product's folder the checks read files from (the acceptance copy). */
  root: string;
  /** http://127.0.0.1:port */
  base: () => string;
  /** Restarts the product; resolves with its new base address. */
  restart: () => Promise<string>;
  /** Saves a screenshot under this name; returns the path to show, or null. */
  saveShot: (name: string, png: Buffer) => string | null;
  judge?: (question: string, page: string) => Promise<{ ok: boolean; why: string }>;
  /** True once the user asked to stop. */
  stopped?: () => boolean;
  /** Pause after page-changing actions, ms. */
  settleMs?: number;
}

// ---------------------------------------------------------------------------
// Page scripts. They run in the product page; kept here so the logic is in one place.

const PAGE_LIB = String.raw`
const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const own = (el) => norm(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "");
const ROLE = { button: "button,input[type=button],input[type=submit],[role=button],summary", link: "a,[role=link]", textbox: "input:not([type]),input[type=text],input[type=number],input[type=search],input[type=email],input[type=password],textarea,[contenteditable=''],[contenteditable=true],[role=textbox]", checkbox: "input[type=checkbox],[role=checkbox]", option: "option,[role=option]", select: "select", tab: "[role=tab]", heading: "h1,h2,h3,h4,h5,h6", listitem: "li,[role=listitem]", row: "tr,[role=row]" };
const FIELD = "input,textarea,select,[contenteditable=''],[contenteditable=true],[role=textbox]";
const CLICKY = "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=option],[role=checkbox],[onclick],[tabindex]";
function scopeOf(t) {
  if (!t || !t.within) return document;
  const all = [...document.querySelectorAll(t.within)].filter(vis);
  return all[t.withinNth || 0] || null;
}
function labelOf(el) {
  const bits = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.title, el.name];
  if (el.id) for (const l of document.querySelectorAll("label[for='" + CSS.escape(el.id) + "']")) bits.push(l.innerText);
  const wrap = el.closest("label"); if (wrap) bits.push(wrap.innerText);
  const by = el.getAttribute("aria-labelledby"); if (by) for (const id of by.split(/\s+/)) { const l = document.getElementById(id); if (l) bits.push(l.innerText); }
  let prev = el.previousElementSibling; if (prev && !prev.matches(FIELD)) bits.push(prev.innerText);
  if (!el.previousElementSibling && el.parentElement) { const p = el.parentElement.previousElementSibling; if (p && !p.matches(FIELD)) bits.push(p.innerText); }
  return bits.filter(Boolean).map(norm);
}
function find(t) {
  const scope = scopeOf(t);
  if (!scope) return { error: "找不到范围 " + t.within };
  let found = [];
  if (t.css) found = [...scope.querySelectorAll(t.css)];
  else if (t.label || t.placeholder) {
    const want = norm(t.label || t.placeholder);
    const fields = [...scope.querySelectorAll(FIELD)].filter(vis);
    const exact = fields.filter((el) => labelOf(el).some((l) => l === want || l.replace(/[：:*\s]/g, "") === want.replace(/[：:*\s]/g, "")));
    found = exact.length ? exact : fields.filter((el) => labelOf(el).some((l) => l.includes(want)));
  } else if (t.text) {
    const want = norm(t.text);
    const pool = [...scope.querySelectorAll(t.role && ROLE[t.role] ? ROLE[t.role] : "*")].filter((el) => !["HTML", "BODY", "HEAD", "SCRIPT", "STYLE"].includes(el.tagName));
    const exact = pool.filter((el) => own(el) === want);
    const near = exact.length ? exact : pool.filter((el) => own(el).includes(want));
    // The innermost element carrying the text, preferring something clickable.
    found = near.filter((el) => !near.some((o) => o !== el && el.contains(o)) || el.matches(CLICKY));
    found = found.filter((el) => !found.some((o) => o !== el && o.contains(el) && o.matches(CLICKY) && !el.matches(CLICKY)));
  } else if (t.role && ROLE[t.role]) found = [...scope.querySelectorAll(ROLE[t.role])];
  if (t.role && ROLE[t.role] && (t.css || t.label)) found = found.filter((el) => el.matches(ROLE[t.role]));
  found = found.filter(vis);
  return { found };
}
function describe(t) { return [t.text && "「" + t.text + "」", t.label && "标签「" + t.label + "」", t.placeholder && "提示「" + t.placeholder + "」", t.css && t.css, t.role && "(" + t.role + ")", t.nth ? "第 " + (t.nth + 1) + " 个" : "", t.within ? "在 " + t.within + (t.withinNth ? " 第 " + (t.withinNth + 1) + " 个" : "") + " 里" : ""].filter(Boolean).join(" "); }
function textOf(scope) {
  // A field itself: its value is what the user sees.
  if (scope.matches && scope.matches("input,textarea")) return scope.value;
  if (scope.matches && scope.matches("select")) return scope.selectedOptions[0] ? scope.selectedOptions[0].text : "";
  const parts = [scope.innerText || ""];
  for (const el of scope.querySelectorAll("input,textarea,select")) {
    if (el.type === "password" || el.type === "hidden") continue;
    parts.push(el.tagName === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].text : "") : el.value);
  }
  return parts.join("\n");
}
`;

/** Finds the element, scrolls it into view, focuses fields; returns its centre or why it was not found. */
export function locateJs(target: Target): string {
  return `(() => { ${PAGE_LIB}
const t = ${JSON.stringify(target)};
const r = find(t);
if (r.error) return { error: r.error };
const el = r.found[t.nth || 0];
if (!el) return { error: "页面上找不到 " + describe(t) + (r.found.length ? "（只有 " + r.found.length + " 个）" : "") };
el.scrollIntoView({ block: "center", inline: "center" });
const b = el.getBoundingClientRect();
window.__atTarget = el;
return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 20)), tag: el.tagName.toLowerCase() };
})()`;
}

/** Selects the located field's content, so typing replaces it. */
export const SELECT_TARGET_JS = `(() => { const el = window.__atTarget; if (!el) return false; el.focus();
if (typeof el.select === "function") { el.select(); return true; }
if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
return false; })()`;

/** Puts the caret after the located field's content. */
export const CARET_TO_END_JS = `(() => { const el = window.__atTarget; if (!el) return false; el.focus();
if (typeof el.setSelectionRange === "function") { const n = String(el.value || "").length; el.setSelectionRange(n, n); return true; }
if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
return false; })()`;

export function textJs(within?: Target): string {
  return `(() => { ${PAGE_LIB}
const t = ${JSON.stringify(within ?? null)};
if (!t) return textOf(document.body);
const r = find(t);
if (r.error) return { error: r.error };
const el = r.found[t.nth || 0];
if (!el) return { error: "页面上找不到 " + describe(t) };
return textOf(el);
})()`;
}

export function countJs(target: Target): string {
  return `(() => { ${PAGE_LIB} const r = find(${JSON.stringify(target)}); return r.error ? { error: r.error } : r.found.length; })()`;
}

/** What the page shows, compact: for the planner to see the page as it is. */
export const SNAPSHOT_JS = `(() => { ${PAGE_LIB}
const lines = ["地址：" + location.pathname + location.search, "标题：" + document.title];
const items = [];
for (const el of document.querySelectorAll(CLICKY + "," + FIELD + ",h1,h2,h3")) {
  if (!vis(el) || items.length > 120) continue;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const cls = el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "";
  const label = el.matches(FIELD) ? " 标签=" + JSON.stringify(labelOf(el)[0] || "") + " 值=" + JSON.stringify(String(el.value || el.innerText || "").slice(0, 60)) : " " + JSON.stringify(own(el).slice(0, 60));
  items.push("- " + tag + id + cls + label);
}
lines.push("元素：", ...items, "页面文字：", norm(document.body.innerText).slice(0, 2500));
return lines.join("\\n");
})()`;

// ---------------------------------------------------------------------------
// Running a plan.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Text compared without whitespace: "3 秒" and "3秒" are the same to a reader. */
export const squash = (s: string) => s.replace(/\s+/g, "");

class BeatFailure extends Error {
  constructor(
    message: string,
    readonly kind: "locate" | "check" | "other",
  ) {
    super(message);
  }
}

const fill = (text: string, memory: Map<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => memory.get(name) ?? `{{${name}}}`);

function within(root: string, rel: string): string {
  const file = path.resolve(root, rel);
  const back = path.relative(root, file);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new BeatFailure(`文件路径不在项目里：${rel}`, "other");
  return file;
}

/** A glob (*, ** and ?) over project-relative paths with forward slashes, as a regular expression. */
export function globRe(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Project-relative files under root (skipping node_modules and .git), forward slashes. */
export function walkFiles(root: string, skip: (rel: string, isDir: boolean) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const isDir = e.isDirectory();
      if (skip(r, isDir)) continue;
      if (isDir) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

/** Files matching a project-relative path or glob. */
export function matchFiles(root: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/[*?]/.test(norm)) {
    const file = within(root, norm);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? [norm] : [];
  }
  const re = globRe(norm);
  return walkFiles(root).filter((f) => re.test(f));
}

async function settle(env: AcceptanceEnv) {
  await sleep(env.settleMs ?? 350);
  for (let i = 0; i < 25; i++) {
    const ready = await env.driver.eval<string>("document.readyState").catch(() => "loading");
    if (ready === "complete") return;
    await sleep(200);
  }
}

async function locate(env: AcceptanceEnv, target: Target, tries = 6): Promise<{ x: number; y: number }> {
  let last = "";
  // Pages render after data arrives: give an element a moment to appear.
  for (let i = 0; i < tries; i++) {
    const r = await env.driver.eval<{ x: number; y: number } | { error: string }>(locateJs(target)).catch((e) => ({ error: String(e) }));
    if (!("error" in r)) return r;
    last = r.error;
    await sleep(400);
  }
  throw new BeatFailure(last, "locate");
}

async function pageText(env: AcceptanceEnv, scope?: Target): Promise<string> {
  const r = await env.driver.eval<string | { error: string }>(textJs(scope)).catch((e) => ({ error: String(e) }));
  if (typeof r !== "string") throw new BeatFailure(r.error, "locate");
  return r;
}

async function runAction(a: Action, env: AcceptanceEnv, memory: Map<string, string>, judged: string[]): Promise<void> {
  const d = env.driver;
  if ("do" in a) {
    switch (a.do) {
      case "goto": {
        const p = a.path.replace(/^https?:\/\/[^/]+/, "") || "/";
        await d.goto(env.base() + (p.startsWith("/") ? p : `/${p}`));
        return settle(env);
      }
      case "click": {
        const at = await locate(env, a.target);
        await d.click(at.x, at.y);
        return settle(env);
      }
      case "fill": {
        const at = await locate(env, a.target);
        await d.click(at.x, at.y);
        await d.eval(SELECT_TARGET_JS);
        await d.press("Backspace"); // clears the selection, so an empty value really empties the field
        if (a.value) await d.type(fill(a.value, memory));
        return settle(env);
      }
      case "append": {
        const at = await locate(env, a.target);
        await d.click(at.x, at.y);
        await d.eval(CARET_TO_END_JS);
        await d.type(fill(a.value, memory));
        return settle(env);
      }
      case "press":
        await d.press(a.key);
        return settle(env);
      case "dialog":
        d.answerDialogs(a.accept);
        return;
      case "wait": {
        const want = squash(fill(a.text, memory));
        const until = Date.now() + (a.timeoutMs ?? 8000);
        while (Date.now() < until) {
          if (squash(await pageText(env).catch(() => "")).includes(want)) return;
          await sleep(300);
        }
        throw new BeatFailure(`等了 ${Math.round((a.timeoutMs ?? 8000) / 1000)} 秒，页面上没有出现「${a.text}」`, "check");
      }
      case "remember": {
        await locate(env, a.target);
        const text = await d.eval<string>(`(() => { const el = window.__atTarget; return String(el.value ?? el.innerText ?? "").trim(); })()`);
        memory.set(a.name, text);
        return;
      }
      case "reload":
        await d.reload();
        return settle(env);
      case "restart": {
        // The same address the user had open, route after "#" included.
        const at = new URL(d.url() || env.base());
        const base = await env.restart();
        await d.goto(base + at.pathname + at.search + at.hash);
        return settle(env);
      }
    }
  }
  switch (a.check) {
    case "text": {
      const text = fill(a.text, memory);
      // Text that should appear may arrive a moment late; text that should be gone is checked once.
      const present = a.present !== false;
      let has = false;
      for (let i = 0; i < (present ? 8 : 1); i++) {
        has = squash(await pageText(env, a.within)).includes(squash(text));
        if (has === present) return;
        await sleep(400);
      }
      throw new BeatFailure(present ? `页面上${a.within ? `（${a.within.css ?? a.within.text ?? ""}里）` : ""}没有「${text}」` : `页面上不该有「${text}」，但是有`, "check");
    }
    case "count": {
      let n = -1;
      for (let i = 0; i < 6; i++) {
        const r = await d.eval<number | { error: string }>(countJs(a.target)).catch((e) => ({ error: String(e) }));
        if (typeof r !== "number") throw new BeatFailure(r.error, "locate");
        n = r;
        if (n === a.count) return;
        await sleep(400);
      }
      throw new BeatFailure(`应该有 ${a.count} 个 ${a.target.css ?? a.target.text ?? a.target.label ?? ""}，实际 ${n} 个`, "check");
    }
    case "dialog": {
      const seen = d.dialogs();
      if (seen.some((m) => squash(m).includes(squash(a.text)))) return;
      // A dialog the page draws itself (a modal) is a dialog to the user too.
      if (squash(await pageText(env).catch(() => "")).includes(squash(a.text))) return;
      throw new BeatFailure(seen.length ? `弹出的对话框是「${seen[seen.length - 1]}」，不是「${a.text}」` : `没有弹出写着「${a.text}」的对话框`, "check");
    }
    case "file": {
      const files = matchFiles(env.root, a.path);
      if (!files.length) throw new BeatFailure(`项目里没有文件 ${a.path}`, "check");
      const want = a.contains.map((c) => squash(fill(c, memory)));
      const ok = files.find((f) => {
        const body = squash(fs.readFileSync(path.join(env.root, f), "utf8"));
        return want.every((w) => body.includes(w));
      });
      if (!ok) throw new BeatFailure(`${files.join("、")} 里没有找到全部内容：${a.contains.join(" / ")}`, "check");
      return;
    }
    case "download": {
      const done = d.downloads().filter((x) => x.ok);
      const last = done[done.length - 1];
      if (!last) throw new BeatFailure("没有下载到文件", "check");
      const body = squash(fs.readFileSync(last.file, "utf8"));
      const missing = a.contains.filter((c) => !body.includes(squash(fill(c, memory))));
      if (missing.length) throw new BeatFailure(`下载的文件里没有：${missing.join(" / ")}`, "check");
      return;
    }
    case "judge": {
      if (!env.judge) throw new BeatFailure("没有帮手模型来判断这一条", "other");
      const verdict = await env.judge(a.question, await pageText(env));
      judged.push(verdict.why);
      if (!verdict.ok) throw new BeatFailure(`助手看了页面后认为不符合：${verdict.why}`, "check");
      return;
    }
  }
}

/** Runs one beat on the page; never throws. */
export async function runBeat(beat: Beat, env: AcceptanceEnv, memory: Map<string, string>, shotName: string): Promise<BeatResult> {
  const base: BeatResult = { id: beat.id, source: beat.source, ref: beat.ref, say: beat.say, status: "running", actions: beat.actions };
  if (beat.manual) return { ...base, status: "manual", manual: beat.manual };
  const judged: string[] = [];
  let failure: BeatFailure | null = null;
  env.driver.takeProblems();
  for (const a of beat.actions) {
    try {
      await runAction(a, env, memory, judged);
    } catch (err) {
      failure = err instanceof BeatFailure ? err : new BeatFailure(err instanceof Error ? err.message : String(err), "other");
      break;
    }
  }
  const problems = env.driver.takeProblems();
  const png = await env.driver.screenshot().catch(() => null);
  const shot = png ? env.saveShot(shotName, png) ?? undefined : undefined;
  return {
    ...base,
    status: failure ? "failed" : "passed",
    ...(failure ? { error: failure.message, failure: failure.kind } : {}),
    ...(shot ? { shot } : {}),
    ...(problems.length ? { problems } : {}),
    ...(judged.length ? { judged: judged.join("；") } : {}),
  };
}

// ---------------------------------------------------------------------------
// Planning.

/** Bumped when the action grammar or the planning rules change: kept scripts are written again. */
export const PLAN_RULES_VERSION = 2;

export const scenarioBasis = (s: Scenario) =>
  createHash("sha1")
    .update(JSON.stringify([PLAN_RULES_VERSION, s.name, s.preconditions, s.input, s.steps, s.expected, s.dataChecks, s.errorChecks]))
    .digest("hex")
    .slice(0, 12);

const CODE_EXT = /\.(html?|m?js|jsx|tsx?|vue|svelte|css)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", ".agent-together", ".claude", ".codex", ".cursor", "test", "tests", "__tests__", "dist", "build", "coverage"]);

/** The product's page and server code, front end first, within a budget: what the planner reads to name elements exactly. */
export function frontEndCode(root: string, budget = 60_000): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), r);
      } else if (CODE_EXT.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) files.push(r);
    }
  };
  walk(root, "");
  const rank = (f: string) => (/\.html?$/.test(f) ? 0 : /^(public|static|web|client|www|pages|views|frontend)\//.test(f) ? 1 : /server|route|api|app\./i.test(f) ? 2 : 3);
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let out = "";
  for (const f of files) {
    if (out.length >= budget) break;
    const body = fs.readFileSync(path.join(root, f), "utf8");
    out += `\n### ${f}\n\`\`\`\n${body.slice(0, Math.min(10_000, budget - out.length))}\n\`\`\`\n`;
  }
  return out;
}

const ACTION_GRAMMAR = `每个 beat 的 actions 按顺序执行，可以用这些（target 是找元素的方式）：
- {"do":"goto","path":"/某个页面"}
- {"do":"click","target":T}
- {"do":"fill","target":T,"value":"要输入的文字，可以多行"}   先清空再输入，用真实键盘输入；value 为空字符串就是清空
- {"do":"append","target":T,"value":"……"}   在输入框已有内容的末尾接着输入，不清空；要在已有正文的某一段末尾加一句时，用它在末尾加，或者用 fill 写入改好后的完整正文
- {"do":"press","key":"Enter"|"Escape"|"Tab"}
- {"do":"dialog","accept":true|false}   在会弹出确认框的点击之前写，决定点「确定」还是「取消」
- {"do":"wait","text":"已保存","timeoutMs":8000}   等页面上出现这段文字
- {"do":"remember","name":"words","target":T}   记下元素的文字，后面检查里用 {{words}}
- {"do":"reload"}   刷新页面
- {"do":"restart"}   关掉程序再启动，然后浏览器重新打开同一个页面
- {"check":"text","text":"……","present":true|false,"within":T}   页面（或某个范围里）有或没有这段文字，空白不算；输入框里的值也算页面文字
- {"check":"count","target":T,"count":2}
- {"check":"dialog","text":"确认框里的文字"}   确认框里有这段文字：浏览器自己的 confirm/alert 框，或页面画出来的弹窗都算；页面弹窗里的按钮用 click 加 within 去点
- {"check":"file","path":"manuscript/*.md","contains":["……"]}   项目文件夹里的文件
- {"check":"download","contains":["……"]}   最后下载的文件
- {"check":"judge","question":"……"}   只有上面的检查都表达不了时才用：让助手读页面文字回答是否符合（它能看到场景的输入原文）
T 的写法：{"text":"保存","role":"button"}、{"label":"章节标题"}、{"placeholder":"……"}、{"css":"#save"}、{"css":".shot-item","nth":0}，
可以加 "within":"CSS选择器"（和 "withinNth":0）限定在某个区域里找，比如第 1 条镜头里的文字：{"css":".shot","nth":0} 作为 within 目标，或 "within":".shot","withinNth":0。
优先用代码里真实存在的 id、文字和标签；同样的文字有多个时用 within 或 nth 区分。`;

const PLAN_RULES = `规则：
- 按执行顺序列出 beats。场景的每一条 steps、expected、dataChecks、errorChecks 各对应一个 beat，source 分别是 step / expected / data / error，ref 原样抄那一条；为满足前提条件需要先做的操作放在最前面，source 为 pre，ref 抄对应的前提条件。
- expected 的检查放在能检查它的那一步之后；dataChecks 自己包含刷新（reload）或重启（restart）的动作，再做检查；errorChecks 放在场景最后，每条先做出错的操作、检查提示，再把页面恢复正常（不要破坏后面场景需要的数据）。
- 「关闭浏览器标签页、停止程序、重新运行程序、打开同一个地址」合起来用一个 restart。「记下数字」用 remember，后面再用 {{名字}} 比较。
- 输入的内容用场景 input 里的原文，一个字也不要改。
- 自动化做不到的（比如改文件夹权限、断网、要打开代码里没有提供的测试开关、要用真实的外部服务），这个 beat 写 "manual":"做不到的原因"，actions 留空，留给用户亲手检查。代码里确实有测试开关（比如 URL 参数或页面按钮）才可以用。
- 检查要具体：用 text、count、file、dialog 写清楚页面上应该有什么，不要只检查“没有报错”。
- 要确认输入的原文都在：对原文里的每一行（或每个标题、每句关键句）各写一个 text 检查，不要用 judge。
- 页面的地址从 "/" 开始，程序已经启动。`;

function scenarioText(s: Scenario): string {
  const list = (title: string, items: string[]) => (items.length ? `${title}：\n${items.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : `${title}：（无）`);
  return [
    `${s.id} ${s.name}`,
    list("前提条件", s.preconditions),
    `输入：\n${s.input || "（无）"}`,
    list("步骤 steps", s.steps),
    list("期望结果 expected", s.expected),
    list("数据检查 dataChecks", s.dataChecks),
    list("错误检查 errorChecks", s.errorChecks),
  ].join("\n\n");
}

export function planPrompt(spec: Spec, scenario: Scenario, code: string, earlier: Scenario[], snapshot: string): string {
  return `你在为一个本地网页产品写自动验收脚本。浏览器会按脚本用真实的鼠标和键盘操作产品页面，脚本里的检查决定场景是否通过。

产品：${spec.goal}
页面：${spec.pages.map((p) => `${p.name}（${p.purpose}）`).join("；")}
数据：${spec.data}
运行约定：
${RUN_CONVENTIONS}

${earlier.length ? `这个场景之前已经按顺序验收过：${earlier.map((s) => `${s.id} ${s.name}`).join("；")}。它们留下的数据还在，不要重复准备。这个场景提到前面场景的输入时，原文如下：
${earlier.filter((s) => s.input).map((s) => `【${s.id} 的输入】\n${s.input}`).join("\n\n")}` : "这是第一个验收的场景，产品的数据是空的。"}

要验收的场景：
${scenarioText(scenario)}

${ACTION_GRAMMAR}

${PLAN_RULES}

现在打开首页看到的是：
${snapshot}

产品代码（部分）：
${code}

只输出 JSON：{"beats":[{"source":"step","ref":"那一条原文","say":"用一句话说这一步做什么","actions":[...]} ...]}`;
}

export function replanPrompt(spec: Spec, scenario: Scenario, code: string, done: BeatResult[], failed: BeatResult, rest: Beat[], snapshot: string): string {
  return `你在为一个本地网页产品写自动验收脚本（${spec.goal}）。脚本跑到一半，有一步找不到页面元素，可能是脚本写错了元素的位置或文字。请根据页面现在的样子，从失败的那一步开始重写后面的 beats。

场景：
${scenarioText(scenario)}

已经做完的：
${done.map((b) => `- [${b.status === "passed" ? "通过" : b.status}] ${b.say}`).join("\n") || "（无）"}

失败的这一步：${failed.say}
动作：${JSON.stringify(failed.actions)}
错误：${failed.error}

原计划后面还有：
${rest.map((b) => `- (${b.source}) ${b.ref}`).join("\n") || "（无）"}

页面现在是：
${snapshot}

${ACTION_GRAMMAR}

${PLAN_RULES}
- 只是找元素的方式写错了才改动作；不要为了让检查通过而放宽检查。

产品代码（部分）：
${code}

只输出 JSON：{"beats":[ 从失败的那一步开始的 beats ]}`;
}

const SOURCES: BeatSource[] = ["pre", "step", "expected", "data", "error"];

/** Turns the model's reply into beats, dropping what does not fit the grammar. */
export function parseBeats(reply: string, prefix: string): Beat[] | null {
  const raw = parseJsonObject<{ beats?: unknown }>(reply);
  if (!raw || !Array.isArray(raw.beats)) return null;
  const beats: Beat[] = [];
  for (const b of raw.beats as Record<string, unknown>[]) {
    if (!b || typeof b !== "object") continue;
    const source = SOURCES.includes(b.source as BeatSource) ? (b.source as BeatSource) : "step";
    const actions = (Array.isArray(b.actions) ? b.actions : []).filter(validAction) as Action[];
    const manual = typeof b.manual === "string" && b.manual.trim() ? b.manual.trim() : undefined;
    if (!actions.length && !manual) continue;
    beats.push({
      id: `${prefix}-${String(beats.length + 1).padStart(2, "0")}`,
      source,
      ref: String(b.ref ?? b.say ?? ""),
      say: String(b.say ?? b.ref ?? ""),
      actions: manual ? [] : actions,
      ...(manual ? { manual } : {}),
    });
  }
  return beats.length ? beats : null;
}

function validTarget(t: unknown): boolean {
  if (!t || typeof t !== "object") return false;
  const x = t as Target;
  return !!(x.text || x.label || x.placeholder || x.css || x.role);
}

function validAction(a: unknown): boolean {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  switch (x.do) {
    case "goto":
      return typeof x.path === "string";
    case "click":
      return validTarget(x.target);
    case "fill":
    case "append":
      return validTarget(x.target) && typeof x.value === "string";
    case "press":
      return ["Enter", "Escape", "Tab"].includes(x.key as string);
    case "dialog":
      return typeof x.accept === "boolean";
    case "wait":
      return typeof x.text === "string";
    case "remember":
      return typeof x.name === "string" && validTarget(x.target);
    case "reload":
    case "restart":
      return true;
  }
  switch (x.check) {
    case "text":
      return typeof x.text === "string" && (x.within === undefined || validTarget(x.within));
    case "count":
      return validTarget(x.target) && typeof x.count === "number";
    case "dialog":
      return typeof x.text === "string";
    case "file":
      return typeof x.path === "string" && Array.isArray(x.contains);
    case "download":
      return Array.isArray(x.contains);
    case "judge":
      return typeof x.question === "string";
  }
  return false;
}

/** Asks the model for a plan; one retry when the reply does not parse. */
export async function planScenario(llm: Llm, prompt: string, prefix: string): Promise<Beat[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await llm.complete(attempt ? `${prompt}\n\n上一次的回复不是有效的 JSON 或没有可执行的 beats。请只输出 JSON。` : prompt, { timeoutMs: 240_000, maxTokens: 12_000 });
    const beats = parseBeats(reply, prefix);
    if (beats) return beats;
  }
  throw new Error("帮手模型没有给出能执行的验收脚本");
}

export function judgePrompt(question: string, page: string, scenario = ""): string {
  return `你在验收一个网页产品。只根据下面的页面文字回答问题，不要猜测页面上没有的东西。问题里提到的输入、原文、示例，就是场景里写的那些。

${scenario ? `场景：
${scenario}

` : ""}问题：${question}

页面文字（输入框里的内容也在里面）：
${page.slice(0, 6000)}

先想清楚理由，再下结论，结论要和理由一致。只输出 JSON：{"why":"一两句理由，引用页面上的原文","ok":true 或 false}`;
}

async function judgeOnce(llm: Llm, question: string, page: string, scenario: string): Promise<{ ok: boolean; why: string } | null> {
  // One retry when the reply does not parse.
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = judgePrompt(question, page, scenario) + (attempt ? "\n\n上一次的回复不是有效的 JSON。请只输出 JSON。" : "");
    const raw = parseJsonObject<{ ok?: boolean; why?: string }>(await llm.complete(prompt, { timeoutMs: 90_000, maxTokens: 600 }).catch(() => ""));
    if (raw && typeof raw.ok === "boolean") return { ok: raw.ok, why: String(raw.why ?? "") };
  }
  return null;
}

/**
 * The model reads the page and answers. A "no" is asked once more: only two
 * independent "no"s fail the check, so one confused answer does not fail a
 * working product. No clear answer at all counts as not passing.
 */
export async function judgePage(llm: Llm, question: string, page: string, scenario = ""): Promise<{ ok: boolean; why: string }> {
  const first = await judgeOnce(llm, question, page, scenario);
  if (first?.ok) return first;
  const second = await judgeOnce(llm, question, page, scenario);
  if (second?.ok) return second;
  return second ?? first ?? { ok: false, why: "助手没有给出明确的判断" };
}

// ---------------------------------------------------------------------------
// Scenario run with one re-plan when the page does not match the plan.

export interface ScenarioResult {
  id: string;
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "error";
  beats: BeatResult[];
  /** Times the plan was rewritten from a step that found no element. */
  replans: number;
  error?: string;
  /** Requests that failed during the scenario's normal steps (not its error checks). */
  networkProblems: string[];
}

export interface ScenarioRunOptions {
  /** Rewrites the plan from a failed beat; null when it cannot (no helper model). */
  replan: ((done: BeatResult[], failed: BeatResult, rest: Beat[]) => Promise<Beat[] | null>) | null;
  onBeat?: (result: ScenarioResult) => void;
  maxReplans?: number;
  /**
   * Around the error checks: they provoke failures (an empty chapter, a bad value)
   * that must not leak into the next scenario. Called before the first error beat
   * and once after the scenario, when there were error beats.
   */
  beforeErrors?: () => Promise<void>;
  afterErrors?: () => Promise<void>;
}

export async function runScenario(scenario: Scenario, beats: Beat[], env: AcceptanceEnv, opts: ScenarioRunOptions): Promise<{ result: ScenarioResult; beats: Beat[] }> {
  const result: ScenarioResult = { id: scenario.id, name: scenario.name, status: "running", beats: [], replans: 0, networkProblems: [] };
  const memory = new Map<string, string>();
  let plan = [...beats];
  let i = 0;
  let inErrors = false;
  while (i < plan.length) {
    if (env.stopped?.()) {
      result.status = "error";
      result.error = "验收被结束了";
      return { result, beats: plan };
    }
    const beat = plan[i];
    if (beat.source === "error" && !beat.manual && !inErrors && opts.beforeErrors) {
      inErrors = true;
      await opts.beforeErrors();
    }
    const r = await runBeat(beat, env, memory, `${scenario.id}-${String(i + 1).padStart(2, "0")}`);
    if (r.status === "failed" && r.failure === "locate" && opts.replan && result.replans < (opts.maxReplans ?? 2)) {
      const fresh = await opts.replan(result.beats, r, plan.slice(i + 1)).catch(() => null);
      if (fresh?.length) {
        result.replans++;
        plan = [...plan.slice(0, i), ...fresh.map((b, k) => ({ ...b, id: `${scenario.id}-r${result.replans}-${String(k + 1).padStart(2, "0")}` }))];
        continue; // the same position, with the rewritten beat
      }
    }
    result.beats.push(r);
    if (r.problems && r.source !== "error") result.networkProblems.push(...r.problems.filter((p) => /请求/.test(p)));
    opts.onBeat?.(structuredClone(result));
    // A step that did not happen leaves nothing meaningful to check after it.
    if (r.status === "failed" && (r.source === "step" || r.source === "pre")) {
      for (const rest of plan.slice(i + 1)) result.beats.push({ id: rest.id, source: rest.source, ref: rest.ref, say: rest.say, status: "skipped", actions: rest.actions, ...(rest.manual ? { manual: rest.manual } : {}) });
      break;
    }
    i++;
  }
  if (inErrors) await opts.afterErrors?.().catch(() => undefined);
  result.status = result.beats.some((b) => b.status === "failed") ? "failed" : "passed";
  return { result, beats: plan };
}

// ---------------------------------------------------------------------------
// Evidence layers: all must pass for the version to count as done.

export type LayerId = "build" | "tests" | "audit" | "interface" | "interaction" | "persistence" | "scenarios" | "delivery";
export type LayerStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface Layer {
  id: LayerId;
  name: string;
  status: LayerStatus;
  detail: string;
}

export const LAYER_NAMES: Record<LayerId, string> = {
  build: "构建",
  tests: "单元测试",
  audit: "事后检查",
  interface: "接口",
  interaction: "交互",
  persistence: "持久化",
  scenarios: "业务场景",
  delivery: "交付",
};

const beatsOf = (results: ScenarioResult[], sources: BeatSource[]) => results.flatMap((r) => r.beats.filter((b) => sources.includes(b.source)));

/** The layers that come from the scenario runs. */
export function scenarioLayers(results: ScenarioResult[], scenarios: Scenario[], serviceMode: "mock" | "real"): Layer[] {
  const layer = (id: LayerId, status: LayerStatus, detail: string): Layer => ({ id, name: LAYER_NAMES[id], status, detail });
  const failedNames = (bs: BeatResult[]) =>
    bs
      .filter((b) => b.status === "failed" || b.status === "skipped")
      .slice(0, 3)
      .map((b) => `「${b.say}」`)
      .join("、");

  const steps = beatsOf(results, ["pre", "step"]);
  const stepsOk = steps.length > 0 && steps.every((b) => b.status === "passed");
  const data = beatsOf(results, ["data"]);
  const dataAuto = data.filter((b) => b.status !== "manual");
  const dataOk = dataAuto.length > 0 && dataAuto.every((b) => b.status === "passed");
  const network = results.flatMap((r) => r.networkProblems);
  const apiScenarios = scenarios.filter((s) => s.verify.includes("api")).map((s) => s.id);
  const apiOk = network.length === 0 && results.filter((r) => apiScenarios.includes(r.id)).every((r) => r.status === "passed");
  const passed = results.filter((r) => r.status === "passed").length;
  const manual = beatsOf(results, ["pre", "step", "expected", "data", "error"]).filter((b) => b.status === "manual").length;

  return [
    layer(
      "interface",
      apiOk ? "passed" : "failed",
      apiOk ? `页面和服务器之间的请求都成功了${apiScenarios.length ? `（${apiScenarios.join("、")} 走通）` : ""}` : network.length ? `有 ${network.length} 个请求失败：${network.slice(0, 2).join("；")}` : `要检查接口的场景没有通过：${apiScenarios.join("、")}`,
    ),
    layer("interaction", stepsOk ? "passed" : "failed", stepsOk ? `用真实的鼠标和键盘做完了 ${steps.length} 个操作步骤` : `这些步骤没有做成：${failedNames(steps)}`),
    layer(
      "persistence",
      dataOk ? "passed" : "failed",
      dataOk ? `刷新和重启之后检查了 ${dataAuto.length} 项数据，都对` : dataAuto.length ? `这些数据检查没有通过：${failedNames(dataAuto)}` : "没有能自动做的数据检查",
    ),
    layer(
      "scenarios",
      passed === scenarios.length && passed > 0 ? "passed" : "failed",
      `${passed} / ${scenarios.length} 个场景通过，用的是${serviceMode === "real" ? "真实服务" : "示例服务"}${manual ? `；另有 ${manual} 项自动化做不到，留给你亲手检查` : ""}`,
    ),
  ];
}

/** What to hand to the assistant when acceptance did not pass: one task per failing scenario, with the evidence. */
export function failureTask(result: ScenarioResult, shotsDir: string): string {
  const bad = result.beats.filter((b) => b.status === "failed");
  const lines = bad.map((b) => {
    const extra = [b.problems?.length ? `页面错误：${b.problems.slice(0, 3).join("；")}` : "", b.shot ? `截图：${path.join(shotsDir, path.basename(b.shot))}` : ""].filter(Boolean).join("\n  ");
    return `- 「${b.ref}」\n  做的是：${b.say}\n  结果：${b.error}${extra ? `\n  ${extra}` : ""}`;
  });
  return `按使用场景自动验收时，「${result.id} ${result.name}」没有通过：\n${lines.join("\n")}\n\n请找到原因并修好，让这个场景完全按需求走通。不要为了通过验收去改场景或删掉功能。`;
}
