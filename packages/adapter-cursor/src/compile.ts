import { generatedNote, type Capability, type CapabilityCompiler, type CompiledFile } from "@agent-together/schema";

/**
 * Cursor project rules: a skill becomes .cursor/rules/<id>.mdc. With a scope it
 * auto-attaches when matching files are in play; without one Cursor's agent
 * pulls it in by its description. Rules must be .mdc — plain .md is ignored.
 */
export const cursorRulesCompiler: CapabilityCompiler = {
  target: "cursor",
  compile(c: Capability): CompiledFile[] {
    if (c.kind !== "skill") return [];
    const head = [`description: ${JSON.stringify(c.description)}`];
    if (c.scope.length) head.push(`globs: ${c.scope.join(",")}`);
    head.push("alwaysApply: false");
    return [{ path: `.cursor/rules/${c.id}.mdc`, content: `---\n${head.join("\n")}\n---\n\n${generatedNote(c)}\n\n${c.body}\n` }];
  },
};
