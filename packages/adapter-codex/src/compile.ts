import { generatedNote, type Capability, type CapabilityCompiler, type CompiledFile } from "@loom/schema";

/**
 * The open Agent Skills layout, .agents/skills/<id>/SKILL.md, which Codex reads
 * from the working directory up to the repository root (Grok Build and Cursor
 * read it too). Codex has no file-based agent roles yet, so only skills compile.
 */
export const agentSkillsCompiler: CapabilityCompiler = {
  target: "agent-skills",
  compile(c: Capability): CompiledFile[] {
    if (c.kind !== "skill") return [];
    return [
      {
        path: `.agents/skills/${c.id}/SKILL.md`,
        content: `---\nname: ${c.id}\ndescription: ${JSON.stringify(c.description)}\n---\n\n${generatedNote(c)}\n\n${c.body}\n`,
      },
    ];
  },
};
