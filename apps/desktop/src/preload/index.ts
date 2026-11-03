import { contextBridge, ipcRenderer } from "electron";
import type { Checkpoint } from "@loom/core";
import type { Canvas, LoomEvent, Memory, Verdict } from "@loom/schema";

export type EventRecord = { event: LoomEvent; verdict: Verdict };

const api = {
  info: (): Promise<{ root: string; port: number; hasGit: boolean; activeNodeId: string | null }> =>
    ipcRenderer.invoke("loom:info"),
  checkpoints: (): Promise<Checkpoint[]> => ipcRenderer.invoke("loom:checkpoints"),
  checkpoint: (label: string): Promise<Checkpoint> => ipcRenderer.invoke("loom:checkpoint", label),
  rollback: (id: string): Promise<boolean> => ipcRenderer.invoke("loom:rollback", id),
  memories: (): Promise<Memory[]> => ipcRenderer.invoke("loom:memories"),
  addMemory: (nodeId: string | null, kind: Memory["kind"], content: string): Promise<Memory | null> =>
    ipcRenderer.invoke("loom:addMemory", nodeId, kind, content),
  setMemoryStatus: (id: string, status: Memory["status"]): Promise<Memory> =>
    ipcRenderer.invoke("loom:setMemoryStatus", id, status),
  exportSkill: (nodeId: string): Promise<string> => ipcRenderer.invoke("loom:exportSkill", nodeId),
  onMemoryDrafts(cb: (drafts: Memory[]) => void) {
    const listener = (_e: unknown, drafts: Memory[]) => cb(drafts);
    ipcRenderer.on("loom:memoryDrafts", listener);
    return () => void ipcRenderer.off("loom:memoryDrafts", listener);
  },
  canvas: (): Promise<Canvas> => ipcRenderer.invoke("loom:canvas"),
  setActive: (nodeId: string | null): Promise<void> => ipcRenderer.invoke("loom:setActive", nodeId),
  installHooks: (): Promise<string[]> => ipcRenderer.invoke("loom:installHooks"),
  dispatch: (nodeId: string, task: string, agent: "claude-code" | "codex"): Promise<string> =>
    ipcRenderer.invoke("loom:dispatch", nodeId, task, agent),
  onEvent(cb: (record: EventRecord) => void) {
    const listener = (_e: unknown, record: EventRecord) => cb(record);
    ipcRenderer.on("loom:event", listener);
    return () => void ipcRenderer.off("loom:event", listener);
  },
  onActive(cb: (nodeId: string | null) => void) {
    const listener = (_e: unknown, nodeId: string | null) => cb(nodeId);
    ipcRenderer.on("loom:active", listener);
    return () => void ipcRenderer.off("loom:active", listener);
  },
};

export type LoomApi = typeof api;

contextBridge.exposeInMainWorld("loom", api);
