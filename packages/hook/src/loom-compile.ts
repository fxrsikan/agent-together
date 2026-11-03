#!/usr/bin/env node
import path from "node:path";
import { claudeCodeCompiler } from "@loom/adapter-claude-code";
import { agentSkillsCompiler } from "@loom/adapter-codex";
import { cursorRulesCompiler } from "@loom/adapter-cursor";
import { CapabilityStore, compileCapabilities, LoomStore } from "@loom/core";

// Usage: loom-compile [projectDir] — compiles .loom/capabilities/* for Claude Code, Agent Skills (Codex, Grok Build) and Cursor.
const store = LoomStore.find(path.resolve(process.argv[2] ?? "."));
if (!store) {
  console.error("No .loom directory found.");
  process.exit(1);
}
const reports = compileCapabilities(store.root, new CapabilityStore(store.root).list(), [
  claudeCodeCompiler,
  agentSkillsCompiler,
  cursorRulesCompiler,
]);
if (!reports.length) console.log("No capabilities in .loom/capabilities/.");
for (const r of reports) {
  console.log(`${r.id}${r.errors.length ? "  NOT COMPILED" : ""}`);
  for (const e of r.errors) console.log(`  error: ${e}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  if (r.kind === "observer" && !r.errors.length) console.log("  enforced by the Loom observer for every agent (no files to write)");
  for (const [target, files] of Object.entries(r.written)) console.log(`  ${target}: ${files.join(", ")}`);
  if (r.skipped.length) console.log(`  no equivalent on: ${r.skipped.join(", ")}`);
}
process.exit(reports.some((r) => r.errors.length) ? 1 : 0);
