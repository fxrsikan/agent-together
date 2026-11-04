import type { AgentTogetherApi } from "../../preload";

declare global {
  interface Window {
    agentTogether: AgentTogetherApi;
  }
}
