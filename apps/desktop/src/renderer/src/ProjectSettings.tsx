import { useEffect, useState } from "react";

/** The project-wide facts every dispatch carries: what it is, its stack, and how to test it. */
export function ProjectSettings({ version, onChange }: { version: number; onChange: (notice: string) => void }) {
  const [form, setForm] = useState({ description: "", stack: "", testCommand: "" });
  const [saved, setSaved] = useState(form);

  useEffect(() => {
    window.agentTogether.projectInfo().then((p) => {
      const next = { description: p.description ?? "", stack: p.stack ?? "", testCommand: p.testCommand ?? "" };
      setForm(next);
      setSaved(next);
    });
  }, [version]);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    await window.agentTogether.saveProjectInfo({ description: form.description.trim(), stack: form.stack.trim(), testCommand: form.testCommand.trim() });
    setSaved(form);
    onChange("已保存项目设置，下次派发生效");
  };

  return (
    <section className="editor">
      <h4>项目设置</h4>
      <label>
        产品描述（每次派发都会带给 agent）
        <textarea className="task" rows={3} value={form.description} onChange={set("description")} />
      </label>
      <label>
        技术栈
        <input value={form.stack} onChange={set("stack")} />
      </label>
      <label>
        测试命令（在项目根目录运行；应用里派发的 agent 做完后自动跑）
        <input className="mono" value={form.testCommand} onChange={set("testCommand")} placeholder="例如 node --test 或 npm test" />
      </label>
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          {dirty ? "保存" : "已保存"}
        </button>
      </div>
    </section>
  );
}
