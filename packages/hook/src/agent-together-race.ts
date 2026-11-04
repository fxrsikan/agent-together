#!/usr/bin/env node
import path from "node:path";
import { claudeCodeRunner } from "@agent-together/adapter-claude-code";
import { codexRunner } from "@agent-together/adapter-codex";
import { cursorRunner } from "@agent-together/adapter-cursor";
import { loadRaceConfig, ProjectStore, MemoryStore, Race, type RaceReport } from "@agent-together/core";
import type { AgentRunner } from "@agent-together/schema";

const usage = `Usage:
  agent-together-race <projectDir> <nodeId> "<task>" [--agents claude-code,codex,cursor] [--claude-model haiku] [--codex-model <m>] [--cursor-model <m>]
  agent-together-race adopt <projectDir> <raceId> <contestant>
  agent-together-race discard <projectDir> <raceId>`;

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const agentsOption = option("--agents");
const modelOptions: Record<string, string | undefined> = {
  "claude-code": option("--claude-model"),
  codex: option("--codex-model"),
  cursor: option("--cursor-model"),
};

function project(dir: string | undefined): string {
  const store = dir && ProjectStore.find(path.resolve(dir));
  if (!store) {
    console.error(usage);
    process.exit(1);
  }
  return store.root;
}

function print(report: RaceReport) {
  console.log(`\nRace ${report.id}  node: ${report.nodeId}  task: ${report.task}`);
  const ranked = [...report.contestants].sort((a, b) => b.score.total - a.score.total);
  for (const c of ranked) {
    const cost = c.run.costUsd !== undefined ? ` $${c.run.costUsd.toFixed(3)}` : "";
    const tokens = c.run.outputTokens !== undefined ? ` ${c.run.inputTokens ?? "?"} in / ${c.run.outputTokens} out tokens` : "";
    console.log(`\n  ${c.id}: ${c.score.total} points  (${Math.round(c.run.durationMs / 1000)}s${cost}${tokens})`);
    for (const p of c.score.parts) console.log(`    ${p.points > 0 ? "+" : ""}${p.points}  ${p.label}`);
    for (const f of c.files) console.log(`    file ${f.path}  +${f.added} -${f.removed}`);
    for (const f of c.findings) console.log(`    [${f.level}] ${f.rule}: ${f.message}`);
    console.log(`    says: ${c.run.summary.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  console.log(`\nAdopt one:  agent-together-race adopt <projectDir> ${report.id} <contestant>`);
}

if (args[0] === "adopt") {
  new Race(project(args[1])).adopt(args[2], args[3]);
  console.log(`Adopted ${args[3]} from race ${args[2]}; a checkpoint was saved first, worktrees removed.`);
} else if (args[0] === "discard") {
  new Race(project(args[1])).discard(args[2]);
  console.log(`Discarded the worktrees of race ${args[2]}.`);
} else {
  const root = project(args[0]);
  const [nodeId, task] = [args[1], args[2] ?? ""];
  if (!nodeId) {
    console.error(usage);
    process.exit(1);
  }
  const config = loadRaceConfig(root);
  const agents = agentsOption?.split(",") ?? config.agents ?? ["claude-code", "codex"];
  const factories: Record<string, (model?: string) => AgentRunner> = { "claude-code": claudeCodeRunner, codex: codexRunner, cursor: cursorRunner };
  const unknown = agents.filter((a) => !factories[a]);
  if (unknown.length) {
    console.error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${Object.keys(factories).join(", ")}`);
    process.exit(1);
  }
  const runners = agents.map((a) => factories[a](modelOptions[a] ?? config.models?.[a]));
  const report = await new Race(root).run(nodeId, task, runners, new MemoryStore(root).forNode(nodeId), (m) => console.log(`… ${m}`));
  print(report);
}
