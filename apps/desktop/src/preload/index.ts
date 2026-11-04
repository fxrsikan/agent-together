import type { EvolutionReport, Experience, SetupReport } from "@agent-together/core";
import { contextBridge, ipcRenderer } from "electron";
import type { AuditResult, CanvasPlan, Checkpoint, CompileReport, Judgment, ProjectInfo, RaceReport, TestHistory, TestRun } from "@agent-together/core";
import type { AgentEvent, Canvas, CanvasEdge, CanvasNode, Memory, RunResult, Verdict } from "@agent-together/schema";

export type EventRecord = { event: AgentEvent; verdict: Verdict };
export type { Judgment, RaceReport, RunResult, TestHistory, TestRun };
export type { AuditResult };
export type AgentRunOutcome = { run: RunResult; tests: TestRun | null; checkpoint: Checkpoint | null; audit: AuditResult | null };
export type Agent = "claude-code" | "codex" | "cursor" | "grok-build";
export type SessionInfo = { root: string; name: string; port: number; hasGit: boolean; l2: string | null; activeNodeId: string | null };

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`agent-together:${channel}`, ...args);

/** Subscribes to a push from the main process; returns the unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(`agent-together:${channel}`, listener);
  return () => void ipcRenderer.off(`agent-together:${channel}`, listener);
}

const api = {
  // First-launch setup wizard (completion is stored in the app's userData)
  setupCheck: () => invoke<SetupReport>("setupCheck"),
  setupCompleted: () => invoke<boolean>("setupCompleted"),
  setupMarkDone: () => invoke<void>("setupMarkDone"),
  setupOpenTerminal: (id: string) => invoke<void>("setupOpenTerminal", id),
  setupCopy: (text: string) => invoke<void>("setupCopy", text),

  // Projects
  recentProjects: () => invoke<{ root: string; name: string; exists: boolean }[]>("recentProjects"),
  chooseFolder: (title: string) => invoke<string | null>("chooseFolder", title),
  createProject: (parent: string, name: string, description: string) => invoke<SessionInfo>("createProject", parent, name, description),
  openProject: (dir: string) => invoke<SessionInfo>("openProject", dir),
  closeProject: () => invoke<void>("closeProject"),
  info: () => invoke<SessionInfo | null>("info"),
  projectInfo: () => invoke<ProjectInfo>("projectInfo"),
  saveProjectInfo: (patch: { description?: string; stack?: string; testCommand?: string }) => invoke<ProjectInfo>("saveProjectInfo", patch),
  onProject: (cb: (info: SessionInfo) => void) => on("project", cb),
  recentLog: () => invoke<{ events: EventRecord[]; judgments: Judgment[] }>("recentLog"),

  // Canvas
  canvas: () => invoke<Canvas>("canvas"),
  planCanvas: (description: string) => invoke<CanvasPlan>("planCanvas", description),
  addNode: (title: string, kind: CanvasNode["kind"], position?: { x: number; y: number }) => invoke<CanvasNode>("addNode", title, kind, position),
  saveNode: (node: CanvasNode) => invoke<CanvasNode>("saveNode", node),
  moveNodes: (moves: { id: string; x: number; y: number }[]) => invoke<void>("moveNodes", moves),
  deleteNode: (id: string) => invoke<boolean>("deleteNode", id),
  saveEdges: (edges: CanvasEdge[]) => invoke<CanvasEdge[]>("saveEdges", edges),
  onCanvasChanged: (cb: () => void) => on("canvasChanged", cb),

  // Agents
  setActive: (nodeId: string | null) => invoke<void>("setActive", nodeId),
  installHooks: () => invoke<string[]>("installHooks"),
  dispatch: (nodeId: string, task: string, agent: Agent, context?: string) => invoke<string>("dispatch", nodeId, task, agent, context),
  runAgent: (nodeId: string, task: string, agent: Agent, context?: string) => invoke<AgentRunOutcome>("runAgent", nodeId, task, agent, context),
  stopAgent: () => invoke<void>("stopAgent"),
  onAgentText: (cb: (e: { nodeId: string; text: string }) => void) => on("agentText", cb),
  onAgentStatus: (cb: (e: { nodeId: string; agent: Agent; state: "running" | "testing" | "idle" }) => void) => on("agentStatus", cb),
  runTests: (nodeId: string | null) => invoke<{ tests: TestRun | null; checkpoint: Checkpoint | null; audit: AuditResult | null }>("runTests", nodeId),
  testHistory: () => invoke<TestHistory>("testHistory"),
  testCommand: () => invoke<string | null>("testCommand"),
  onTests: (cb: (run: TestRun | null) => void) => on("tests", cb),
  previewContext: (nodeId: string, task: string, without: string[]) =>
    invoke<{ markdown: string; memories: Memory[] }>("previewContext", nodeId, task, without),
  measureContext: (markdown: string) => invoke<{ tokens: number; sections: { title: string; tokens: number }[] }>("measureContext", markdown),
  onEvent: (cb: (record: EventRecord) => void) => on("event", cb),
  onActive: (cb: (nodeId: string | null) => void) => on("active", cb),
  onJudgment: (cb: (j: Judgment) => void) => on("judgment", cb),
  onL2Error: (cb: (message: string) => void) => on("l2error", cb),

  // Memories and capabilities
  memories: () => invoke<Memory[]>("memories"),
  addMemory: (nodeId: string | null, kind: Memory["kind"], content: string) => invoke<Memory | null>("addMemory", nodeId, kind, content),
  setMemoryStatus: (id: string, status: Memory["status"]) => invoke<Memory>("setMemoryStatus", id, status),
  onMemoryDrafts: (cb: (drafts: Memory[]) => void) => on("memoryDrafts", cb),
  exportCapability: (nodeId: string) => invoke<CompileReport>("exportCapability", nodeId),
  compileCapabilities: () => invoke<CompileReport[]>("compileCapabilities"),

  evolutions: () => invoke<{ reports: EvolutionReport[]; running: string | null; agents: string[]; candidate: Record<string, number>; suggestions: Experience[] }>("evolutions"),
  evolve: (nodeId: string, task: string, agent: string) => invoke<EvolutionReport>("evolve", nodeId, task, agent),
  approveEvolution: (id: string, adopt: boolean) => invoke<EvolutionReport>("approveEvolution", id, adopt),
  discardEvolution: (id: string) => invoke<void>("discardEvolution", id),
  approveExperience: (id: string, nodeId: string) => invoke<void>("approveExperience", id, nodeId),
  // Checkpoints and races
  checkpoints: () => invoke<Checkpoint[]>("checkpoints"),
  checkpoint: (label: string) => invoke<Checkpoint>("checkpoint", label),
  rollback: (id: string) => invoke<boolean>("rollback", id),
  races: () => invoke<{ running: string | null; reports: RaceReport[]; agents: string[] }>("races"),
  race: (nodeId: string, task: string, context?: string) => invoke<RaceReport>("race", nodeId, task, context),
  adoptRace: (id: string, contestantId: string) => invoke<boolean>("adoptRace", id, contestantId),
  discardRace: (id: string) => invoke<void>("discardRace", id),
  onRaceProgress: (cb: (message: string) => void) => on("raceProgress", cb),
};

export type AgentTogetherApi = typeof api;

contextBridge.exposeInMainWorld("agentTogether", api);
