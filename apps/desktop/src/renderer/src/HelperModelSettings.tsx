import { useEffect, useState } from "react";
import type { LlmSettings } from "../../preload";
import { errorText } from "./errors";

type Form = Omit<LlmSettings, "name">;

const PROVIDERS: { id: Form["provider"]; label: string; hint: string }[] = [
  { id: "auto", label: "自动", hint: "设置了 ANTHROPIC_API_KEY 就用 Anthropic API，否则用你登录的 Claude 命令行。" },
  { id: "claude-cli", label: "Claude 命令行", hint: "用你在 Claude Code 里登录的账号，不需要 API Key。" },
  { id: "anthropic", label: "Anthropic API", hint: "需要在系统环境变量里设置 ANTHROPIC_API_KEY。" },
  { id: "openai-compatible", label: "其他服务（OpenAI 兼容）", hint: "例如本机的 Ollama：地址填 http://localhost:11434/v1。需要密钥时设置环境变量 AGENT_TOGETHER_LLM_API_KEY。" },
  { id: "off", label: "关闭", hint: "关闭后不能用 AI 生成画布、写角色、进化，做完也不再复查。" },
];

const CLAUDE_MODELS = [
  { id: "", label: "默认（Haiku，最便宜）" },
  { id: "haiku", label: "Haiku（最快、最便宜）" },
  { id: "sonnet", label: "Sonnet（均衡）" },
  { id: "opus", label: "Opus（最强，也最贵）" },
];

/**
 * The helper model: the one that turns a description into cards, drafts roles,
 * proposes evolution strategies and reviews each finished turn. Separate from
 * the models the assistants code with. Saving reopens the project with it.
 */
export function HelperModelSettings({ onChange }: { onChange: (notice: string) => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.agentTogether.llmSettings().then(({ name: running, ...settings }) => {
      setForm(settings);
      setSaved(settings);
      setName(running);
    });
  }, []);
  if (!form || !saved) return null;

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const provider = PROVIDERS.find((p) => p.id === form.provider) ?? PROVIDERS[0];
  const claudeish = form.provider === "auto" || form.provider === "claude-cli";
  const save = async () => {
    setBusy(true);
    try {
      const info = await window.agentTogether.saveLlmSettings(form);
      setSaved(form);
      setName(info.l2);
      onChange(info.l2 ? `帮手模型已换成 ${info.l2}` : "已关闭帮手模型");
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="editor">
      <h4>帮手模型</h4>
      <p className="muted">
        生成画布、写角色、想进化的做法，以及每次做完后的复查，都由它来做。和 AI 助手写代码用的模型是分开的。现在：{name ?? "关闭"}
      </p>
      <label>
        用什么
        <select value={form.provider} onChange={(e) => set({ provider: e.target.value as Form["provider"], model: "", baseUrl: "" })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{provider.hint}</p>
      {claudeish && (
        <label>
          模型
          <select value={CLAUDE_MODELS.some((m) => m.id === form.model) ? form.model : ""} onChange={(e) => set({ model: e.target.value })}>
            {CLAUDE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.provider === "anthropic" && (
        <label>
          模型（留空用 claude-haiku-5-5）
          <input className="mono" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="claude-haiku-5-5" />
        </label>
      )}
      {form.provider === "openai-compatible" && (
        <>
          <label>
            服务地址
            <input className="mono" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />
          </label>
          <label>
            模型名
            <input className="mono" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="例如 qwen3" />
          </label>
        </>
      )}
      <div className="actions">
        <button className="primary" disabled={!dirty || busy} onClick={save} title="保存后会重新打开项目，让观察者用上新的模型">
          {busy ? "切换中…" : dirty ? "保存" : "已保存"}
        </button>
      </div>
    </section>
  );
}
