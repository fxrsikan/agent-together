import { useEffect, useRef, useState } from "react";
import type { Capability, Canvas } from "@agent-together/schema";
import type { Scenario, Spec, SpecState } from "../../preload";
import { errorText } from "./errors";

/**
 * 需求与反馈 (phase one, M1): talk with the product manager, get a requirements spec
 * with usage scenarios, edit and confirm it, then plan the canvas from it. For a
 * project that already has cards, the canvas change is shown as a plan to adopt.
 */

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const joined = (list: string[]) => list.join("\n");
const VERIFY: { id: Scenario["verify"][number]; label: string }[] = [
  { id: "browser", label: "在浏览器里操作" },
  { id: "api", label: "检查接口" },
  { id: "file", label: "检查导出的文件" },
];
const SCENARIO_STATUS: Record<Scenario["status"], string> = {
  unverified: "未验证",
  "mock-passed": "示例服务下通过",
  "real-passed": "真实服务下通过",
  failed: "失败",
};
const CHANGE: Record<string, string> = { keep: "保留", change: "修改", new: "新增" };

/** A list edited as one line per item, kept as text while typing so blank lines survive. */
function LinesField({ label, value, onChange, rows = 3, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; rows?: number; hint?: string }) {
  const [text, setText] = useState(joined(value));
  useEffect(() => {
    if (joined(lines(text)) !== joined(value)) setText(joined(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={rows} value={text} placeholder={hint ?? "每行一条"} onChange={(e) => (setText(e.target.value), onChange(lines(e.target.value)))} />
    </label>
  );
}

function ScenarioEditor({ s, titles, onChange, onRemove }: { s: Scenario; titles: Record<string, string>; onChange: (s: Scenario) => void; onRemove: () => void }) {
  const set = (patch: Partial<Scenario>) => onChange({ ...s, ...patch });
  return (
    <div className="scenario">
      <div className="row">
        <span className="badge">{s.id}</span>
        <input className="grow" value={s.name} onChange={(e) => set({ name: e.target.value })} aria-label="场景名称" />
        <button className="link" onClick={onRemove} title="去掉这个场景">
          去掉
        </button>
      </div>
      <p className="muted small">
        {SCENARIO_STATUS[s.status]}
        {s.tasks.length ? ` · 由 ${s.tasks.map((t) => titles[t] ?? t).join("、")} 完成` : ""}
      </p>
      <LinesField label="前置条件（写明用示例服务还是真实服务）" value={s.preconditions} onChange={(v) => set({ preconditions: v })} rows={2} />
      <label className="field">
        <span>测试样例（预期结果针对它来写）</span>
        <textarea rows={3} value={s.input} onChange={(e) => set({ input: e.target.value })} />
      </label>
      <LinesField label="操作步骤" value={s.steps} onChange={(v) => set({ steps: v })} rows={4} />
      <LinesField label="预期结果" value={s.expected} onChange={(v) => set({ expected: v })} rows={3} />
      <LinesField label="数据检查（保存、刷新、重启后）" value={s.dataChecks} onChange={(v) => set({ dataChecks: v })} rows={2} />
      <LinesField label="出错时" value={s.errorChecks} onChange={(v) => set({ errorChecks: v })} rows={2} />
      <div className="row wrap small">
        <span className="muted">怎么验证：</span>
        {VERIFY.map((v) => (
          <label key={v.id} className="check">
            <input
              type="checkbox"
              checked={s.verify.includes(v.id)}
              onChange={() => set({ verify: s.verify.includes(v.id) ? s.verify.filter((x) => x !== v.id) : [...s.verify, v.id] })}
            />
            {v.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function RequirementsPanel({
  version,
  canvas,
  onChange,
  onRoles,
  onClose,
}: {
  version: number;
  canvas: Canvas | null;
  onChange: (notice: string) => void;
  /** Roles a new plan proposed: drafts for the user to review. */
  onRoles: (roles: Capability[], canvas: Canvas) => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<SpecState | null>(null);
  const [tab, setTab] = useState<"chat" | "spec">("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Spec | null>(null);
  const [dirty, setDirty] = useState(false);
  /** The user asked to confirm a change; the impact is on screen, waiting for a second click. */
  const [reviewing, setReviewing] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const take = (next: SpecState) => {
    setSt(next);
    if (!dirty) setEdit(next.spec);
  };
  useEffect(() => {
    window.agentTogether.specState().then((next) => {
      setSt(next);
      setEdit((e) => (dirty ? e : next.spec));
      if (next.spec && !next.conversation.length) setTab("spec");
    });
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (st && !st.conversation.length && !input) window.agentTogether.projectInfo().then((p) => p.description && setInput(p.description));
  }, [st?.conversation.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Braces matter: scrollIntoView returns a Promise in recent Chromium, and an effect must not return one.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [st?.conversation.length, tab]);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };
  if (!st) return null;

  const titles = Object.fromEntries((canvas?.nodes ?? []).map((n) => [n.id, n.title]));
  const spec = edit;
  const last = st.conversation[st.conversation.length - 1];
  const unanswered = last?.role === "user";
  const ready = last?.role === "assistant" && last.ready;
  const status = !st.spec ? "还没有需求说明" : st.spec.status === "confirmed" && !dirty ? `已确认 · 第 ${st.spec.version} 版` : st.confirmed ? "有改动，待确认" : "草稿，待确认";

  const say = (text?: string) =>
    act("thinking", async () => {
      const next = await window.agentTogether.specSay(text);
      setInput("");
      take(next);
    });
  const draft = () =>
    act("drafting", async () => {
      const next = await window.agentTogether.specDraft();
      setDirty(false);
      setSt(next);
      setEdit(next.spec);
      setTab("spec");
      onChange(`需求说明已整理好：${next.spec?.scenarios.length ?? 0} 个使用场景。逐条看一下，改好后点"确认"。`);
    });
  const update = (patch: Partial<Spec>) => {
    if (!spec) return;
    setEdit({ ...spec, ...patch });
    setDirty(true);
    setReviewing(false);
  };
  const save = () =>
    act("saving", async () => {
      const next = await window.agentTogether.specSave(spec!);
      setDirty(false);
      setSt(next);
      setEdit(next.spec);
    });
  const confirm = () =>
    act("confirming", async () => {
      // A change to a confirmed spec: save it, show what it touches, confirm on the second click.
      if (st.confirmed && !reviewing) {
        const next = await window.agentTogether.specSave(spec!);
        setDirty(false);
        setSt(next);
        setEdit(next.spec);
        if (next.impact && !next.impact.none) {
          setReviewing(true);
          return;
        }
      }
      const next = await window.agentTogether.specConfirm(spec!);
      setDirty(false);
      setReviewing(false);
      setSt(next);
      setEdit(next.spec);
      onChange(st.confirmed ? "已确认修改，改动记进了决定记录" : `已确认第 ${next.spec?.version ?? 1} 版的范围。下一步：按需求生成画布。`);
    });
  const plan = () =>
    act("planning", async () => {
      const { plan: p, applied, backup } = await window.agentTogether.specPlan();
      setSt(await window.agentTogether.specState());
      if (applied) {
        if (p.roles.length) onRoles(p.roles, p.canvas);
        onChange(`按需求画好了 ${p.canvas.nodes.length} 张卡片（${p.stack}）${p.uncovered.length ? `；${p.uncovered.join("、")} 还没有卡片负责` : ""}${backup ? `，原画布备份在 ${backup}` : ""}`);
      }
    });
  const adopt = () =>
    act("adopting", async () => {
      const { backup } = await window.agentTogether.specApplyPlan();
      setSt(await window.agentTogether.specState());
      onChange(`画布已按需求调整${backup ? `，原画布备份在 ${backup}，调整前也存了检查点` : ""}`);
    });

  const impact = st.impact;
  const confirmedNow = st.spec?.status === "confirmed" && !dirty;

  return (
    <aside className="req">
      <div className="row req-head">
        <h3 className="grow">需求与反馈</h3>
        <span className={`badge ${confirmedNow ? "badge-good" : st.spec ? "badge-warn" : ""}`}>{status}</span>
        <button className="link" onClick={onClose} title="收起">
          ×
        </button>
      </div>
      <div className="tabs">
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          对话
        </button>
        <button className={tab === "spec" ? "on" : ""} onClick={() => setTab("spec")}>
          需求说明{st.spec ? `（${st.spec.scenarios.length} 个场景）` : ""}
        </button>
      </div>
      {!st.hasLlm && <p className="finding finding-warn">还没有帮手模型，对话和整理需求要用它。在右边「帮手模型」里选一个。</p>}
      {error && <p className="finding finding-block">{error}</p>}

      {tab === "chat" && (
        <div className="req-body">
          {!st.conversation.length && (
            <p className="muted">
              说说你想做什么：给谁用、要完成什么事、做到什么样算好。AI 会像产品经理一样追问，一次最多三个问题，问清楚后帮你整理成需求说明。
              {st.cards ? " 这个项目已经有卡片，AI 会参考现有的部分。" : ""}
            </p>
          )}
          <div className="chat">
            {st.conversation.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                <p>{m.text}</p>
                {m.questions?.map((q) => (
                  <div key={q.id} className="question">
                    <strong>{q.question}</strong>
                    {q.why && <span className="muted small"> {q.why}</span>}
                    {i === st.conversation.length - 1 && (
                      <div className="row wrap">
                        {q.options.map((o, k) => (
                          <button key={k} className={k === 0 ? "primary small" : "small"} title={k === 0 ? "推荐" : undefined} onClick={() => setInput((t) => `${t ? `${t}\n` : ""}${q.question} ${o}`)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {busy === "thinking" && <div className="bubble assistant muted">正在想…</div>}
            <div ref={end} />
          </div>
          {unanswered && !busy && (
            <button onClick={() => say()} title="上一次没有回复，再问一次">
              再问一次
            </button>
          )}
          <textarea
            rows={4}
            value={input}
            placeholder={st.conversation.length ? "回答问题，或补充你的想法（点上面的答案会填到这里）" : "例如：我想把自己写的小说变成短剧分镜，能编辑、保存，最后导出成表格。"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && input.trim()) say(input);
            }}
          />
          <div className="actions">
            <button className="primary" disabled={!!busy || !input.trim() || !st.hasLlm} onClick={() => say(input)}>
              {busy === "thinking" ? "AI 正在想…" : "发送"}
            </button>
            <button
              className={ready ? "primary" : ""}
              disabled={!!busy || !st.conversation.some((m) => m.role === "user") || !st.hasLlm}
              onClick={draft}
              title="根据对话写出需求说明：范围、页面、使用场景"
            >
              {busy === "drafting" ? "正在整理…（约一分钟）" : st.spec ? "按对话重新整理需求说明" : "整理成需求说明"}
            </button>
          </div>
        </div>
      )}

      {tab === "spec" && (
        <div className="req-body">
          {!spec && <p className="muted">还没有需求说明。先在"对话"里说说你想做什么，再点"整理成需求说明"。</p>}
          {spec && (
            <>
              <label className="field">
                <span>给谁用</span>
                <input value={spec.audience} onChange={(e) => update({ audience: e.target.value })} />
              </label>
              <label className="field">
                <span>主要要完成什么事</span>
                <textarea rows={2} value={spec.goal} onChange={(e) => update({ goal: e.target.value })} />
              </label>
              <LinesField label="第一版做" value={spec.inScope} onChange={(v) => update({ inScope: v })} />
              <LinesField label="第一版不做（留到以后）" value={spec.outOfScope} onChange={(v) => update({ outOfScope: v })} />
              <LinesField
                label="页面（每行：名称：用途）"
                value={spec.pages.map((p) => (p.purpose ? `${p.name}：${p.purpose}` : p.name))}
                onChange={(v) => update({ pages: v.map((l) => ({ name: l.split(/[：:]/)[0].trim(), purpose: l.split(/[：:]/).slice(1).join("：").trim() })).filter((p) => p.name) })}
              />
              <LinesField label="页面之间怎么走" value={spec.flow} onChange={(v) => update({ flow: v })} />
              <label className="field">
                <span>数据怎么保存</span>
                <input value={spec.data} onChange={(e) => update({ data: e.target.value })} />
              </label>
              <LinesField
                label="外部服务（每行：名称：用途；第一版先用示例服务）"
                value={spec.services.map((v) => (v.purpose ? `${v.name}：${v.purpose}` : v.name))}
                onChange={(v) =>
                  update({
                    services: v
                      .map((l) => ({ name: l.split(/[：:]/)[0].trim(), purpose: l.split(/[：:]/).slice(1).join("：").trim(), mode: spec.services.find((x) => x.name === l.split(/[：:]/)[0].trim())?.mode ?? ("mock" as const) }))
                      .filter((x) => x.name),
                  })
                }
                rows={2}
              />

              <h4>使用场景</h4>
              <p className="muted small">场景是"第一版做完"的标准：每个场景照着步骤做一遍，结果对得上才算完成。编号不会变，卡片和验收记录都引用它。</p>
              {spec.scenarios.map((s, i) => (
                <ScenarioEditor
                  key={s.id}
                  s={s}
                  titles={titles}
                  onChange={(next) => update({ scenarios: spec.scenarios.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => update({ scenarios: spec.scenarios.filter((_, j) => j !== i) })}
                />
              ))}
              <button
                className="small"
                onClick={() => {
                  const n = Math.max(0, ...[...spec.scenarios, ...(st.confirmed?.scenarios ?? [])].map((s) => Number(s.id.slice(2)))) + 1;
                  update({
                    scenarios: [
                      ...spec.scenarios,
                      { id: `S-${String(n).padStart(2, "0")}`, name: "新场景", preconditions: [], input: "", steps: [], expected: [], dataChecks: [], errorChecks: [], verify: ["browser"], tasks: [], status: "unverified" },
                    ],
                  });
                }}
              >
                ＋ 加一个场景
              </button>

              {reviewing && impact && !impact.none && (
                <div className="finding finding-warn">
                  <strong>这次修改会影响：</strong>
                  <ul>
                    {impact.scenarios.added.map((s) => (
                      <li key={`a${s.id}`}>新增场景 {s.id} {s.name}</li>
                    ))}
                    {impact.scenarios.changed.map((s) => (
                      <li key={`c${s.id}`}>修改场景 {s.id} {s.name}</li>
                    ))}
                    {impact.scenarios.removed.map((s) => (
                      <li key={`r${s.id}`}>去掉场景 {s.id} {s.name}</li>
                    ))}
                    {impact.scope.added.map((x) => (
                      <li key={`+${x}`}>新增 {x}</li>
                    ))}
                    {impact.scope.removed.map((x) => (
                      <li key={`-${x}`}>去掉 {x}</li>
                    ))}
                    {impact.cards.map((c) => (
                      <li key={c.id}>
                        卡片「{c.title}」{c.status === "done" ? "（已完成，做好的部分可能要改）" : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="small">确认后会记进决定记录。之后可以按需求调整画布。</p>
                </div>
              )}

              <div className="actions sticky">
                {dirty && (
                  <button disabled={!!busy} onClick={save}>
                    保存草稿
                  </button>
                )}
                {(!confirmedNow || dirty) && (
                  <button className="primary" disabled={!!busy || !spec.scenarios.length} onClick={confirm}>
                    {busy === "confirming" ? "确认中…" : reviewing ? "确认这些改动" : st.confirmed ? "确认修改" : `确认第 ${spec.version} 版`}
                  </button>
                )}
                {confirmedNow && !st.pendingPlan && (
                  <button className="primary" disabled={!!busy || !st.hasLlm} onClick={plan} title="按已确认的需求，画出开发卡片；每张卡片关联它负责的场景">
                    {busy === "planning" ? "正在规划…（一两分钟）" : st.cards ? "按需求调整画布" : "按需求生成画布"}
                  </button>
                )}
              </div>
            </>
          )}

          {st.pendingPlan && (
            <div className="proposal">
              <h4>画布调整方案</h4>
              <p className="muted small">
                不会重写能用的部分：保留的卡片原样留着（进度和出处都在），修改的卡片换成新的目标，去掉的卡片列在下面。采用前会备份原画布，并存一个检查点。
              </p>
              <ul className="plan-changes">
                {st.pendingPlan.changes.map((c) => (
                  <li key={c.id}>
                    <span className={`badge ${c.change === "new" ? "badge-good" : c.change === "change" ? "badge-warn" : ""}`}>{CHANGE[c.change]}</span> {c.title}
                    {c.reason && <span className="muted small"> · {c.reason}</span>}
                  </li>
                ))}
                {st.pendingPlan.removed.map((r) => (
                  <li key={r.id}>
                    <span className="badge badge-bad">去掉</span> {r.title}
                    {r.reason && <span className="muted small"> · {r.reason}</span>}
                  </li>
                ))}
              </ul>
              {st.pendingPlan.uncovered.length > 0 && <p className="finding finding-warn">这些场景还没有卡片负责：{st.pendingPlan.uncovered.join("、")}</p>}
              <div className="actions">
                <button className="primary" disabled={!!busy} onClick={adopt}>
                  {busy === "adopting" ? "调整中…" : "采用这个方案"}
                </button>
                <button disabled={!!busy} onClick={() => act("discard", async () => (await window.agentTogether.specDiscardPlan(), setSt(await window.agentTogether.specState())))}>
                  不要
                </button>
              </div>
            </div>
          )}

          {st.decisions.length > 0 && (
            <details className="decisions">
              <summary>决定记录（{st.decisions.length}）</summary>
              <ul>
                {st.decisions.map((d) => (
                  <li key={d.id} className="small">
                    <span className="muted">{new Date(d.at).toLocaleString("zh-CN")}</span> {d.summary}
                    {d.detail && <div className="muted pre">{d.detail}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </aside>
  );
}
