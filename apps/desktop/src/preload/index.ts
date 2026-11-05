import type { CheckedSource, EvolutionReport, Experience, ImportProposal, ModelChoice, ProposedCard, ProposedItem, SetupReport } from "@agent-together/core";
import { contextBridge, ipcRenderer } from "electron";
import type { AuditResult, CanvasPlan, Checkpoint, CompileReport, Judgment, ProjectInfo, RaceReport, TestHistory, TestRun } from "@agent-together/core";
import type { AgentEvent, Capability, Canvas, CanvasEdge, CanvasNode, Memory, RunResult, Verdict } from "@agent-together/schema";

export type EventRecord = { event: AgentEvent; verdict: Verdict };
export type { Judgment, RaceReport, RunResult, TestHistory, TestRun };
export type { AuditResult };
export type AgentRunOutcome = { run: RunResult; tests: TestRun | null; checkpoint: Checkpoint | null; audit: AuditResult | null };
export type Agent = "claude-code" | "codex" | "cursor" | "grok-build";
/** Where an imported project stands: what the checklist still has to offer. */
export type ImportStatus = {
  imported: boolean;
  reviewed: boolean;
  hasGit: boolean;
  cards: number;
  /** Cards without a goal yet. */
  emptyCards: number;
  testCommand: string | null;
  /** A test command guessed from the files, "" when none fits. */
  guessedTest: string;
  helper: string | null;
};
export type { CheckedSource, ImportProposal, ProposedCard, ProposedItem };
/** The helper model (canvas plans, roles, evolution strategies, review); `name` is what runs now, null when none. */
export type LlmSettings = { provider: "auto" | "off" | "anthropic" | "claude-cli" | "openai-compatible"; model: string; baseUrl: string; name: string | null };
/** What the context inspector shows: the text, which memories go in, and what they cost. */
export type ContextPreview = {
  markdown: string;
  memories: Memory[];
  /** Ids left out this time (by default: proven with another assistant or model). */
  without: string[];
  /** The assistant and model this dispatch uses, for people ("Claude Code · haiku"). */
  verifier: string;
  /** Per memory id, what it was proven with, when it says. */
  labels: Record<string, string>;
  memoryTokens: number;
  /** Project-wide memories also mirrored into CLAUDE.md / AGENTS.md. */
  mirroredTokens: number;
};
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
  listModels: (refresh?: boolean) => invoke<Record<string, ModelChoice[]>>("listModels", refresh),
  projectModels: () => invoke<Record<string, string>>("projectModels"),
  llmSettings: () => invoke<LlmSettings>("llmSettings"),
  importStatus: () => invoke<ImportStatus>("importStatus"),
  /** The helper model reads the code and proposes card descriptions; nothing is saved. */
  understandProject: (only?: string) => invoke<ImportProposal>("understandProject", only),
  /** Cards whose description was written from code that changed since: id -> changed files. */
  staleCards: () => invoke<Record<string, string[]>>("staleCards"),
  applyImportProposal: (proposal: ImportProposal, chosen: string[]) => invoke<void>("applyImportProposal", proposal, chosen),
  /** git init (no commit), then the project reopens with checkpoints on. */
  initGit: () => invoke<SessionInfo>("initGit"),
  reviewImport: () => invoke<unknown>("reviewImport"),
  /** Saves the helper model and reopens the project with it; resolves to the new session. */
  saveLlmSettings: (settings: Omit<LlmSettings, "name">) => invoke<SessionInfo>("saveLlmSettings", settings),
  saveProjectModels: (models: Record<string, string>) => invoke<Record<string, string>>("saveProjectModels", models),
  saveProjectInfo: (patch: { description?: string; stack?: string; testCommand?: string }) => invoke<ProjectInfo>("saveProjectInfo", patch),
  onProject: (cb: (info: SessionInfo) => void) => on("project", cb),
  recentLog: () => invoke<{ events: EventRecord[]; judgments: Judgment[] }>("recentLog"),

  roles: () => invoke<Capability[]>("roles"),
  draftRole: (sentence: string) => invoke<Capability>("draftRole", sentence),
  saveRole: (role: Capability) => invoke<Capability>("saveRole", role),

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
  /** `without` null: leave out the memories proven with another assistant or model than `agent` uses. */
  previewContext: (nodeId: string, task: string, without: string[] | null, agent: string) =>
    invoke<ContextPreview>("previewContext", nodeId, task, without, agent),
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

  /** `agent`: list the experiences proven with its current model first. */
  evolutions: (agent?: string) => invoke<{ reports: EvolutionReport[]; running: string | null; agents: string[]; candidate: Record<string, number>; suggestions: Experience[] }>("evolutions", agent),
  evolve: (nodeId: string, task: string, agent: string) => invoke<EvolutionReport>("evolve", nodeId, task, agent),
  approveEvolution: (id: string, adopt: boolean) => invoke<EvolutionReport>("approveEvolution", id, adopt),
  discardEvolution: (id: string) => invoke<void>("discardEvolution", id),
  approveExperience: (id: string, nodeId: string) => invoke<void>("approveExperience", id, nodeId),
  // Checkpoints and races
  checkpoints: () => invoke<Checkpoint[]>("checkpoints"),
  checkpoint: (label: string) => invoke<Checkpoint>("checkpoint", label),
  rollback: (id: string) => invoke<boolean>("rollback", id),
  /** `agents`: who races now; `all`: every assistant that can. */
  races: () => invoke<{ running: string | null; reports: RaceReport[]; agents: string[]; all: string[] }>("races"),
  saveRaceAgents: (agents: string[]) => invoke<string[]>("saveRaceAgents", agents),
  race: (nodeId: string, task: string, context?: string) => invoke<RaceReport>("race", nodeId, task, context),
  adoptRace: (id: string, contestantId: string) => invoke<boolean>("adoptRace", id, contestantId),
  discardRace: (id: string) => invoke<void>("discardRace", id),
  onRaceProgress: (cb: (message: string) => void) => on("raceProgress", cb),
};

export type AgentTogetherApi = typeof api;

contextBridge.exposeInMainWorld("agentTogether", api);
