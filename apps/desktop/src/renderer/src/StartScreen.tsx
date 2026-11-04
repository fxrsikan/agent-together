import { useEffect, useState } from "react";

/**
 * No project open: reopen a recent one, open any folder (set up on first open),
 * or create a new one. Opening switches the window to the workspace.
 */
export function StartScreen({ onOpenSetup }: { onOpenSetup: () => void }) {
  const [recent, setRecent] = useState<{ root: string; name: string; exists: boolean }[]>([]);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    window.agentTogether.recentProjects().then(setRecent);
  }, []);

  const attempt = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = () =>
    attempt(async () => {
      const dir = await window.agentTogether.chooseFolder("打开项目文件夹（第一次打开会按代码结构生成画布）");
      if (dir) await window.agentTogether.openProject(dir);
    });

  const chooseParent = async () => {
    const dir = await window.agentTogether.chooseFolder("新项目放在哪个文件夹下");
    if (dir) setParent(dir);
  };

  const create = () => attempt(() => window.agentTogether.createProject(parent, name, description));

  return (
    <div className="start">
      <h1>Agent Together</h1>
      <p className="muted">在画布上规划项目，把卡片交给 Claude Code、Codex、Cursor 或 Grok Build，观察者在旁边看着它们不跑偏。</p>
      <p className="muted small">
        <button className="link" onClick={onOpenSetup}>
          安装向导
        </button>
        ：检查 Node.js、git 和 AI 助手是否装好、登录好。
      </p>
      {error && <div className="finding finding-block">{error}</div>}
      <div className="start-columns">
        <section className="start-card">
          <h3>新建项目</h3>
          <label>
            项目名
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 todo-cli" />
          </label>
          <label>
            位置
            <div className="row">
              <span className="grow path">{parent || "未选择"}</span>
              <button onClick={chooseParent}>选择文件夹</button>
            </div>
          </label>
          <label>
            产品描述（可选，之后可以用它让 AI 生成画布）
            <textarea
              className="task"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如：一个命令行待办清单，可以添加、完成、删除、列出待办，数据存在本地 JSON 文件里。"
            />
          </label>
          <button className="primary" disabled={busy || !name.trim() || !parent} onClick={create}>
            {busy ? "创建中…" : "创建"}
          </button>
          <p className="muted small">会创建文件夹并初始化 git，装好各家 AI 助手的观察者对接（Grok Build 会读 Claude Code 的）。</p>
        </section>
        <section className="start-card">
          <h3>打开</h3>
          <button onClick={openFolder} disabled={busy}>
            打开文件夹…
          </button>
          <h4>最近的项目</h4>
          {recent.length === 0 && <p className="muted">还没有。</p>}
          <ol className="feed">
            {recent.map((p) => (
              <li key={p.root} className="row">
                <span className="grow">
                  <strong>{p.name}</strong>
                  <br />
                  <span className="muted path">{p.root}</span>
                </span>
                <button disabled={busy || !p.exists} title={p.exists ? undefined : "文件夹已不存在"} onClick={() => attempt(() => window.agentTogether.openProject(p.root))}>
                  打开
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
