import { useEffect, useState } from "react";

const AGENTS: { id: string; name: string }[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "grok-build", name: "Grok Build" },
];
const OTHER = "__other__";

type Choice = { id: string; label: string };

/**
 * Which model each AI assistant uses in this project: its own default, one it
 * lists for this account, or a name typed in. Saved choices become the default
 * for new projects. Used by "交给 AI 去做", races and evolution alike.
 */
export function ModelSettings({ version, onChange }: { version: number; onChange: (notice: string) => void }) {
  const [lists, setLists] = useState<Record<string, Choice[]> | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.agentTogether.projectModels().then((m) => {
      setForm(m);
      setSaved(m);
    });
  }, [version]);
  useEffect(() => {
    window.agentTogether.listModels().then(setLists, () => setLists({}));
  }, []);

  const dirty = AGENTS.some((a) => (form[a.id] ?? "") !== (saved[a.id] ?? ""));
  const save = async () => {
    const next = await window.agentTogether.saveProjectModels(form);
    setForm(next);
    setSaved(next);
    onChange("已保存模型选择，下次交给 AI 时生效；新建的项目也会默认用这些模型");
  };

  return (
    <section className="editor">
      <h4>用哪个模型</h4>
      <p className="muted">越强的模型越贵。拿不准就先用便宜的，做不好再换。</p>
      {AGENTS.map((a) => {
        const value = form[a.id] ?? "";
        const listed = lists?.[a.id] ?? [];
        const custom = typing[a.id] || (value !== "" && !listed.some((m) => m.id === value));
        return (
          <label key={a.id}>
            {a.name}
            <select
              value={custom ? OTHER : value}
              onChange={(e) => {
                const v = e.target.value;
                setTyping((t) => ({ ...t, [a.id]: v === OTHER }));
                if (v !== OTHER) setForm((f) => ({ ...f, [a.id]: v }));
              }}
            >
              <option value="">它自己的默认设置</option>
              {listed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={OTHER}>{lists ? "其他（自己填模型名）" : "正在读取可用的模型…"}</option>
            </select>
            {custom && (
              <input
                className="mono"
                value={value}
                placeholder="模型名，例如 sonnet"
                onChange={(e) => setForm((f) => ({ ...f, [a.id]: e.target.value }))}
              />
            )}
          </label>
        );
      })}
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          {dirty ? "保存" : "已保存"}
        </button>
      </div>
    </section>
  );
}
