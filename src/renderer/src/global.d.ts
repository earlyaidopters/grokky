import type { GrokkyApi } from "../../shared/contracts";

declare global {
  interface Window {
    grokky: GrokkyApi;
  }
}

export {};
