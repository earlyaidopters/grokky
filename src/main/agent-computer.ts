export interface AgentBrowserRequest {
  sessionId: string;
  url: string;
  networkAllowlist: string[];
  approvedTarget: boolean;
  signal?: AbortSignal;
}

export interface AgentBrowserResult {
  output: string;
  currentUrl: string;
  pageTitle: string;
  evidencePath: string;
  evidenceSha256: string;
}

export interface AgentBrowserHost {
  available: boolean;
  browse(request: AgentBrowserRequest): Promise<AgentBrowserResult>;
  importEvidence(pathname: string, sessionId: string): Promise<{ evidencePath: string; evidenceSha256: string }>;
  storeEvidence?(bytes: Uint8Array, sessionId: string): Promise<{ evidencePath: string; evidenceSha256: string }>;
  removeEvidence(pathname: string): Promise<void>;
  disposeSession(sessionId: string): void;
  disposeAll(): void;
}

export function unavailableAgentBrowserHost(): AgentBrowserHost {
  return {
    available: false,
    browse: async () => { throw new Error("Isolated agent browsing is unavailable in this runtime"); },
    importEvidence: async () => { throw new Error("Agent evidence storage is unavailable in this runtime"); },
    storeEvidence: async () => { throw new Error("Agent evidence storage is unavailable in this runtime"); },
    removeEvidence: async () => undefined,
    disposeSession: () => undefined,
    disposeAll: () => undefined,
  };
}
