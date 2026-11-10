import fs from "node:fs";
import path from "node:path";
import {
  Canvas,
  ChatMessage,
  Decision,
  Scenario,
  Spec,
  VerifyBy,
  type CanvasEdge,
  type CanvasNode,
  type Capability,
  type SpecQuestion,
} from "@agent-together/schema";
import { parseJsonObject } from "./judge.js";
import type { Llm } from "./llm.js";
import { canvasFromDraft } from "./planner.js";
import { rolesFromDraft } from "./roles.js";
import { RUN_CONVENTIONS } from "./product.js";

/**
 * Requirements first (phase one, M1): a conversation with the helper model acting
 * as product manager, a requirements spec with usage scenarios the user confirms,
 * and the canvas planned (or an existing one migrated) from the confirmed spec.
 *
 *   .agent-together/spec/spec.json          the spec being worked on
 *   .agent-together/spec/confirmed.json     the last version the user confirmed
 *   .agent-together/spec/conversation.json  the requirements conversation
 *   .agent-together/decisions/*.json        decisions, one file each
 */
export class SpecStore {
  private readonly dir: string;
  private readonly decisionsDir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, ".agent-together", "spec");
    this.decisionsDir = path.join(root, ".agent-together", "decisions");
  }

  private read<T>(name: string, parse: (v: unknown) => T): T | null {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return null;
    try {
      return parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  private write(name: string, value: unknown) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value, null, 2) + "\n");
  }

  load(): Spec | null {
    return this.read("spec.json", (v) => Spec.parse(v));
  }

  confirmed(): Spec | null {
    return this.read("confirmed.json", (v) => Spec.parse(v));
  }

  /** Saves the working spec. Editing a confirmed spec makes it a draft again until confirmed. */
  save(input: unknown): Spec {
    const spec = Spec.parse(input);
    const confirmed = this.confirmed();
    const same = confirmed && sameScope(confirmed, spec);
    const saved = Spec.parse({ ...spec, status: same ? "confirmed" : "draft", confirmedAt: same ? confirmed.confirmedAt : undefined });
    this.write("spec.json", saved);
    return saved;
  }

  /** The user confirmed this version's scope: keep it as the reference later changes are measured against. */
  confirm(input: unknown, detail?: string): Spec {
    const before = this.confirmed();
    const spec = Spec.parse({ ...Spec.parse(input), status: "confirmed", confirmedAt: new Date().toISOString() });
    this.write("spec.json", spec);
    this.write("confirmed.json", spec);
    this.decide(
      before ? "change-scope" : "confirm-scope",
      before ? `修改了第 ${spec.version} 版的范围` : `确认了第 ${spec.version} 版：${spec.scenarios.length} 个使用场景`,
      detail,
    );
    return spec;
  }

  /** Records which cards cover each scenario, in the working and the confirmed spec. Not a scope change: no decision. */
  linkCards(canvas: Canvas): void {
    for (const name of ["spec.json", "confirmed.json"]) {
      const spec = this.read(name, (v) => Spec.parse(v));
      if (spec) this.write(name, linkScenarios(spec, canvas));
    }
  }

  /** The prototype was tried: pages and flow are right, or here is what to change. Neither changes the scope. */
  prototypeVerdict(ok: boolean, feedback = ""): Spec | null {
    const at = new Date().toISOString();
    if (ok) {
      for (const name of ["spec.json", "confirmed.json"]) {
        const spec = this.read(name, (v) => Spec.parse(v));
        if (spec) this.write(name, { ...spec, prototypeConfirmedAt: at });
      }
      this.decide("confirm-prototype", "试用了示例数据版本：页面和流程没问题，可以接真实业务逻辑");
    } else {
      this.say({ role: "user", text: `【原型反馈】${feedback.trim()}` });
      this.decide("prototype-feedback", "试用了示例数据版本，页面或流程要改", feedback.trim());
    }
    return this.load();
  }

  /** Acceptance results per scenario, in the working and the confirmed spec. Progress, not a scope change. */
  markScenarios(statuses: Record<string, Scenario["status"]>): void {
    for (const name of ["spec.json", "confirmed.json"]) {
      const spec = this.read(name, (v) => Spec.parse(v));
      if (spec) this.write(name, { ...spec, scenarios: spec.scenarios.map((s) => (statuses[s.id] ? { ...s, status: statuses[s.id] } : s)) });
    }
  }

  conversation(): ChatMessage[] {
    return this.read("conversation.json", (v) => ChatMessage.array().parse(v)) ?? [];
  }

  say(message: Omit<ChatMessage, "at">): ChatMessage[] {
    const all = [...this.conversation(), ChatMessage.parse({ ...message, at: new Date().toISOString() })];
    this.write("conversation.json", all);
    return all;
  }

  decisions(): Decision[] {
    if (!fs.existsSync(this.decisionsDir)) return [];
    return fs
      .readdirSync(this.decisionsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .flatMap((f) => {
        try {
          return [Decision.parse(JSON.parse(fs.readFileSync(path.join(this.decisionsDir, f), "utf8")))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  decide(kind: Decision["kind"], summary: string, detail?: string): Decision {
    const at = new Date().toISOString();
    const id = `${at.replace(/[-:.Z]/g, "").replace("T", "-")}-${kind}-${Math.random().toString(36).slice(2, 6)}`;
    const decision = Decision.parse({ id, at, kind, summary, ...(detail ? { detail } : {}) });
    fs.mkdirSync(this.decisionsDir, { recursive: true });
    fs.writeFileSync(path.join(this.decisionsDir, `${id}.json`), JSON.stringify(decision, null, 2) + "\n");
    return decision;
  }
}

/** The parts of a spec the user confirms; scenario progress and link to cards do not count as a change. */
function scopeOf(spec: Spec) {
  const { status, confirmedAt, prototypeConfirmedAt, scenarios, ...rest } = spec;
  return { ...rest, scenarios: scenarios.map(({ status: _s, tasks: _t, ...s }) => s) };
}
const sameScope = (a: Spec, b: Spec) => JSON.stringify(scopeOf(a)) === JSON.stringify(scopeOf(b));

/* ---------- the requirements conversation ---------- */

export interface ProjectContext {
  name: string;
  description?: string;
  /** For an existing project: its cards, so the questions start from what is there. */
  canvas?: Canvas;
}

const SCOPE_RULES = `这一阶段只做"本地网页应用"：一个人用，数据存在这台电脑上，在这台电脑上运行，用浏览器打开。不做账号登录、多人协作、公网部署、手机应用。需要外部服务（比如 AI 生成）时，先用示例服务把流程跑通，再接真实服务。`;

function contextText(ctx: ProjectContext): string {
  const parts = [`项目名：${ctx.name}`];
  if (ctx.description?.trim()) parts.push(`已有的产品描述：${ctx.description.trim()}`);
  if (ctx.canvas?.nodes.length) {
    parts.push(
      `这个项目已经有代码和开发画布，现有卡片：\n${ctx.canvas.nodes
        .map((n) => `- ${n.title}（${n.id}，${n.files.join(" ") || "没有文件"}）：${n.intent.goal || "没写目标"}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

const transcript = (conversation: ChatMessage[]) =>
  conversation
    .map((m) => `${m.role === "user" ? "用户" : "你"}：${m.text}${m.questions?.length ? `\n（你问了：${m.questions.map((q) => q.question).join("；")}）` : ""}`)
    .join("\n\n");

export function requirementsPrompt(conversation: ChatMessage[], ctx: ProjectContext): string {
  return `你是一位耐心的产品经理，正在帮一个不会写代码的人弄清楚他想做的软件。用大白话，不要出现技术术语。

${SCOPE_RULES}

${contextText(ctx)}

到目前为止的对话：
${transcript(conversation) || "（还没有）"}

你要做的：
- 先用一两句话复述你理解的内容，再提出还需要弄清楚的问题。
- 一次最多问 3 个问题，挑最影响"第一版做什么"的问。每个问题给 2 到 4 个可以直接点选的答案，推荐的放第一个；why 用一句话说为什么要问。
- 要弄清楚的事：给谁用、主要要完成什么事、第一版做哪些不做哪些、有哪些页面、数据怎么保存、要不要外部服务、怎样算第一版做完了。
- 用户要的东西超出这一阶段的范围时，直接说明，并建议第一版先做什么。
- 已经足够写出需求说明时，ready 设为 true，questions 可以为空，reply 里告诉用户可以点"整理成需求说明"了。

只输出 JSON：{"reply":"...","questions":[{"id":"q1","question":"...","options":["推荐的答案","..."],"why":"..."}],"ready":false}`;
}

export interface RequirementsTurn {
  text: string;
  questions: SpecQuestion[];
  ready: boolean;
}

export function parseRequirementsTurn(reply: string): RequirementsTurn | null {
  const raw = parseJsonObject<{ reply?: unknown; questions?: unknown; ready?: unknown }>(reply);
  if (!raw || typeof raw.reply !== "string" || !raw.reply.trim()) return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .flatMap((q, i): SpecQuestion[] => {
      if (!q || typeof q !== "object") return [];
      const { question, options, why } = q as Record<string, unknown>;
      if (typeof question !== "string" || !question.trim()) return [];
      return [{ id: `q${i + 1}`, question: question.trim(), options: strings(options).slice(0, 4), ...(typeof why === "string" && why.trim() ? { why: why.trim() } : {}) }];
    })
    .slice(0, 3);
  return { text: raw.reply.trim(), questions, ready: raw.ready === true };
}

/** One turn of the conversation: the model's reply to what the user just said. Retries once on a reply it cannot read. */
export async function requirementsTurn(llm: Llm, conversation: ChatMessage[], ctx: ProjectContext): Promise<RequirementsTurn> {
  const prompt = requirementsPrompt(conversation, ctx);
  const ask = (p: string) => llm.complete(p, { timeoutMs: 120_000, maxTokens: 2000 });
  const turn = parseRequirementsTurn(await ask(prompt)) ?? parseRequirementsTurn(await ask(`${prompt}\n\n上一次的回复不是要求的 JSON。这次只输出那个 JSON 对象。`));
  if (!turn) throw new Error("帮手模型两次都没有给出能读懂的回复，请再说一次");
  return turn;
}

/* ---------- the requirements spec ---------- */

export function specPrompt(conversation: ChatMessage[], ctx: ProjectContext, previous: Spec | null): string {
  return `根据下面的需求对话，写出第一版的需求说明。读者是不会写代码的用户，用大白话；场景要写到能一步步照着操作、能检查结果的程度。

${SCOPE_RULES}

${contextText(ctx)}

对话：
${transcript(conversation)}
${previous ? `\n之前的需求说明（在它的基础上改，已有场景沿用原来的 id）：\n${JSON.stringify(scopeOf(previous), null, 1)}\n` : ""}
要求：
- audience：给谁用。goal：主要要完成什么事，一两句话。
- inScope / outOfScope：第一版做哪些、不做哪些（不做的要写，留到以后）。
- pages：每个页面的 name 和 purpose。flow：用户在页面之间怎么走，一步一句。
- data：数据怎么保存（第一阶段存在本机）。
- services：需要的外部服务，name、purpose；第一版先用示例服务，mode 写 "mock"。不需要就空着。
- scenarios：3 到 6 个使用场景，覆盖第一版的主要业务。每个场景：
  - name：一句话说用户要完成什么。
  - preconditions：前置条件，写明用示例服务还是真实服务。
  - input：一个固定的测试样例（比如一段具体的示例文字），后面的预期结果针对它来写。
  - steps：用户一步步做什么。
  - expected：针对这个样例的预期结果，具体到能检查（不要写"至少 3 条"这种和输入无关的数字，除非样例就是这样）。
  - dataChecks：保存、刷新或重启后数据是否还对。
  - errorChecks：出错时用户看到什么、能不能重试、已输入的内容会不会丢。
  - verify：怎么验证，从 "browser"（在浏览器里操作）、"api"（检查接口）、"file"（检查导出的文件）里选。
  - 已有场景保留原来的 id（如 "S-01"）；新场景不写 id。

只输出 JSON：{"audience":"...","goal":"...","inScope":["..."],"outOfScope":["..."],"pages":[{"name":"...","purpose":"..."}],"flow":["..."],"data":"...","services":[{"name":"...","purpose":"...","mode":"mock"}],"scenarios":[{"id":"S-01","name":"...","preconditions":["..."],"input":"...","steps":["..."],"expected":["..."],"dataChecks":["..."],"errorChecks":["..."],"verify":["browser"]}]}`;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : typeof v === "string" && v.trim() ? [v.trim()] : [];
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** "名称：用途" or {name, purpose} → {name, purpose}. */
function named(v: unknown): { name: string; purpose: string; mode?: unknown }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item) => {
    if (typeof item === "string") {
      const [name, ...rest] = item.split(/[：:]/);
      return name.trim() ? [{ name: name.trim(), purpose: rest.join("：").trim() }] : [];
    }
    if (item && typeof item === "object") {
      const { name, purpose, mode } = item as Record<string, unknown>;
      return text(name) ? [{ name: text(name), purpose: text(purpose), mode }] : [];
    }
    return [];
  });
}

/**
 * The model's draft as a valid spec. Scenario ids stay stable: one the previous
 * spec had (by id, or else by the same name) keeps its id; a new one gets the next
 * free number. Progress and card links of kept scenarios carry over.
 */
export function normalizeSpec(raw: unknown, previous: Spec | null): Spec {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const old = previous?.scenarios ?? [];
  const taken = new Set<string>();
  let next = Math.max(0, ...old.map((s) => Number(s.id.slice(2)))) + 1;
  const scenarios: Scenario[] = [];
  for (const s of Array.isArray(d.scenarios) ? d.scenarios : []) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const name = text(r.name);
    if (!name) continue;
    const prior = old.find((o) => o.id === text(r.id) && !taken.has(o.id)) ?? old.find((o) => o.name === name && !taken.has(o.id));
    let id = prior?.id;
    if (!id) {
      while (taken.has(`S-${String(next).padStart(2, "0")}`) || old.some((o) => o.id === `S-${String(next).padStart(2, "0")}`)) next++;
      id = `S-${String(next++).padStart(2, "0")}`;
    }
    taken.add(id);
    const verify = strings(r.verify).filter((v) => VerifyBy.safeParse(v).success);
    scenarios.push(
      Scenario.parse({
        id,
        name,
        preconditions: strings(r.preconditions),
        input: text(r.input),
        steps: strings(r.steps),
        expected: strings(r.expected),
        dataChecks: strings(r.dataChecks),
        errorChecks: strings(r.errorChecks),
        verify: verify.length ? verify : ["browser"],
        tasks: prior?.tasks ?? [],
        status: prior?.status ?? "unverified",
      }),
    );
  }
  return Spec.parse({
    version: previous?.version ?? 1,
    status: "draft",
    audience: text(d.audience),
    goal: text(d.goal),
    inScope: strings(d.inScope),
    outOfScope: strings(d.outOfScope),
    pages: named(d.pages).map(({ name, purpose }) => ({ name, purpose })),
    flow: strings(d.flow),
    data: text(d.data),
    services: named(d.services).map(({ name, purpose, mode }) => ({ name, purpose, mode: mode === "real" ? "real" : "mock" })),
    scenarios,
  });
}

/** Writes (or rewrites) the requirements spec from the conversation. */
export async function draftSpec(llm: Llm, conversation: ChatMessage[], ctx: ProjectContext, previous: Spec | null): Promise<Spec> {
  if (!conversation.some((m) => m.role === "user")) throw new Error("先说说你想做什么");
  const prompt = specPrompt(conversation, ctx, previous);
  const ask = (p: string) => llm.complete(p, { timeoutMs: 180_000, maxTokens: 8000 });
  let draft = parseJsonObject<Record<string, unknown>>(await ask(prompt));
  if (!draft || !Array.isArray(draft.scenarios)) draft = parseJsonObject<Record<string, unknown>>(await ask(`${prompt}\n\n上一次的回复不是要求的 JSON。这次只输出那个 JSON 对象。`));
  if (!draft) throw new Error("帮手模型两次都没有写出能读懂的需求说明，请再试一次");
  const spec = normalizeSpec(draft, previous);
  if (!spec.scenarios.length) throw new Error("需求说明里没有使用场景，请在对话里多说一点要完成的事，再整理一次");
  return spec;
}

/* ---------- what a change touches ---------- */

export interface SpecImpact {
  /** Nothing the user confirmed changes. */
  none: boolean;
  scenarios: { added: Scenario[]; removed: Scenario[]; changed: Scenario[] };
  /** In-scope items, pages and services added or dropped. */
  scope: { added: string[]; removed: string[] };
  /** Cards linked to a changed or removed scenario; done ones mean finished work may have to change. */
  cards: { id: string; title: string; status: CanvasNode["status"]; scenarios: string[] }[];
}

export function specImpact(confirmed: Spec | null, next: Spec, canvas: Canvas): SpecImpact {
  const before = confirmed?.scenarios ?? [];
  const sig = (s: Scenario) => JSON.stringify({ ...s, status: undefined, tasks: undefined });
  const added = next.scenarios.filter((s) => !before.some((b) => b.id === s.id));
  const removed = before.filter((b) => !next.scenarios.some((s) => s.id === b.id));
  const changed = next.scenarios.filter((s) => before.some((b) => b.id === s.id && sig(b) !== sig(s)));
  const items = (s: Spec | null) => [
    ...(s?.inScope ?? []).map((x) => `做：${x}`),
    ...(s?.pages ?? []).map((p) => `页面：${p.name}`),
    ...(s?.services ?? []).map((v) => `外部服务：${v.name}`),
  ];
  const was = items(confirmed);
  const now = items(next);
  const touched = new Set([...changed, ...removed].map((s) => s.id));
  const cards = canvas.nodes
    .filter((n) => n.scenarios?.some((id) => touched.has(id)))
    .map((n) => ({ id: n.id, title: n.title, status: n.status, scenarios: n.scenarios!.filter((id) => touched.has(id)) }));
  const scope = { added: now.filter((x) => !was.includes(x)), removed: was.filter((x) => !now.includes(x)) };
  return {
    none: !!confirmed && sameScope(confirmed, next),
    scenarios: { added, removed, changed },
    scope,
    cards,
  };
}

/* ---------- the canvas, planned from the confirmed spec ---------- */

export interface SpecPlan {
  canvas: Canvas;
  roles: Capability[];
  stack: string;
  testCommand: string;
  /** Per card of the new canvas: kept, changed or new, and why. */
  changes: { id: string; title: string; change: "keep" | "change" | "new"; reason: string }[];
  /** Cards of the existing canvas that are no longer needed. */
  removed: { id: string; title: string; reason: string }[];
  /** Scenario ids no card covers: the plan is incomplete there. */
  uncovered: string[];
}

export function specPlanPrompt(spec: Spec, existing: Canvas | null, files: string[] = []): string {
  const old = existing?.nodes.length
    ? `\n这个项目已经有代码和画布。尽量保留能用的部分，不要默认重写：
现有卡片：
${existing.nodes.map((n) => `- id=${n.id}，${n.title}，状态 ${n.status}，文件 ${n.files.join(" ") || "无"}：${n.intent.goal || "没写目标"}`).join("\n")}
${files.length ? `现有文件（部分）：\n${files.slice(0, 120).join("\n")}\n` : ""}
每张新卡片写 from（沿用的现有卡片 id，新卡片写 null）、change（"keep" 原样保留、"change" 要修改、"new" 新增）和 reason（一句话说明）。不再需要的现有卡片列在 removed 里，写明原因。\n`
    : "";
  return `你在为一个"本地网页应用"画开发画布。画布上每张卡片是一块可以单独交给 AI 编码 agent 完成的工作，连线表示依赖（A → B 表示 A 可以调用 B）。agent 只能修改自己卡片的文件。

已确认的需求说明：
${JSON.stringify(scopeOf(spec), null, 1)}
${old}
要求：
- 技术栈：没有特别要求时，用 Node.js 内置的 http 模块写本地服务器，页面用原生 HTML、CSS、JavaScript，数据存在本地 JSON 文件，测试用 node:test，不引入框架和数据库。启动命令要简单（如 node server.js），在 Windows 和 macOS 上都能直接运行。
- 4 到 9 张卡片，按"能独立实现、独立测试"来切分。每张：id（小写英文短横线）、kind（module 代码模块 / feature 用户能看到的功能 / flow 流程或集成）、title（中文短名）、goal（一句话）、acceptance（2 到 4 条能用测试验证的验收标准）、tasks（2 到 4 条任务）、files（文件 glob，卡片之间不要重叠）、scenarios（它帮助完成的场景 id）。
- 运行约定（Agent Together 按它启动产品、在应用里预览，写进相关卡片的验收标准）：
${RUN_CONVENTIONS}
- 外部服务（需求里的 services）放在一张"服务接入"卡片里：示例服务和真实服务实现同一个接口，按 AT_SERVICE_MODE 切换，示例逻辑不要散落在页面里。
- 必须有一张 id 为 "integration" 的集成卡片（kind 用 flow），负责把页面、接口和数据接通：服务器入口、路由、页面入口文件归它，scenarios 写全部场景 id。
- 每个场景至少有一张卡片覆盖。
- package.json 这类全项目共用的配置文件，交给没有依赖、最先做的那张卡片。
- roles：按需要提出 0 到 3 个专职角色（id、description、body），小项目可以为空。
- edges：from 依赖 to，label 两三个字。不要有环。
- stack：一句话写技术栈和测试方式。testCommand：在项目根目录运行全部测试的命令。

只输出 JSON：{"stack":"...","testCommand":"...","nodes":[{"id":"...","kind":"module","title":"...","goal":"...","acceptance":["..."],"tasks":["..."],"files":["..."],"scenarios":["S-01"]${existing?.nodes.length ? ',"from":null,"change":"new","reason":"..."' : ""}}],"edges":[{"from":"...","to":"...","label":"..."}]${existing?.nodes.length ? ',"removed":[{"id":"...","reason":"..."}]' : ""}}`;
}

interface PlanDraftNode {
  id?: string;
  title?: string;
  role?: string;
  scenarios?: unknown;
  from?: unknown;
  change?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

/**
 * The model's plan as a canvas. A card the model says it keeps or changes keeps the
 * existing card's id (and, when kept, its progress and evidence), so links,
 * memories and history still point at it.
 */
export function planFromDraft(
  draft: { stack?: string; testCommand?: string; nodes?: PlanDraftNode[]; edges?: Partial<CanvasEdge>[]; roles?: unknown; removed?: unknown } | null,
  spec: Spec,
  existing: Canvas | null,
): SpecPlan {
  if (!draft) throw new Error("帮手模型的回复不是 JSON，请重试");
  const before = new Map((existing?.nodes ?? []).map((n) => [n.id, n]));
  const drafted = (draft.nodes ?? []).filter((d) => text(d.title) || text(d.id));
  const fromOf = (d: PlanDraftNode) => (typeof d.from === "string" && before.has(d.from) ? d.from : null);
  // Reuse the existing id (canvasFromDraft keeps a free, valid id as is), and point the
  // model's edges, written with its own ids, at the reused ones.
  const alias = new Map(drafted.flatMap((d) => (text(d.id) && fromOf(d) ? [[text(d.id), fromOf(d)!] as const] : [])));
  const edges = (draft.edges ?? []).map((e) => ({ ...e, from: e.from && (alias.get(e.from) ?? e.from), to: e.to && (alias.get(e.to) ?? e.to) }));
  const canvas = canvasFromDraft({ nodes: drafted.map((d) => ({ ...d, id: fromOf(d) ?? d.id })) as never, edges });
  const roles = rolesFromDraft(draft.roles);
  const known = new Set(spec.scenarios.map((s) => s.id));
  const changes: SpecPlan["changes"] = [];
  canvas.nodes = canvas.nodes.map((node, i) => {
    const d = drafted[i];
    const from = d ? fromOf(d) : null;
    const old = from ? before.get(from) : undefined;
    const change = old ? (d.change === "keep" ? "keep" : "change") : "new";
    const scenarios = strings(d?.scenarios).filter((id) => known.has(id));
    changes.push({ id: node.id, title: node.title, change, reason: text(d?.reason) });
    const role = roles.some((r) => r.id === d?.role) ? d!.role : undefined;
    // A kept card is the old card with its scenarios; a changed one takes the new intent but keeps its progress.
    const base: CanvasNode = old && change === "keep" ? { ...old, position: node.position } : { ...node, ...(old ? { status: old.status, executor: old.executor } : {}) };
    return { ...base, scenarios, ...(role ? { role } : {}) };
  });
  const integration = canvas.nodes.find((n) => n.id === "integration");
  if (integration) integration.scenarios = [...known];
  const covered = new Set(canvas.nodes.flatMap((n) => n.scenarios ?? []));
  const removed = (Array.isArray(draft.removed) ? draft.removed : []).flatMap((r) => {
    const id = r && typeof r === "object" ? text((r as Record<string, unknown>).id) : "";
    const old = before.get(id);
    return old && !canvas.nodes.some((n) => n.id === id) ? [{ id, title: old.title, reason: text((r as Record<string, unknown>).reason) }] : [];
  });
  // Existing cards the model neither kept nor removed are dropped too: say so rather than lose them silently.
  for (const old of before.values()) {
    if (!canvas.nodes.some((n) => n.id === old.id) && !removed.some((r) => r.id === old.id)) removed.push({ id: old.id, title: old.title, reason: "新方案里没有它" });
  }
  return {
    canvas: Canvas.parse(canvas),
    roles,
    stack: text(draft.stack),
    testCommand: text(draft.testCommand),
    changes,
    removed,
    uncovered: spec.scenarios.map((s) => s.id).filter((id) => !covered.has(id)),
  };
}

/** Plans the canvas from a confirmed spec; with an existing canvas, a migration plan to review before anything changes. */
export async function planFromSpec(llm: Llm, spec: Spec, existing: Canvas | null, files: string[] = []): Promise<SpecPlan> {
  if (spec.status !== "confirmed") throw new Error("先确认需求说明，再生成画布");
  const prompt = specPlanPrompt(spec, existing, files);
  const ask = (p: string) => llm.complete(p, { timeoutMs: 240_000, maxTokens: 10000 });
  let draft = parseJsonObject<Parameters<typeof planFromDraft>[0] & object>(await ask(prompt));
  if (!draft?.nodes?.length) draft = parseJsonObject(await ask(`${prompt}\n\n上一次的回复不是要求的 JSON。这次只输出那个 JSON 对象。`));
  return planFromDraft(draft, spec, existing);
}

/** The spec with each scenario's tasks set to the cards that cover it on this canvas. */
export function linkScenarios(spec: Spec, canvas: Canvas): Spec {
  return Spec.parse({
    ...spec,
    scenarios: spec.scenarios.map((s) => ({ ...s, tasks: canvas.nodes.filter((n) => n.scenarios?.includes(s.id)).map((n) => n.id) })),
  });
}

/** Copies the canvas folder aside before a migration replaces it; returns where it went. */
export function backupCanvas(root: string): string | null {
  const from = path.join(root, ".agent-together", "canvas");
  if (!fs.existsSync(from)) return null;
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  const to = path.join(root, ".agent-together", "canvas-backups", stamp);
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
  return to;
}
