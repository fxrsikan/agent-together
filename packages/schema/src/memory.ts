import { z } from "zod";

export const MemoryKind = z.enum(["decision", "constraint", "pitfall", "preference"]);

/** Drafts wait for a human; only active memories reach agents. Rejected ones are kept so they are not drafted again. */
export const MemoryStatus = z.enum(["draft", "active", "rejected", "expired"]);

export const Memory = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The node it belongs to; null = applies to the whole project. */
  nodeId: z.string().nullable(),
  kind: MemoryKind,
  status: MemoryStatus,
  content: z.string().min(1),
  /** Where it came from, e.g. "observer:design-guard session 1a2b" or "user". */
  source: z.string(),
  createdAt: z.string(),
  /** The raw observation a refined memory was written from, kept for review. */
  evidence: z.string().optional(),
  /**
   * The assistant and model a memory was proven with ("claude-code/haiku", or just
   * "claude-code" for its default model), e.g. by evolution. Unset: applies to any.
   * Kept out of the text so it costs no tokens; dispatches with another model leave it out.
   */
  verifiedWith: z.string().optional(),
});
export type Memory = z.infer<typeof Memory>;
