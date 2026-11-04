import { contextBridge, ipcRenderer } from "electron";
import type { Checkpoint, CompileReport, Judgment, RaceReport } from "@agent-together/core";
import type { Canvas, AgentEvent, Memory, Verdict } from "@agent-together/schema";

export type EventRecord = { event: AgentEvent; verdict: Verdict };
export type { Judgment, RaceReport };

const api = {
  info: (): Promise<{ root: string; port: number; hasGit: boolean; l2: string | null; activeNodeId: string | null }> =>
    ipcRenderer.invoke("agent-together:info"),
  onJudgment(cb: (j: Judgment) => void) {
    const listener = (_e: unknown, j: Judgment) => cb(j);
    ipcRenderer.on("agent-together:judgment", listener);
    return () => void ipcRenderer.off("agent-together:judgment", listener);
  },
  onL2Error(cb: (message: string) => void) {
    const listener = (_e: unknown, message: string) => cb(message);
    ipcRenderer.on("agent-together:l2error", listener);
    return () => void ipcRenderer.off("agent-together:l2error", listener);
  },
  checkpoints: (): Promise<Checkpoint[]> => ipcRenderer.invoke("agent-together:checkpoints"),
  checkpoint: (label: string): Promise<Checkpoint> => ipcRenderer.invoke("agent-together:checkpoint", label),
  rollback: (id: string): Promise<boolean> => ipcRenderer.invoke("agent-together:rollback", id),
  memories: (): Promise<Memory[]> => ipcRenderer.invoke("agent-together:memories"),
  addMemory: (nodeId: string | null, kind: Memory["kind"], content: string): Promise<Memory | null> =>
    ipcRenderer.invoke("agent-together:addMemory", nodeId, kind, content),
  setMemoryStatus: (id: string, status: Memory["status"]): Promise<Memory> =>
    ipcRenderer.invoke("agent-together:setMemoryStatus", id, status),
  exportCapability: (nodeId: string): Promise<CompileReport> => ipcRenderer.invoke("agent-together:exportCapability", nodeId),
  compileCapabilities: (): Promise<CompileReport[]> => ipcRenderer.invoke("agent-together:compileCapabilities"),
  onMemoryDrafts(cb: (drafts: Memory[]) => void) {
    const listener = (_e: unknown, drafts: Memory[]) => cb(drafts);
    ipcRenderer.on("agent-together:memoryDrafts", listener);
    return () => void ipcRenderer.off("agent-together:memoryDrafts", listener);
  },
  races: (): Promise<{ running: string | null; reports: RaceReport[]; agents: string[] }> => ipcRenderer.invoke("agent-together:races"),
  race: (nodeId: string, task: string, context?: string): Promise<RaceReport> =>
    ipcRenderer.invoke("agent-together:race", nodeId, task, context),
  previewContext: (nodeId: string, task: string, without: string[]): Promise<{ markdown: string; memories: Memory[] }> =>
    ipcRenderer.invoke("agent-together:previewContext", nodeId, task, without),
  measureContext: (markdown: string): Promise<{ tokens: number; sections: { title: string; tokens: number }[] }> =>
    ipcRenderer.invoke("agent-together:measureContext", markdown),
  adoptRace: (id: string, contestantId: string): Promise<boolean> => ipcRenderer.invoke("agent-together:adoptRace", id, contestantId),
  discardRace: (id: string): Promise<void> => ipcRenderer.invoke("agent-together:discardRace", id),
  onRaceProgress(cb: (message: string) => void) {
    const listener = (_e: unknown, message: string) => cb(message);
    ipcRenderer.on("agent-together:raceProgress", listener);
    return () => void ipcRenderer.off("agent-together:raceProgress", listener);
  },
  canvas: (): Promise<Canvas> => ipcRenderer.invoke("agent-together:canvas"),
  setActive: (nodeId: string | null): Promise<void> => ipcRenderer.invoke("agent-together:setActive", nodeId),
  installHooks: (): Promise<string[]> => ipcRenderer.invoke("agent-together:installHooks"),
  dispatch: (nodeId: string, task: string, agent: "claude-code" | "codex", context?: string): Promise<string> =>
    ipcRenderer.invoke("agent-together:dispatch", nodeId, task, agent, context),
  onEvent(cb: (record: EventRecord) => void) {
    const listener = (_e: unknown, record: EventRecord) => cb(record);
    ipcRenderer.on("agent-together:event", listener);
    return () => void ipcRenderer.off("agent-together:event", listener);
  },
  onActive(cb: (nodeId: string | null) => void) {
    const listener = (_e: unknown, nodeId: string | null) => cb(nodeId);
    ipcRenderer.on("agent-together:active", listener);
    return () => void ipcRenderer.off("agent-together:active", listener);
  },
};

export type AgentTogetherApi = typeof api;

contextBridge.exposeInMainWorld("agentTogether", api);
