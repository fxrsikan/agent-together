import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { strongest, type AgentEvent, type Canvas, type Level } from "@agent-together/schema";
import type { CompileReport } from "@agent-together/core";
import type { Agent, EventRecord, Judgment, SessionInfo, TestHistory } from "../../preload";
import { AgentRun, TestBadge, type RunView } from "./AgentRun";
import { CheckpointsPanel } from "./CheckpointsPanel";
import { ContextInspector } from "./ContextInspector";
import { MemoryPanel } from "./MemoryPanel";
import { NodeCard, type NodeCardType } from "./NodeCard";
import { NodeEditor } from "./NodeEditor";
import { ProjectSettings } from "./ProjectSettings";
import { RacePanel } from "./RacePanel";

const nodeTypes = { card: NodeCard };
const FEED_LIMIT = 100;
const AGENT_NAMES: Record<Agent, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };

function describe(event: AgentEvent): string {
  if (event.kind === "turn.end") return "一轮结束";
  const a = event.action;
  const what = a.type === "write" ? `写 ${a.path}` : a.type === "read" ? `读 ${a.path}` : a.type === "shell" ? `$ ${a.command}` : a.tool;
  if (event.kind === "tool.after") return `${event.ok ? "完成" : "失败"} ${what}`;
  return what;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** An empty canvas: plan it from the product description with AI, or start drawing by hand. */
function EmptyCanvas({ onAdd, onChange }: { onAdd: () => void; onChange: (notice: string) => void }) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    window.agentTogether.projectInfo().then((p) => setDescription(p.description ?? ""));
  }, []);

  const plan = async () => {
    setBusy(true);
    setError("");
    try {
      const { canvas, stack } = await window.agentTogether.planCanvas(description);
      onChange(`AI 规划了 ${canvas.nodes.length} 个节点（${stack}）。逐个检查目标、验收标准和文件范围，改好再派发。`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="empty-canvas">
      <h3>画布是空的</h3>
      <p className="muted">描述这个产品，让 AI 拆成节点、目标、验收标准和依赖；生成后可以随意修改。</p>
      <textarea
        className="task"
        rows={6}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="例如：一个命令行待办清单，可以添加、完成、删除、列出待办，数据存在本地 JSON 文件里。"
      />
      {error && <div className="finding finding-block">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={busy || !description.trim()} onClick={plan}>
          {busy ? "生成中…（约半分钟）" : "AI 生成画布"}
        </button>
        <button onClick={onAdd} disabled={busy}>
          手动添加节点
        </button>
      </div>
    </div>
  );
}

/** One open project: the editable canvas on the left, the selected node and the observers on the right. */
export function Workspace({ info, onClose }: { info: SessionInfo; onClose: () => void }) {
  const [judgments, setJudgments] = useState<Judgment[]>([]);
  const [version, setVersion] = useState(0); // bumped when files may have changed under us
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [flowNodes, setFlowNodes] = useState<NodeCardType[]>([]);
  const [activeId, setActiveId] = useState<string | null>(info.activeNodeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feed, setFeed] = useState<EventRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState<Agent>("claude-code");
  const [mode, setMode] = useState<"app" | "terminal">("app");
  const [runView, setRunView] = useState<RunView | null>(null);
  const [testRuns, setTestRuns] = useState<TestHistory>({ byNode: {} });
  const [testing, setTesting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [contextText, setContextText] = useState("");
  const flow = useRef<ReactFlowInstance<NodeCardType, Edge> | null>(null);
  // With the inspector open, its text (possibly edited) is what gets handed out.
  const context = inspecting ? contextText : undefined;

  useEffect(() => {
    const offs = [
      window.agentTogether.onEvent((r) => {
        setFeed((f) => [r, ...f].slice(0, FEED_LIMIT));
        // An agent turn may have changed files or checkpoints: refresh what depends on them.
        if (r.event.kind === "turn.end") setVersion((v) => v + 1);
      }),
      window.agentTogether.onActive(setActiveId),
      window.agentTogether.onMemoryDrafts((drafts) => {
        setNotice(`有 ${drafts.length} 条记忆草稿待审批，点开对应节点查看`);
        setVersion((v) => v + 1);
      }),
      window.agentTogether.onJudgment((j) => setJudgments((js) => [j, ...js].slice(0, FEED_LIMIT))),
      window.agentTogether.onL2Error((e) => setNotice(`L2 判断没能运行：${e}`)),
      window.agentTogether.onCanvasChanged(() => setVersion((v) => v + 1)),
      window.agentTogether.onAgentText(({ text }) => setRunView((r) => (r ? { ...r, lines: [...r.lines, text].slice(-200) } : r))),
      window.agentTogether.onAgentStatus(({ state }) => setRunView((r) => (r && state !== "idle" ? { ...r, state } : r))),
      window.agentTogether.onTests(() => setVersion((v) => v + 1)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    window.agentTogether.canvas().then(setCanvas);
    window.agentTogether.testHistory().then(setTestRuns);
  }, [version]);

  const changed = (text: string) => {
    setNotice(text);
    setVersion((v) => v + 1);
  };
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      setNotice(message(err));
    }
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

  // React Flow owns positions while dragging; the canvas on disk is the source of everything else.
  useEffect(() => {
    setFlowNodes(
      (canvas?.nodes ?? []).map((node, i) => ({
        id: node.id,
        type: "card",
        position: node.position ?? { x: (i % 4) * 300, y: Math.floor(i / 4) * 180 },
        selected: node.id === selectedId,
        data: { node, active: node.id === activeId, signal: signals.get(node.id) ?? "off", tests: testRuns.byNode[node.id] },
      })),
    );
  }, [canvas, activeId, signals, selectedId, testRuns]);

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

  const addNode = () =>
    attempt(async () => {
      const box = document.querySelector(".canvas")?.getBoundingClientRect();
      const center = box && flow.current ? flow.current.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
      const node = await window.agentTogether.addNode("新节点", "module", { x: Math.round(center.x - 110), y: Math.round(center.y - 50) });
      setSelectedId(node.id);
      changed("已添加节点：在右边填写名字、目标、验收标准和它拥有的文件；从节点右侧的圆点拖到另一个节点，表示它依赖那个节点。");
    });

  const connect = (c: Connection) =>
    attempt(async () => {
      if (!canvas || !c.source || !c.target) return;
      await window.agentTogether.saveEdges([...canvas.edges, { from: c.source, to: c.target }]);
    });

  const deleteEdges = (gone: Edge[]) =>
    attempt(async () => {
      if (!canvas) return;
      const ids = new Set(gone.map((e) => e.id));
      await window.agentTogether.saveEdges(canvas.edges.filter((e) => !ids.has(`${e.from}->${e.to}`)));
      setNotice(`已删除 ${gone.length} 条连线`);
    });

  const install = async () =>
    setNotice(`已写入 ${(await window.agentTogether.installHooks()).join("、")}。Codex 需要在项目里运行 codex 并用 /hooks 信任后才生效；Cursor 需要信任该工作区。`);

  const describeReport = (r: CompileReport) =>
    r.errors.length
      ? `${r.id} 未编译：${r.errors.join("；")}`
      : r.kind === "observer"
        ? `${r.id} → 由 Agent Together 观察者对所有 agent 执行`
        : `${r.id} → ${Object.values(r.written).flat().join("、")}` + (r.warnings.length ? `（提醒：${r.warnings.join("；")}）` : "");

  const exportCapability = async (nodeId: string) =>
    setNotice(`已保存为能力单元并编译：${describeReport(await window.agentTogether.exportCapability(nodeId))}`);

  const compileAll = async () => {
    const reports = await window.agentTogether.compileCapabilities();
    setNotice(reports.length ? reports.map(describeReport).join(" · ") : "还没有能力单元（.agent-together/capabilities/ 为空）");
  };

  const dispatch = (nodeId: string, taskText = task) =>
    attempt(async () => {
      if (mode === "terminal") {
        const file = await window.agentTogether.dispatch(nodeId, taskText, agent, context);
        changed(`已存检查点并在新窗口启动 ${AGENT_NAMES[agent]}，上下文：${file}`);
        setTask("");
        return;
      }
      setRunView({ nodeId, agent: AGENT_NAMES[agent], state: "running", lines: [] });
      setTask("");
      try {
        const outcome = await window.agentTogether.runAgent(nodeId, taskText, agent, context);
        // CLIs that do not stream (Grok Build) still show their summary.
        setRunView((r) => {
          const lines = r?.lines.length ? r.lines : [outcome.run.summary];
          return { nodeId, agent: AGENT_NAMES[agent], state: "done", outcome, lines };
        });
        setVersion((v) => v + 1);
      } catch (err) {
        setRunView((r) => (r ? { ...r, state: "done", error: message(err) } : r));
      }
    });

  const markDone = (nodeId: string) =>
    attempt(async () => {
      const node = canvas?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      await window.agentTogether.saveNode({ ...node, status: "done" });
      if (activeId === nodeId) await window.agentTogether.setActive(null);
      setRunView(null);
      changed(`"${node.title}"已完成`);
    });

  const runTests = () =>
    attempt(async () => {
      setTesting(true);
      try {
        const { tests, checkpoint } = await window.agentTogether.runTests(selectedId);
        changed(tests ? `${tests.passed ? "测试通过" : "测试失败"}（${tests.command}）${checkpoint ? "，已存检查点" : ""}` : "项目没有测试命令：在项目设置里填写");
      } finally {
        setTesting(false);
      }
    });

  return (
    <div className="app">
      <header className="bar">
        <button onClick={onClose} title="关闭项目，回到项目列表">
          ← 项目
        </button>
        <strong>{info.name}</strong>
        <span className="muted path">{info.root}</span>
        <span className="spacer" />
        <TestBadge run={testRuns.last} />
        <button onClick={runTests} disabled={testing || runView?.state === "running"}>
          {testing ? "测试中…" : "运行测试"}
        </button>
        <span className="muted">L2：{info.l2 ?? "关闭"}</span>
        <span className="muted">当前节点：{canvas?.nodes.find((n) => n.id === activeId)?.title ?? "无"}</span>
        <button onClick={addNode}>＋ 节点</button>
        <button onClick={compileAll}>编译能力</button>
        <button onClick={install}>安装 hooks</button>
      </header>
      {notice && (
        <div className="notice row">
          <span className="grow">{notice}</span>
          <button className="link" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <main className="body">
        <div className="canvas">
          {canvas && canvas.nodes.length === 0 ? (
            <EmptyCanvas onAdd={addNode} onChange={changed} />
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(instance) => (flow.current = instance)}
              onNodesChange={(changes: NodeChange<NodeCardType>[]) => setFlowNodes((ns) => applyNodeChanges(changes, ns))}
              onNodeDragStop={(_e, _node, dragged) =>
                attempt(() => window.agentTogether.moveNodes(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))))
              }
              onConnect={connect}
              // The Delete key removes edges only; nodes go through the editor's button (with a confirmation).
              onBeforeDelete={async ({ edges: gone }) => ({ nodes: [], edges: gone })}
              onEdgesDelete={deleteEdges}
              onNodeClick={(_e, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          )}
        </div>
        <aside className="side">
          {selected ? (
            <>
              <NodeEditor node={selected} onChange={changed} />
              <section>
                <h4>派发任务</h4>
                <textarea
                  className="task"
                  rows={3}
                  placeholder="这次要做什么（留空则按任务清单推进）"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
                <div className="actions">
                  <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} title="在应用里运行：agent 在后台工作，输出显示在这里，做完自动跑测试">
                    <option value="app">在应用里运行</option>
                    <option value="terminal">在终端窗口打开</option>
                  </select>
                  <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
                    {(Object.keys(AGENT_NAMES) as Agent[]).map((a) => (
                      <option key={a} value={a}>
                        {AGENT_NAMES[a]}
                      </option>
                    ))}
                  </select>
                  <button className="primary" onClick={() => dispatch(selected.id)} disabled={runView?.state === "running" || runView?.state === "testing"}>
                    派发
                  </button>
                  {selected.id === activeId ? (
                    <button onClick={() => window.agentTogether.setActive(null)}>取消当前节点</button>
                  ) : (
                    <button onClick={() => window.agentTogether.setActive(selected.id)}>设为当前节点</button>
                  )}
                  <button onClick={() => setInspecting((v) => !v)}>{inspecting ? "收起上下文" : "检查上下文"}</button>
                  <button onClick={() => exportCapability(selected.id)}>导出为能力单元</button>
                </div>
                {inspecting && <ContextInspector nodeId={selected.id} task={task} version={version} onContext={setContextText} />}
              </section>
              {runView && runView.nodeId === selected.id && (
                <AgentRun
                  view={runView}
                  onStop={() => window.agentTogether.stopAgent()}
                  onDone={() => markDone(selected.id)}
                  onRetry={(retryTask) => dispatch(selected.id, retryTask)}
                />
              )}
              {info.hasGit && <RacePanel nodeId={selected.id} task={task} context={context} version={version} onChange={changed} />}
              <MemoryPanel nodeId={selected.id} version={version} onChange={changed} />
            </>
          ) : (
            <>
              <p className="muted">
                点节点查看和编辑；拖动节点调整位置；从节点右侧圆点拖到另一个节点表示依赖，选中连线按 Delete 删除。设为当前节点后，观察者按它的范围检查 agent。
              </p>
              {runView && (runView.state === "running" || runView.state === "testing") && (
                <p className="finding finding-warn">
                  {runView.agent} 正在处理"{canvas?.nodes.find((n) => n.id === runView.nodeId)?.title}"，点那个节点查看进度。
                </p>
              )}
              <ProjectSettings version={version} onChange={changed} />
              <MemoryPanel nodeId={null} version={version} onChange={changed} />
            </>
          )}
          {info.hasGit ? <CheckpointsPanel version={version} onChange={changed} /> : <p className="muted">项目不在 git 仓库中，检查点和赛马不可用。</p>}
          {judgments.length > 0 && (
            <>
              <h4>L2 定向判断</h4>
              <ol className="feed">
                {judgments.slice(0, 5).map((j) => (
                  <li key={j.at + j.nodeId}>
                    <span className="muted">{j.at.slice(11, 19)}</span>{" "}
                    <span className={j.onTrack ? "" : "finding-warn"}>{j.onTrack ? "没有偏离" : "可能偏离"}</span>：{j.reason}
                  </li>
                ))}
              </ol>
            </>
          )}
          <h4>观察者事件</h4>
          {feed.length === 0 && <p className="muted">暂无事件。派发任务后，agent 的每个动作都会出现在这里。</p>}
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
