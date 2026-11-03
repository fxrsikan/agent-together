import { generatedNote, type Capability, type CapabilityCompiler, type CompiledFile } from "@loom/schema";

const yaml = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar

/**
 * Claude Code: skills → .claude/skills/<id>/SKILL.md, agent roles →
 * .claude/agents/<id>.md (subagents). Observers run in Loom, not here.
 */
export const claudeCodeCompiler: CapabilityCompiler = {
  target: "claude-code",
  compile(c: Capability): CompiledFile[] {
    if (c.kind === "skill") {
      return [
        {
          path: `.claude/skills/${c.id}/SKILL.md`,
          content: `---\nname: ${c.id}\ndescription: ${yaml(c.description)}\n---\n\n${generatedNote(c)}\n\n${c.body}\n`,
        },
      ];
    }
    if (c.kind === "agent") {
      const head = [`name: ${c.id}`, `description: ${yaml(c.description)}`];
      if (c.tools?.length) head.push(`tools: ${c.tools.join(", ")}`);
      if (c.model) head.push(`model: ${c.model}`);
      return [{ path: `.claude/agents/${c.id}.md`, content: `---\n${head.join("\n")}\n---\n\n${generatedNote(c)}\n\n${c.body}\n` }];
    }
    return [];
  },
};
