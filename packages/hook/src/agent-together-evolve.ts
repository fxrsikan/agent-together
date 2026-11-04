#!/usr/bin/env node
import path from "node:path";
import { Evolution, createLlm, loadLlmConfig, loadRaceConfig } from "@agent-together/core";
import { claudeCodeRunner } from "@agent-together/adapter-claude-code";
import { codexRunner } from "@agent-together/adapter-codex";
import { cursorRunner } from "@agent-together/adapter-cursor";
import { grokRunner } from "@agent-together/adapter-grok";
import type { AgentRunner } from "@agent-together/schema";

const args = process.argv.slice(2);
const usage =
  '用法：agent-together-evolve <项目目录> <卡片id> "任务" [助手名]\n' +
  "同意：agent-together-evolve approve <项目目录> <记录id> [--adopt]\n" +
  "查看：agent-together-evolve list <项目目录>\n" +
  "清理：agent-together-evolve discard <项目目录> <记录id>";

try {
  const command = ["approve", "discard", "list"].includes(args[0]) ? args.shift() : "run";
  if (!args[0] || (command !== "list" && !args[1])) throw new Error(usage);
  const root = path.resolve(args[0]);
  const evolution = new Evolution(root, createLlm(loadLlmConfig(root)));
  if (command === "approve") {
    evolution.approve(args[1], args.includes("--adopt"));
    console.log("已同意并记住做法");
  } else if (command === "discard") {
    evolution.discard(args[1]);
    console.log("已清理这次尝试");
  } else if (command === "list") {
    console.log(JSON.stringify(evolution.list(), null, 2));
  } else {
    const factories: Record<string, (model?: string) => AgentRunner> = {
      "claude-code": claudeCodeRunner,
      codex: codexRunner,
      cursor: cursorRunner,
      "grok-build": grokRunner,
    };
    const config = loadRaceConfig(root);
    const agent = args[3] ?? config.agents?.[0] ?? "claude-code";
    if (!factories[agent]) {
      throw new Error("找不到这个助手，请选 claude-code、codex、cursor 或 grok-build");
    }
    const report = await evolution.run(
      args[1],
      args[2] ?? "",
      factories[agent](config.models?.[agent]),
      console.log,
    );
    console.log(report.message);
    console.log(JSON.stringify(report, null, 2));
    console.log(`记录已保存：.agent-together/evolutions/${report.id}.json`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
