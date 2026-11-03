/**
 * The small frontmatter dialect Loom writes for its own Markdown files
 * (.loom/memory, .loom/capabilities): one `key: value` per line, where a value
 * is null, a JSON string/array/object (anything that starts with " [ or {),
 * or a bare word. Not YAML; just enough to stay readable and diff-friendly.
 */
export function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("file has no frontmatter");
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const value = line.slice(i + 1).trim();
    fields[line.slice(0, i).trim()] = value === "null" ? null : /^["[{]/.test(value) ? JSON.parse(value) : value;
  }
  return { fields, body: match[2].trim() };
}

/** Serializes fields in the given order; undefined ones are skipped, strings needing it are JSON-quoted. */
export function formatFrontmatter(fields: [string, unknown][], body: string): string {
  const lines = fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (v === null) return `${k}: null`;
      if (typeof v === "string" && /^[\w.@/-]+$/.test(v) && v !== "null") return `${k}: ${v}`;
      return `${k}: ${JSON.stringify(v)}`;
    });
  return `---\n${lines.join("\n")}\n---\n${body.trim()}\n`;
}
