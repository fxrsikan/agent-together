import { contextBridge, ipcRenderer } from "electron";
import type { Canvas, LoomEvent, Verdict } from "@loom/schema";

export type EventRecord = { event: LoomEvent; verdict: Verdict };

const api = {
  info: (): Promise<{ root: string; port: number; activeNodeId: string | null }> => ipcRenderer.invoke("loom:info"),
  canvas: (): Promise<Canvas> => ipcRenderer.invoke("loom:canvas"),
  setActive: (nodeId: string | null): Promise<void> => ipcRenderer.invoke("loom:setActive", nodeId),
  installHooks: (): Promise<string> => ipcRenderer.invoke("loom:installHooks"),
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
