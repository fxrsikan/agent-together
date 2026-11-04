import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge } from "@xyflow/react";
import { strongest, type Canvas, type Level, type AgentEvent } from "@agent-together/schema";
import type { CompileReport } from "@agent-together/core";
import type { EventRecord, Judgment } from "../../preload";
import { CheckpointsPanel } from "./CheckpointsPanel";
import { ContextInspector } from "./ContextInspector";
import { MemoryPanel } from "./MemoryPanel";
import { RacePanel } from "./RacePanel";
import { NodeCard, type NodeCardType } from "./NodeCard";

const nodeTypes = { card: NodeCard };
const FEED_LIMIT = 100;

function describe(event: AgentEvent): string {
  if (event.kind === "turn.end") return "一轮结束";
  const a = event.action;
  const what = a.type === "write" ? `写 ${a.path}` : a.type === "read" ? `读 ${a.path}` : a.type === "shell" ? `$ ${a.command}` : a.tool;
  if (event.kind === "tool.after") return `${event.ok ? "完成" : "失败"} ${what}`;
  return what;
}

export function App() {
  const [info, setInfo] = useState<{ root: string; port: number; hasGit: boolean; l2: string | null } | null>(null);
  const [judgments, setJudgments] = useState<Judgment[]>([]);
  const [version, setVersion] = useState(0); // bumped when files may have changed under us
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feed, setFeed] = useState<EventRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState<"claude-code" | "codex">("claude-code");
  const [inspecting, setInspecting] = useState(false);
  const [contextText, setContextText] = useState("");
  // With the inspector open, its text (possibly edited) is what gets handed out.
  const context = inspecting ? contextText : undefined;

  useEffect(() => {
    window.agentTogether.info().then((i) => {
      setInfo(i);
      setActiveId(i.activeNodeId);
    });
    const offEvent = window.agentTogether.onEvent((r) => {
      setFeed((f) => [r, ...f].slice(0, FEED_LIMIT));
      // An agent turn may have changed files or checkpoints: refresh what depends on them.
      if (r.event.kind === "turn.end") setVersion((v) => v + 1);
    });
    const offActive = window.agentTogether.onActive(setActiveId);
    const offDrafts = window.agentTogether.onMemoryDrafts((drafts) => {
      setNotice(`有 ${drafts.length} 条记忆草稿待审批，点开对应节点查看`);
      setVersion((v) => v + 1);
    });
    const offJudgment = window.agentTogether.onJudgment((j) => setJudgments((js) => [j, ...js].slice(0, FEED_LIMIT)));
    const offL2Error = window.agentTogether.onL2Error((e) => setNotice(`L2 判断没能运行：${e}`));
    return () => {
      offEvent();
      offActive();
      offDrafts();
      offJudgment();
      offL2Error();
    };
  }, []);

  useEffect(() => {
    window.agentTogether.canvas().then(setCanvas);
  }, [version]);

  const changed = (message: string) => {
    setNotice(message);
    setVersion((v) => v + 1);
  };

  // A node's light shows the strongest finding about it in the recent feed; an L2 "off track" counts as warn.
  const signals = useMemo(() => {
    const byNode = new Map<string, Level>();
    const raise = (nodeId: string, level: Level) =>
      byNode.set(nodeId, strongest([{ rule: "", message: "", level }, { rule: "", message: "", level: byNode.get(nodeId) ?? "off" }]));
    for (const { verdict } of feed) for (const f of verdict.findings) if (f.nodeId) raise(f.nodeId, f.level);
    for (const j of judgments) if (!j.onTrack) raise(j.nodeId, "warn");
    return byNode;
  }, [feed, judgments]);

  const nodes: NodeCardType[] = useMemo(
    () =>
      (canvas?.nodes ?? []).map((node, i) => ({
        id: node.id,
        type: "card",
        position: node.position ?? { x: i * 300, y: 0 },
        data: { node, active: node.id === activeId, signal: signals.get(node.id) ?? "off" },
      })),
    [canvas, activeId, signals],
  );

  const edges: Edge[] = useMemo(
    () =>
      (canvas?.edges ?? []).map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        label: e.label,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [canvas],
  );

  const selected = canvas?.nodes.find((n) => n.id === selectedId) ?? null;

  const install = async () =>
    setNotice(`已写入 ${(await window.agentTogether.installHooks()).join("、")}。Codex 需要在项目里运行 codex 并用 /hooks 信任后才生效；Cursor 需要信任该工作区。`);

  const describeReport = (r: CompileReport) =>
    r.errors.length
      ? `${r.id} 未编译：${r.errors.join("；")}`
      : r.kind === "observer"
        ? `${r.id} → 由 Agent Together 观察者对所有 agent 执行`
        : `${r.id} → ${Object.values(r.written).flat().join("、")}` +
        (r.warnings.length ? `（提醒：${r.warnings.join("；")}）` : "");

  const exportCapability = async (nodeId: string) =>
    setNotice(`已保存为能力单元并编译：${describeReport(await window.agentTogether.exportCapability(nodeId))}`);

  const compileAll = async () => {
    const reports = await window.agentTogether.compileCapabilities();
    setNotice(reports.length ? reports.map(describeReport).join(" · ") : "还没有能力单元（.agent-together/capabilities/ 为空）");
  };

  const dispatch = async (nodeId: string) => {
    try {
      const file = await window.agentTogether.dispatch(nodeId, task, agent, context);
      changed(`已存检查点并在新窗口启动 ${agent === "codex" ? "Codex" : "Claude Code"}，上下文：${file}`);
      setTask("");
    } catch (err) {
      setNotice(`派发失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="app">
      <header className="bar">
        <strong>Agent Together</strong>
        <span className="muted">{info ? `${info.root} · 守护进程 127.0.0.1:${info.port}` : "启动中…"}</span>
        <span className="spacer" />
        <span className="muted">L2：{info ? info.l2 ?? "关闭" : "…"}</span>
        <span className="muted">当前节点：{canvas?.nodes.find((n) => n.id === activeId)?.title ?? "无"}</span>
        <button onClick={compileAll}>编译能力</button>
        <button onClick={install}>安装 hooks</button>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <main className="body">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="side">
          {selected ? (
            <section>
              <h3>{selected.title}</h3>
              <p>{selected.intent.goal || "未写目标"}</p>
              {selected.intent.acceptance.length > 0 && (
                <>
                  <h4>验收标准</h4>
                  <ul>{selected.intent.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
                </>
              )}
              {selected.intent.tasks.length > 0 && (
                <>
                  <h4>任务</h4>
                  <ul>{selected.intent.tasks.map((t) => <li key={t}>{t}</li>)}</ul>
                </>
              )}
              <h4>派发任务</h4>
              <textarea
                className="task"
                rows={3}
                placeholder="这次要做什么（留空则按任务清单推进）"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
              <div className="actions">
                <select value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)}>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <button className="primary" onClick={() => dispatch(selected.id)}>
                  派发
                </button>
                {selected.id === activeId ? (
                  <button onClick={() => window.agentTogether.setActive(null)}>取消当前节点</button>
                ) : (
                  <button onClick={() => window.agentTogether.setActive(selected.id)}>设为当前节点</button>
                )}
                <button onClick={() => exportCapability(selected.id)}>导出为能力单元</button>
                <button onClick={() => setInspecting((v) => !v)}>{inspecting ? "收起上下文" : "检查上下文"}</button>
              </div>
              {inspecting && <ContextInspector nodeId={selected.id} task={task} version={version} onContext={setContextText} />}
              {info?.hasGit && <RacePanel nodeId={selected.id} task={task} context={context} version={version} onChange={changed} />}
              <MemoryPanel nodeId={selected.id} version={version} onChange={changed} />
            </section>
          ) : (
            <>
              <p className="muted">点击节点查看意图；设为当前节点后，观察者按它的范围检查 agent。</p>
              <MemoryPanel nodeId={null} version={version} onChange={changed} />
            </>
          )}
          {info?.hasGit ? (
            <CheckpointsPanel version={version} onChange={changed} />
          ) : (
            <p className="muted">项目不在 git 仓库中，检查点不可用。</p>
          )}
          {judgments.length > 0 && (
            <>
              <h4>L2 定向判断</h4>
              <ol className="feed">
                {judgments.slice(0, 5).map((j) => (
                  <li key={j.at + j.nodeId}>
                    <span className="muted">{j.at.slice(11, 19)}</span>{" "}
                    <span className={j.onTrack ? "" : "finding-warn"}>{j.onTrack ? "没有偏离" : "可能偏离"}</span>
                    ：{j.reason}
                  </li>
                ))}
              </ol>
            </>
          )}
          <h4>观察者事件</h4>
          {feed.length === 0 && <p className="muted">暂无事件。安装 hooks 后在本项目里运行 Claude Code。</p>}
          <ol className="feed">
            {feed.map(({ event, verdict }, i) => (
              <li key={feed.length - i}>
                <div className="feed-line">
                  <span className="muted">{event.at.slice(11, 19)}</span> {describe(event)}
                </div>
                {verdict.findings.map((f) => (
                  <div key={f.rule} className={`finding finding-${f.level}`}>
                    [{f.level}] {f.message}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  );
}
