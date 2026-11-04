/**
 * Claude Code's and cursor-agent's `--output-format stream-json`: one JSON object
 * per line; `assistant` messages carry the agent's text as it works, and the last
 * `result` object has the same fields as plain `--output-format json`.
 */

/** The text an `assistant` line says, or null for any other line. */
export function streamJsonText(line: string): string | null {
  try {
    const j = JSON.parse(line);
    if (j.type !== "assistant") return null;
    const text = (j.message?.content ?? [])
      .filter((c: { type?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The final `result` object of a stream, or null when the run produced none. */
export function streamJsonResult(stdout: string): Record<string, any> | null {
  const lines = stdout.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j.type === "result") return j;
    } catch {}
  }
  return null;
}
