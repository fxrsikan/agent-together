import type { Capability } from "@agent-together/schema";

/** Editable proposal; no files are written until the user approves it. */
export function RoleDraft({ draft, onEdit, onSave, onDiscard }: {
  draft: Capability;
  onEdit: (draft: Capability) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <section>
      <strong>角色草稿</strong>
      <label>
        角色编号（小写英文、数字和短横线）
        <input value={draft.id} onChange={(e) => onEdit({ ...draft, id: e.target.value })} />
      </label>
      <label>
        什么时候用
        <textarea className="task" value={draft.description} onChange={(e) => onEdit({ ...draft, description: e.target.value })} />
      </label>
      <label>
        工作说明
        <textarea className="task" rows={6} value={draft.body} onChange={(e) => onEdit({ ...draft, body: e.target.value })} />
      </label>
      <label>
        可用工具（逗号分隔，留空不限制）
        <input
          value={draft.tools?.join(", ") ?? ""}
          onChange={(e) => onEdit({
            ...draft,
            tools: e.target.value.trim() ? e.target.value.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          })}
        />
      </label>
      <label>
        使用的模型（可留空）
        <input value={draft.model ?? ""} onChange={(e) => onEdit({ ...draft, model: e.target.value || undefined })} />
      </label>
      <button onClick={onSave}>同意并保存</button>
      <button onClick={onDiscard}>不要这个角色</button>
    </section>
  );
}
