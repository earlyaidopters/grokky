import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainController } from "./controller";
import { HandoffGate } from "./handoff-gate";
import { StateStore, type PersistentState, type PersistedComputerAccess } from "./state-store";
import type { ComputerAccessService, ComputerToolName } from "./computer-access";
import type { Conversation } from "../shared/contracts";
import type { PhoneFrame, PhoneSnapshot, PhoneCommand } from "../shared/phone";

/** Installed-app canary: real controller + paired gateway, disposable state and browser seat, no model calls. */
export async function runPhoneSmoke(access: PersistedComputerAccess, service: ComputerAccessService, home: string, version: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "grokky-phone-canary-"));
  const controller = new MainController(new StateStore(join(directory, "state.json"), directory), home, version, service);
  // Test-only seam: simulate a running provider while exercising production phone methods unchanged.
  const internals = controller as unknown as { state: PersistentState; runs: Map<string, AbortController>; handoffs: Map<string, HandoffGate>; phoneFrame?: PhoneFrame; initializeAgentComputers(conversation: Conversation, agents: []): void };
  let room = "", phoneToken = "", origin = "";
  async function phone(route: string, body: unknown, expected = 200) {
    const response = await fetch(`${origin}/companion/phone/${room}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${phoneToken}`, Origin: origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as { error?: string; token?: string; snapshot?: PhoneSnapshot; receipt?: { ok: boolean; detail: string } };
    assert.equal(response.status, expected, result.error || `Phone ${route} failed`);
    return result;
  }
  async function until(check: () => Promise<boolean>, label: string, ms = 45_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 600)); }
    throw new Error(`Timed out: ${label}`);
  }
  try {
    await controller.initialize();
    internals.state.computerAccess = structuredClone(access);
    const state = internals.state.computerAccess;
    const device = state.remoteDevices.find((item) => item.platform === "cloudflare-linux" && !item.revoked);
    assert.ok(device, "Pair a cloud computer before running the phone canary");
    state.activeDeviceId = device.id; state.enabled = true;
    state.grants = { files: "allow", commands: "allow", browser: "allow", screen: "allow", automation: "allow", external: "allow" };
    assert.ok(await service.heartbeat(state), "Cloud device heartbeat failed");
    const conversationId = await controller.createConversation();
    const conversation = internals.state.conversations.find((item) => item.id === conversationId)!;
    conversation.provider = "openrouter"; conversation.status = "running"; conversation.sandboxMode = "workspace-write"; conversation.title = "Phone handoff canary";
    internals.initializeAgentComputers(conversation, []);
    const computer = conversation.agentComputers!.at(-1)!;
    assert.equal(computer.deviceId, device.id);
    const gate = new HandoffGate();
    internals.handoffs.set(conversationId, gate); internals.runs.set(conversationId, new AbortController());
    const execute = async (name: ComputerToolName, args: Record<string, unknown>) => service.execute({ state, conversation, name, args, deviceId: device.id, approvedTarget: true, auditContext: { actionId: `canary-${randomUUID()}`, conversationId, agentComputerId: computer.id, argumentDigest: createHash("sha256").update(JSON.stringify(args)).digest("hex") } });
    console.log("grokky-phone-smoke:open-disposable-browser");
    const opened = await execute("browse_url", { url: "https://httpbin.org/forms/post" });
    assert.ok(opened.visualArtifact, "Browser frame is missing");
    const field = opened.browserObservation?.elements.find((item) => item.role === "textbox" && /customer name/i.test(item.name));
    assert.ok(field?.bounds, "Customer field bounds are missing");
    await controller.startPhone(conversationId);
    const frame = opened.visualArtifact;
    internals.phoneFrame = { id: randomUUID(), data: `data:image/png;base64,${frame.dataBase64}`, width: frame.width, height: frame.height };
    const invite = new URL(controller.snapshot().phone!.inviteUrl!);
    origin = invite.origin; [room, phoneToken] = invite.hash.slice(1).split(".") as [string, string];
    const claimed = await phone("claim", {}); phoneToken = claimed.token!;
    await until(async () => Boolean(controller.snapshot().phone?.claimed), "desktop sees claim");
    controller.confirmPhone();
    await until(async () => Boolean(controller.snapshot().phone?.confirmed), "desktop confirms phone");
    const getSnapshot = async () => { const result = await phone("poll", {}); assert.ok(result.snapshot); return result.snapshot; };
    async function command(kind: PhoneCommand["kind"], extra: Partial<PhoneCommand> = {}) {
      const snapshot = await getSnapshot();
      const id = randomUUID();
      await phone("command", { id, kind, epoch: snapshot.epoch, frameId: snapshot.frame?.id, ...extra });
      await until(async () => { const result = await phone("poll", { receiptId: id }); if (!result.receipt) return false; assert.ok(result.receipt.ok, result.receipt.detail); return true; }, kind);
    }
    console.log("grokky-phone-smoke:take-control");
    await command("takeover"); assert.equal(gate.owner, "human");
    const humanEpoch = gate.epoch;
    const bounds = field.bounds;
    await command("tap", { x: (bounds.x + bounds.width / 2) / 1280, y: (bounds.y + bounds.height / 2) / 800 });
    const proof = `phone-proof-${randomUUID().slice(0, 8)}`;
    await command("type", { text: proof });
    await command("key", { text: "Tab" });
    const humanReceipt = state.auditLog.findLast((entry) => entry.action === "phone_type_text");
    assert.ok(humanReceipt, "Human action receipt is missing");
    const replay = await service.execute({ state, conversation, name: "type_text", args: { text: proof }, deviceId: device.id, auditContext: { actionId: humanReceipt.id, conversationId, agentComputerId: computer.id, humanControl: true, argumentDigest: humanReceipt.argumentDigest } });
    assert.equal(replay.visualArtifact, undefined, "Human screenshot was persisted in a replay receipt");
    assert.equal(replay.browserObservation, undefined, "Human page observation was persisted in a replay receipt");
    assert.ok(!replay.output.includes(proof), "Human input was persisted in a replay receipt");
    assert.equal(conversation.messages.length, 0, "Human input leaked into messages");
    assert.ok(!JSON.stringify(conversation.activities).includes(proof), "Human input leaked into activity");
    console.log("grokky-phone-smoke:return-control");
    await command("resume", { text: "Keep the customer name I entered" });
    assert.equal(gate.owner, "agent"); assert.ok(gate.epoch > humanEpoch);
    const observed = await gate.agentAction(() => execute("inspect_page", {}));
    assert.ok(observed.browserObservation?.elements.some((item) => item.value === proof), "Resumed browser lost human input");
    const snapshot = await getSnapshot();
    await phone("command", { id: randomUUID(), kind: "tap", epoch: humanEpoch, frameId: snapshot.frame?.id, x: .5, y: .5 }, 400);
    await controller.disconnectPhone(); await phone("poll", {}, 400);
    console.log("grokky-phone-smoke-ok:pair,confirm,takeover,tap,type,key,resume,same-tab-state,stale-epoch,revocation");
  } finally { await controller.shutdown(); await rm(directory, { recursive: true, force: true }); }
}
