import { z } from "zod";

/**
 * The requirements of one product version, as the user confirmed them. See the
 * design doc, phase one: "核心数据：使用场景". Stored in .agent-together/spec/.
 */

/** unverified → mock-passed (flow works with sample services) → real-passed (with the real services) | failed. */
export const ScenarioStatus = z.enum(["unverified", "mock-passed", "real-passed", "failed"]);
export type ScenarioStatus = z.infer<typeof ScenarioStatus>;

export const VerifyBy = z.enum(["browser", "api", "file"]);
export type VerifyBy = z.infer<typeof VerifyBy>;

const lines = z.array(z.string()).default([]);

/** One way a user completes the product's business: the version's unit of "done". */
export const Scenario = z.object({
  /** Stable: tasks, cards and acceptance records refer to it. "S-01", "S-02", … */
  id: z.string().regex(/^S-\d{2,}$/, "scenario id looks like S-01"),
  name: z.string().min(1),
  /** Includes whether the services are real or sample ones. */
  preconditions: lines,
  /** A fixed sample input; the expected results are written for it. */
  input: z.string().default(""),
  steps: lines,
  expected: lines,
  /** After saving, refreshing or restarting: is the data still right? */
  dataChecks: lines,
  /** What the user sees when something fails. */
  errorChecks: lines,
  verify: z.array(VerifyBy).default(["browser"]),
  /** Ids of the cards that implement it. */
  tasks: lines,
  status: ScenarioStatus.default("unverified"),
});
export type Scenario = z.infer<typeof Scenario>;

export const SpecPage = z.object({ name: z.string().min(1), purpose: z.string().default("") });
export const SpecService = z.object({
  name: z.string().min(1),
  purpose: z.string().default(""),
  /** Sample implementation first; the real one is switched in by configuration. */
  mode: z.enum(["mock", "real"]).default("mock"),
});

export const Spec = z.object({
  /** The version this spec describes: 1 for the first version. */
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "confirmed"]).default("draft"),
  confirmedAt: z.string().optional(),
  /** The user tried the sample-data prototype and said the pages and flow are right (M2). */
  prototypeConfirmedAt: z.string().optional(),
  /** Phase one builds local web apps only: one user, data on this machine, runs on this machine. */
  productType: z.literal("local-web-app").default("local-web-app"),
  /** Who uses it. */
  audience: z.string().default(""),
  /** The main business, in a sentence or two. */
  goal: z.string().default(""),
  inScope: lines,
  outOfScope: lines,
  pages: z.array(SpecPage).default([]),
  /** How the pages connect, step by step. */
  flow: lines,
  /** How data is kept. */
  data: z.string().default(""),
  services: z.array(SpecService).default([]),
  scenarios: z.array(Scenario).default([]),
});
export type Spec = z.infer<typeof Spec>;

/** A question the product manager asks, with answers to click; the recommended one first. */
export const SpecQuestion = z.object({
  id: z.string(),
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
  why: z.string().optional(),
});
export type SpecQuestion = z.infer<typeof SpecQuestion>;

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string(),
  questions: z.array(SpecQuestion).optional(),
  /** The assistant thinks it knows enough to write the requirements. */
  ready: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** A decision the user made, kept apart from the chat so it is not lost in it. */
export const Decision = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["confirm-scope", "change-scope", "migrate-canvas", "confirm-prototype", "prototype-feedback", "other"]),
  summary: z.string(),
  detail: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;
