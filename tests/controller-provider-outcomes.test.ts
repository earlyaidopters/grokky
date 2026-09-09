import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ProviderRunContext } from "../src/main/providers/types";
vi.mock("../src/main/credentials", () => ({
  resolveOpenRouterCredential: async () => null,
  providerStatuses: async () => [{ id: "codex", ready: true, label: "Fixture", source: "Fixture", detail: "Fixture" }],
}));
vi.mock("../src/main/providers/codex-provider", () => ({
  runCodex: async (context: ProviderRunContext) => { await context.onEvent({ type: "final", text: "I cannot complete this request with the available capabilities." }); },
}));
import { MainController } from "../src/main/controller";
import { StateStore } from "../src/main/state-store";

test("blocked provider final stays blocked in chat, Watch and reloaded state", async () => {
  const home = await mkdtemp(join(tmpdir(), "grokky-outcome-"));
  try {
    const store = new StateStore(join(home, "state.json"), home);
    const controller = new MainController(store, home, "fixture");
    await controller.initialize();
    const id = controller.snapshot().activeConversationId!;
    await controller.updateSettings({ multiAgentEnabled: false });
    await controller.sendMessage(id, "Suggest a club name");
    await vi.waitFor(() => expect(controller.snapshot().conversations.find((entry) => entry.id === id)?.status).toBe("idle"));
    const final = controller.snapshot().conversations.find((entry) => entry.id === id)!;
    expect(final.lastRunOutcome).toBe("blocked");
    expect(final.agentComputers?.find((computer) => computer.role === "lead")?.status).toBe("blocked");
    await vi.waitFor(async () => {
      const loaded = (await store.load()).conversations.find((entry) => entry.id === id)!;
      expect(loaded.agentComputers?.find((computer) => computer.role === "lead")?.status).toBe("blocked");
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
