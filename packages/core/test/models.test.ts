import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listModels, parseCursorModels, parseGrokModels, projectModels, readCodexModels, saveProjectModels } from "../src/models.js";

describe("model lists", () => {
  it("reads cursor-agent models, leaving out auto", () => {
    const out = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\ncomposer-2.5 - Composer 2.5\n";
    expect(parseCursorModels(out)).toEqual([
      { id: "gpt-5.3-codex", label: "Codex 5.3" },
      { id: "composer-2.5", label: "Composer 2.5" },
    ]);
  });

  it("reads grok models, default included", () => {
    const out = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n    grok-4.7-mini\n";
    expect(parseGrokModels(out).map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-mini"]);
  });

  it("reads Codex's model cache, and copes without one", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "at-models-"));
    expect(readCodexModels(home)).toEqual([]);
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-x", display_name: "GPT-X" }, { nope: 1 }] }));
    expect(readCodexModels(home)).toEqual([{ id: "gpt-x", label: "GPT-X" }]);
  });

  it("lists every assistant without running a model, empty when a CLI fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "at-models-"));
    const ran: string[] = [];
    const models = await listModels({
      env: {},
      home,
      run: async (command, args) => {
        ran.push(`${command} ${args.join(" ")}`);
        return command.includes("cursor") ? { code: 0, stdout: "x-model - X Model\n", stderr: "" } : { code: 1, stdout: "", stderr: "no" };
      },
    });
    expect(models["claude-code"].map((m) => m.id)).toEqual(["haiku", "sonnet", "opus"]);
    expect(models.cursor).toEqual([{ id: "x-model", label: "X Model" }]);
    expect(models["grok-build"]).toEqual([]);
    expect(models.codex).toEqual([]);
    expect(ran.every((r) => r.endsWith(" models"))).toBe(true);
  });
});

describe("project models", () => {
  it("saves models in race.json, keeping other settings and dropping defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "at-models-"));
    fs.mkdirSync(path.join(root, ".agent-together"));
    fs.writeFileSync(path.join(root, ".agent-together", "race.json"), JSON.stringify({ agents: ["codex"] }));
    saveProjectModels(root, { "claude-code": " haiku ", codex: "" });
    expect(projectModels(root)).toEqual({ "claude-code": "haiku" });
    expect(JSON.parse(fs.readFileSync(path.join(root, ".agent-together", "race.json"), "utf8")).agents).toEqual(["codex"]);
    saveProjectModels(root, { "claude-code": "" });
    expect(projectModels(root)).toEqual({});
  });
});
