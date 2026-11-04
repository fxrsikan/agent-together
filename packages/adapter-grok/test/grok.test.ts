import { describe, expect, it } from "vitest";
import { parseGrokResult } from "@agent-together/adapter-grok";

// Shape of a real `grok --output-format json` result (Grok Build 1.0.70), trimmed.
const result = (stopReason: string) =>
  JSON.stringify({
    text: "已加上数字规则。",
    stopReason,
    usage: { input_tokens: 16322, cache_read_input_tokens: 1536, cache_creation_input_tokens: 0, output_tokens: 52 },
    total_cost_usd: 0.033724,
  });

describe("parseGrokResult", () => {
  it("reads the summary, tokens and cost", () => {
    expect(parseGrokResult(result("end_turn"), 0, 1000)).toEqual({
      ok: true,
      summary: "已加上数字规则。",
      durationMs: 1000,
      costUsd: 0.033724,
      inputTokens: 17858,
      outputTokens: 52,
    });
  });

  it("is not ok when the run was cancelled, e.g. a permission it could not get", () => {
    expect(parseGrokResult(`permission required: …\n${result("cancelled")}`, 0, 1).ok).toBe(false);
  });
});
