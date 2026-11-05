import { describe, expect, it } from "vitest";
import { findCards, reachFrom } from "../src/renderer/src/reach";

// cli → commands → store → model, commands → model, plus a loop back model → cli.
const links = [
  { from: "cli", to: "commands" },
  { from: "commands", to: "store" },
  { from: "commands", to: "model" },
  { from: "store", to: "model" },
];

describe("reachFrom", () => {
  it("follows links forward for what a card builds on", () => {
    const r = reachFrom("cli", links, "deps");
    expect([...r.nodes].sort()).toEqual(["commands", "model", "store"]);
    expect(r.edges.size).toBe(4);
    expect(r.hops).toBe(2); // model is two links away by the shortest way
  });

  it("follows links backward for what builds on a card", () => {
    const r = reachFrom("model", links, "dependents");
    expect([...r.nodes].sort()).toEqual(["cli", "commands", "store"]);
    expect(r.hops).toBe(2);
  });

  it("stops on loops and reports nothing for a leaf", () => {
    const loop = [...links, { from: "model", to: "cli" }];
    expect(reachFrom("cli", loop, "deps").nodes.size).toBe(3);
    expect(reachFrom("cli", links, "dependents")).toEqual({ nodes: new Set(), edges: new Set(), hops: 0 });
  });
});

describe("findCards", () => {
  const cards = [
    { id: "store", title: "笔记存储", files: ["src/store/**"] },
    { id: "search", title: "全文搜索", files: ["src/search/**"] },
    { id: "cli", title: "命令行入口", files: ["bin/**"] },
  ];
  it("matches title, id and files, title starts first", () => {
    expect(findCards(cards, "搜索").map((c) => c.id)).toEqual(["search"]);
    expect(findCards(cards, "笔记").map((c) => c.id)).toEqual(["store"]);
    expect(findCards(cards, "bin").map((c) => c.id)).toEqual(["cli"]);
    expect(findCards(cards, "  ")).toEqual([]);
  });
});
