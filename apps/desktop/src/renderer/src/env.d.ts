import type { LoomApi } from "../../preload";

declare global {
  interface Window {
    loom: LoomApi;
  }
}
