import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ProviderRunContext } from "../src/main/providers/types";
import { requestsAgentProposal, proposalFromRequest, normalizeAgentProposal } from "../src/shared/agent-proposals";
const observed = vi.hoisted(() => ({ agents: [] as string[] }));
vi.mock("../src/main/credentials", () => ({ resolveOpenRouterCredential: async () => null,
  providerStatuses: async () => [{ id: "codex", ready: true, label: "Fixture", source: "Fixture", detail: "Fixture" }] }));
vi.mock("../src/main/providers/codex-provider", () => ({ runCodex: async (context: ProviderRunContext) => {
  observed.agents = context.agents.map((agent) => agent.id);
  await context.onEvent({ type: "final", text: "A fixture result from the selected role." });
} }));
import { MainController } from "../src/main/controller";
import { StateStore } from "../src/main/state-store";

for (const text of ["Create a new naming specialist", "Recommend an agent to review this codebase", "Propose a custom agent called launch_scout"]) {
  test(`role intent: ${text}`, () => expect(requestsAgentProposal(text)).toBe(true));
}
for (const text of ["Do not create a new agent", "Please spin up two agents", "Create an agent application with an API", "Build a website", "Ask explorer to inspect this file"]) {
  test(`ordinary task: ${text}`, () => expect(requestsAgentProposal(text)).toBe(false));
}
test("invalid persisted proposals are discarded", () => {
  expect(normalizeAgentProposal({ id: "bad", status: "proposed", draft: { name: "../secret" } })).toBeUndefined();
});
test("recommendations use only matching definitions in the supplied catalog", () => {
  const proposal = proposalFromRequest("Recommend an explorer agent", [{ id: "known", name: "explorer", description: "Read-heavy codebase explorer", developerInstructions: "Inspect the task", scope: "built-in", builtIn: true }], "proposal-test");
  expect(proposal.matchedAgentId).toBe("known");
  expect(proposal.draft.developerInstructions).toBe("Inspect the task");
});
test("review, one-turn use, save and dismiss remain distinct through persistence", async () => {
  const home = await mkdtemp(join(tmpdir(), "grokky-proposal-"));
  const store = new StateStore(join(home, "state.json"), home);
  const controller = new MainController(store, home, "fixture");
  try {
    await controller.initialize(); await controller.updateSettings({ multiAgentEnabled: true });
    const conversationId = controller.snapshot().activeConversationId!;
    const current = () => controller.snapshot().conversations.find((entry) => entry.id === conversationId)!;
    await controller.sendMessage(conversationId, "Create a new naming specialist called garden_scout");
    const proposal = current().messages.at(-1)!.agentProposal!;
    expect(proposal.status).toBe("proposed"); expect(current().agentRuns).toHaveLength(0);
    expect((await controller.getAgents()).some((agent) => agent.name === "garden_scout")).toBe(false);
    const loaded = (await store.load()).conversations.find((entry) => entry.id === conversationId)!;
    expect(loaded.messages.at(-1)?.agentProposal?.id).toBe(proposal.id);
    await controller.resolveAgentProposal(conversationId, proposal.id, "use", proposal.draft);
    expect(current().pendingAgent?.name).toBe("garden_scout");
    expect((await store.load()).conversations.find((entry) => entry.id === conversationId)?.pendingAgent?.name).toBe("garden_scout");
    await expect(controller.resolveAgentProposal(conversationId, proposal.id, "use", proposal.draft)).rejects.toThrow("already");
    await controller.sendMessage(conversationId, "Suggest a fictional club name");
    await vi.waitFor(() => expect(current().pendingAgent).toBeUndefined());
    expect(observed.agents).toContain(`task:${proposal.id}`);
    expect(current().selectedAgentIds).not.toContain(`task:${proposal.id}`);
    await controller.sendMessage(conversationId, "Create a new naming specialist called reusable_scout");
    const saved = current().messages.at(-1)!.agentProposal!;
    await controller.resolveAgentProposal(conversationId, saved.id, "save", saved.draft);
    expect((await controller.getAgents()).some((agent) => agent.name === "reusable_scout")).toBe(true);
    expect(current().pendingAgent).toBeUndefined();
    await controller.sendMessage(conversationId, "Create a new naming specialist");
    const dismissed = current().messages.at(-1)!.agentProposal!;
    await controller.resolveAgentProposal(conversationId, dismissed.id, "dismiss", dismissed.draft);
    expect(current().messages.at(-1)?.agentProposal?.status).toBe("dismissed");
  } finally { await controller.shutdown(); await rm(home, { recursive: true, force: true }); }
});

test("one-time role limits and project-save validation preserve the unresolved proposal", async () => {
  const home = await mkdtemp(join(tmpdir(), "grokky-proposal-limits-"));
  const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "fixture");
  try {
    await controller.initialize();
    const cid = controller.snapshot().activeConversationId!;
    await controller.sendMessage(cid, "Create a new interface reviewer agent");
    const proposal = controller.snapshot().conversations.find(c => c.id === cid)!.messages.at(-1)!.agentProposal!;
    await controller.updateSettings({ multiAgentEnabled: false });
    await expect(controller.resolveAgentProposal(cid, proposal.id, "use", proposal.draft)).rejects.toThrow("Enable multi-agent");
    await expect(controller.resolveAgentProposal(cid, proposal.id, "save", { ...proposal.draft, scope: "project" })).rejects.toThrow("Choose a project");
    await expect(controller.resolveAgentProposal(cid, proposal.id, "use", { ...proposal.draft, name: "" })).rejects.toThrow("role name");
    await controller.updateSettings({ multiAgentEnabled: true, maxAgentThreads: 1 });
    await controller.updateConversation(cid, { selectedAgentIds: [(await controller.getAgents())[0]!.id] });
    await expect(controller.resolveAgentProposal(cid, proposal.id, "use", proposal.draft)).rejects.toThrow("full");
    await controller.resolveAgentProposal(cid, proposal.id, "dismiss", { ...proposal.draft, name: "" });
    expect(controller.snapshot().conversations.find(c => c.id === cid)!.messages.at(-1)!.agentProposal?.status).toBe("dismissed");
  } finally { await controller.shutdown(); await rm(home, { recursive: true, force: true }); }
});
