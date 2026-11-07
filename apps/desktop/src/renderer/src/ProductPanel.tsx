import { useEffect, useRef, useState } from "react";
import type { ProductState, RunCheck, RunConfig } from "../../preload";
import { errorText } from "./errors";

/**
 * 产品预览 (phase one, M2): start and stop the product being built, see it inside
 * the app, and say whether the sample-data prototype's pages and flow are right.
 * The page itself is a separate, isolated web view the main process lays over the
 * placeholder below; this component keeps it in place and hides it when not shown.
 */

const STATE: Record<string, { label: string; tone: string }> = {
  stopped: { label: "没有运行", tone: "" },
  installing: { label: "正在安装依赖…", tone: "badge-warn" },
  starting: { label: "正在启动…", tone: "badge-warn" },
  running: { label: "运行中", tone: "badge-good" },
  failed: { label: "启动失败", tone: "badge-bad" },
};
const STAGE: Record<string, { label: string; hint: string }> = {
  prototype: { label: "交互原型 · 示例数据", hint: "可以操作；数据和 AI 生成的结果都是示例，不是真实服务给的" },
  functional: { label: "功能版本", hint: "已接通真实逻辑或服务，可以试用" },
};

function RunSetup({ state, onDone }: { state: ProductState; onDone: (notice: string) => void }) {
  const [form, setForm] = useState<RunConfig>(state.config ?? state.guess ?? { start: "" });
  const [busy, setBusy] = useState("");
  const [check, setCheck] = useState<RunCheck | null>(null);
  const [error, setError] = useState("");
  const run = (label: string, work: () => Promise<RunCheck>) => async () => {
    setBusy(label);
    setError("");
    setCheck(null);
    try {
      const result = await work();
      setCheck(result);
      if (result.config) setForm(result.config);
      if (result.ok) onDone(`找到了启动方式：${result.config?.start}，试过能打开。点「启动」就能在这里看到产品`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="run-setup">
      <h4>怎么启动这个产品</h4>
      <p className="muted">
        要先知道启动命令，才能在这里打开产品。{state.guess ? `从文件看，可能是 ${state.guess.start}。` : "还没有服务器入口时，等 AI 做完集成卡片再来。"}
        找到后会真的启动一次，能打开才保存。
      </p>
      <div className="actions">
        <button className="primary" disabled={!!busy} onClick={run("detect", () => window.agentTogether.productDetect())}>
          {busy === "detect" ? "正在找、正在试…" : "找出启动方式并试一下"}
        </button>
      </div>
      <details>
        <summary className="muted small">手动填写</summary>
        <label className="field">
          <span>启动命令（服务器要监听环境变量 PORT 指定的端口）</span>
          <input value={form.start} placeholder="例如 node server.js" onChange={(e) => setForm({ ...form, start: e.target.value })} />
        </label>
        <label className="field">
          <span>安装依赖的命令（没有依赖就空着）</span>
          <input value={form.install ?? ""} placeholder="例如 npm install" onChange={(e) => setForm({ ...form, install: e.target.value })} />
        </label>
        <label className="field">
          <span>打开的路径</span>
          <input value={form.path ?? ""} placeholder="/" onChange={(e) => setForm({ ...form, path: e.target.value })} />
        </label>
        <div className="actions">
          <button disabled={!!busy || !form.start.trim()} onClick={run("save", () => window.agentTogether.productSaveConfig(form))}>
            {busy === "save" ? "正在试…" : "保存并试一下"}
          </button>
        </div>
      </details>
      {error && <p className="finding finding-block">{error}</p>}
      {check && !check.ok && (
        <div className="finding finding-block">
          <strong>没能打开：</strong>
          {check.error}
          {check.logs.length > 0 && <pre className="test-output">{check.logs.slice(-30).join("\n")}</pre>}
        </div>
      )}
    </div>
  );
}

export function ProductPanel({ visible, version, onChange }: { visible: boolean; version: number; onChange: (notice: string) => void }) {
  const [st, setSt] = useState<ProductState | null>(null);
  const [busy, setBusy] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  const refresh = () => window.agentTogether.productState().then(setSt);
  useEffect(() => {
    void refresh();
  }, [version]);
  useEffect(() => {
    const offs = [window.agentTogether.onProductStatus(() => void refresh()), window.agentTogether.onPreviewProblem(() => void refresh())];
    return () => offs.forEach((off) => off());
  }, []);

  const running = st?.status.state === "running";
  // Keep the product page over the placeholder: it moves when side panels open or the window resizes.
  useEffect(() => {
    if (!visible || !running) {
      void window.agentTogether.previewPlace(null);
      return;
    }
    let last = "";
    const place = () => {
      const r = slot.current?.getBoundingClientRect();
      const bounds = r && r.width > 1 && r.height > 1 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(bounds);
      if (key !== last) {
        last = key;
        void window.agentTogether.previewPlace(bounds);
      }
    };
    place();
    const timer = setInterval(place, 250);
    return () => {
      clearInterval(timer);
      void window.agentTogether.previewPlace(null);
    };
  }, [visible, running]);

  if (!st) return null;
  const act = (label: string, work: () => Promise<unknown>) => async () => {
    setBusy(label);
    try {
      await work();
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy("");
      void refresh();
    }
  };
  const state = STATE[st.status.state] ?? STATE.stopped;
  const stage = st.stage ? STAGE[st.stage] : null;
  const askPrototype = running && st.stage === "prototype" && !st.prototypeConfirmedAt;

  return (
    <div className="product" style={visible ? undefined : { display: "none" }}>
      <div className="row product-bar">
        <span className={`badge ${state.tone}`}>{state.label}</span>
        {stage && (
          <span className="badge badge-warn" title={stage.hint}>
            {stage.label}
          </span>
        )}
        {st.status.url && running && <span className="muted small one-line">{st.status.url}</span>}
        <span className="spacer" />
        {st.config && !running && (
          <button className="primary" disabled={!!busy || st.status.state === "starting" || st.status.state === "installing"} onClick={act("start", () => window.agentTogether.productStart())}>
            {busy === "start" ? "启动中…" : "启动"}
          </button>
        )}
        {running && (
          <>
            <button onClick={() => void window.agentTogether.previewReload()} title="刷新页面">
              刷新
            </button>
            <button disabled={!!busy} onClick={act("start", () => window.agentTogether.productStart())} title="停止再启动，代码改过之后用">
              {busy === "start" ? "重启中…" : "重新启动"}
            </button>
            <button disabled={!!busy} onClick={act("stop", () => window.agentTogether.productStop())}>
              停止
            </button>
            <button onClick={() => void window.agentTogether.previewOpenExternal()}>在浏览器里打开</button>
          </>
        )}
        {st.problems.length > 0 && (
          <button className={showProblems ? "on" : ""} onClick={() => setShowProblems((v) => !v)} title="页面里的报错和失败的请求">
            页面报错 {st.problems.length}
          </button>
        )}
        <button className={showLogs ? "on" : ""} onClick={() => setShowLogs((v) => !v)}>
          看日志
        </button>
        {st.config && (
          <button className="link" onClick={() => setEditing((v) => !v)} title={`启动命令：${st.config.start}`}>
            启动方式
          </button>
        )}
      </div>

      {askPrototype && (
        <div className="prototype-bar">
          {feedback === null ? (
            <div className="row">
              <span className="grow">这是用示例数据的原型。按需求里的场景操作一遍，看看页面和流程对不对；确认后才接真实业务逻辑。</span>
              <button className="primary" disabled={!!busy} onClick={act("verdict", async () => (await window.agentTogether.prototypeVerdict(true), onChange("已确认原型：页面和流程没问题，记进了决定记录")))}>
                页面和流程没问题
              </button>
              <button onClick={() => setFeedback("")}>要改…</button>
            </div>
          ) : (
            <div className="row">
              <textarea className="grow" rows={2} value={feedback} placeholder="哪个页面、哪一步、想改成什么样" onChange={(e) => setFeedback(e.target.value)} />
              <button
                className="primary"
                disabled={!!busy || !feedback.trim()}
                onClick={act("verdict", async () => {
                  await window.agentTogether.prototypeVerdict(false, feedback);
                  setFeedback(null);
                  onChange("意见记下了：在「需求与反馈」的对话里，也记进了决定记录");
                })}
              >
                记下意见
              </button>
              <button onClick={() => setFeedback(null)}>取消</button>
            </div>
          )}
        </div>
      )}

      {(!st.config || editing) && <RunSetup state={st} onDone={(n) => (setEditing(false), onChange(n), void refresh())} />}

      {st.status.state === "failed" && (
        <div className="finding finding-block">
          <strong>启动失败：</strong>
          {st.status.error}
          <pre className="test-output">{st.logs.slice(-20).join("\n")}</pre>
        </div>
      )}
      {showProblems && (
        <ul className="problems small">
          {st.problems.map((p, i) => (
            <li key={i}>
              <span className="badge badge-bad">{p.kind === "console" ? "页面报错" : p.kind === "network" ? "请求失败" : "没打开"}</span> {p.message}
              {p.url && <span className="muted"> · {p.url}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="product-slot" ref={slot}>
        {!running && st.config && st.status.state !== "failed" && (
          <p className="muted center-hint">{st.status.state === "stopped" ? "产品没有运行。点「启动」后，它会显示在这里，可以直接操作。" : "正在启动…"}</p>
        )}
      </div>
      {showLogs && <pre className="product-logs">{st.logs.join("\n") || "还没有日志"}</pre>}
    </div>
  );
}
