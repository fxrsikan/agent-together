import { useEffect, useState } from "react";
import type { Capability, CanvasNode } from "@agent-together/schema";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

type Form = { role: string; title: string; kind: CanvasNode["kind"]; status: CanvasNode["status"]; goal: string; acceptance: string; tasks: string; files: string };

const toForm = (n: CanvasNode): Form => ({
  role: n.role ?? "",
  title: n.title,
  kind: n.kind,
  status: n.status,
  goal: n.intent.goal,
  acceptance: n.intent.acceptance.join("\n"),
  tasks: n.intent.tasks.join("\n"),
  files: n.files.join("\n"),
});

/**
 * Edits one node's faces: title, kind, status, goal, acceptance criteria, tasks
 * (one per line) and the file globs it owns. Saves on demand; the id never changes.
 */
export function NodeEditor({ node, onChange }: { node: CanvasNode; onChange: (notice: string) => void }) {
  const [roles, setRoles] = useState<Capability[]>([]);
  useEffect(() => {
    window.agentTogether.roles().then(setRoles);
  }, [node]);
  const [form, setForm] = useState<Form>(() => toForm(node));
  const [error, setError] = useState("");

  // Another save (status from a dispatch, an AI plan) replaces what is shown, unless the user is typing.
  const saved = JSON.stringify(toForm(node));
  const dirty = JSON.stringify(form) !== saved;
  useEffect(() => {
    setForm(toForm(node));
    setError("");
  }, [node.id, saved]);

  const set = <K extends keyof Form>(key: K) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value as Form[K] }));

  const save = async () => {
    try {
      await window.agentTogether.saveNode({
        ...node,
        title: form.title.trim() || node.title,
        role: form.role || undefined,
        kind: form.kind,
        status: form.status,
        intent: { goal: form.goal.trim(), acceptance: lines(form.acceptance), tasks: lines(form.tasks) },
        files: lines(form.files).map((f) => f.replace(/\\/g, "/")),
      });
      onChange(`已保存卡片"${form.title}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (await window.agentTogether.deleteNode(node.id)) onChange(`已删除卡片"${node.title}"`);
  };

  return (
    <section className="editor">
      <input className="title-input" value={form.title} onChange={set("title")} aria-label="卡片名" />
      <div className="row">
        <select value={form.kind} onChange={set("kind")} aria-label="类型">
          <option value="feature">功能</option>
          <option value="module">模块</option>
          <option value="decision">决策</option>
          <option value="flow">流程</option>
        </select>
        <select value={form.status} onChange={set("status")} aria-label="状态">
          <option value="todo">待办</option>
          <option value="in_progress">进行中</option>
          <option value="done">完成</option>
          <option value="blocked">阻塞</option>
        </select>
        <span className="muted small grow">id：{node.id}</span>
      </div>
      <label>
        角色
        <select value={form.role} onChange={set("role")}>
          <option value="">不指定角色</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id} title={r.description}>{r.id}</option>
          ))}
        </select>
      </label>
      <label>
        目标
        <textarea className="task" rows={2} value={form.goal} onChange={set("goal")} placeholder="这张卡片要做成什么" />
      </label>
      <label>
        验收标准（每行一条）
        <textarea className="task" rows={3} value={form.acceptance} onChange={set("acceptance")} />
      </label>
      <label>
        任务（每行一条）
        <textarea className="task" rows={3} value={form.tasks} onChange={set("tasks")} />
      </label>
      <label>
        拥有的文件（每行一个 glob，如 src/store/**）
        <textarea className="task mono" rows={2} value={form.files} onChange={set("files")} />
      </label>
      {error && <div className="finding finding-block">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          {dirty ? "保存卡片" : "已保存"}
        </button>
        {dirty && <button onClick={() => setForm(toForm(node))}>撤销修改</button>}
        <span className="spacer" />
        <button onClick={remove}>删除卡片</button>
      </div>
    </section>
  );
}
