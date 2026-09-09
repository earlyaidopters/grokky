import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MainController } from "../src/main/controller";
import { ComputerAccessService } from "../src/main/computer-access";
import { StateStore, type PersistentState } from "../src/main/state-store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "grokky-phone-readiness-"));
  const service = new ComputerAccessService();
  vi.spyOn(service, "heartbeat").mockResolvedValue(false);
  vi.spyOn(service, "disposeSeat").mockResolvedValue(undefined);
  const request = vi.spyOn(service, "companionRequest").mockResolvedValue({ claimed: false, confirmed: false });
  const controller = new MainController(new StateStore(join(directory, "state.json"), directory), directory, "test", service);
  await controller.initialize();
  cleanups.push(async () => { await controller.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const internals = controller as unknown as { state: PersistentState; runs: Map<string, AbortController> };
  const conversation = internals.state.conversations[0]!;
  conversation.provider = "openrouter"; conversation.status = "running";
  const run = new AbortController(); internals.runs.set(conversation.id, run);
  const device = { id: "cloud", name: "Cloud", platform: "cloudflare-linux", endpoint: "https://example.com", root: "/workspace", encryptedToken: "fixture", capabilities: ["browser" as const], lastSeenAt: Date.now(), revoked: false, protocolVersion: 2 };
  internals.state.computerAccess.remoteDevices = [device];
  const computer = { id: "current-seat", conversationId: conversation.id, agentId: "lead", agentName: "Lead", role: "lead" as const, status: "working" as const, isolation: "cloud-browser" as const, deviceId: device.id, deviceName: device.name, workspaceRoot: "/workspace", actions: [], evidence: [], createdAt: 1, updatedAt: 1 };
  conversation.agentComputers = [computer];
  const readiness = () => controller.snapshot().phonePairing![computer.id]!;
  return { controller, internals, conversation, computer, device, run, request, readiness };
}

test("completed text-only tasks explain the prerequisite and never contact the relay", async () => {
  const f = await fixture(); f.conversation.status = "idle"; f.internals.runs.clear();
  expect(f.readiness()).toMatchObject({ ready: false, reason: expect.stringContaining("text-only greeting") });
  await expect(f.controller.startPhone(f.conversation.id, f.computer.id)).rejects.toThrow("not running");
  expect(f.request).not.toHaveBeenCalled();
});

test.each(["codex", "revoked", "old-protocol", "aborted", "no-run", "local", "ended"])("rejects unavailable pairing: %s", async (condition) => {
  const f = await fixture();
  if (condition === "codex") f.conversation.provider = "codex";
  if (condition === "revoked") f.device.revoked = true;
  if (condition === "old-protocol") f.device.protocolVersion = 1;
  if (condition === "aborted") f.run.abort();
  if (condition === "no-run") f.internals.runs.clear();
  if (condition === "local") f.conversation.agentComputers![0]!.isolation = "policy-session";
  if (condition === "ended") f.conversation.agentComputers![0]!.status = "completed";
  expect(f.readiness().ready).toBe(false);
  await expect(f.controller.startPhone(f.conversation.id, f.computer.id)).rejects.toThrow(f.readiness().reason);
  expect(f.request).not.toHaveBeenCalled();
});

test("an eligible run can pair before its first frame, but cannot pair an archived seat", async () => {
  const f = await fixture();
  expect(f.readiness()).toEqual({ ready: true });
  await expect(f.controller.startPhone(f.conversation.id, "old-seat")).rejects.toThrow("earlier browser session");
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockResolvedValueOnce({ roomId: "a".repeat(32), inviteUrl: `https://example.com/phone#fixture`, expiresAt: Date.now() + 60_000 });
  await f.controller.startPhone(f.conversation.id, f.computer.id);
  expect(f.controller.snapshot().phone).toMatchObject({ computerId: f.computer.id, conversationId: f.conversation.id, confirmed: false });
  expect(f.readiness().ready).toBe(false);
  await f.controller.disconnectPhone();
  expect(f.controller.snapshot().phone).toBeUndefined();
  expect(f.readiness().ready).toBe(true);
});

test.each(["ended", "finished-status", "replaced-run", "replaced-seat"])("revokes a newly created invite if the task changes during pairing: %s", async (condition) => {
  const f = await fixture();
  let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const pairing = f.controller.startPhone(f.conversation.id, f.computer.id);
  expect(f.readiness().ready).toBe(false);
  await expect(f.controller.startPhone(f.conversation.id, f.computer.id)).rejects.toThrow("being prepared");
  if (condition === "ended") f.run.abort();
  else if (condition === "finished-status") f.conversation.status = "idle";
  else if (condition === "replaced-run") f.internals.runs.set(f.conversation.id, new AbortController());
  else f.conversation.agentComputers!.push({ ...f.computer, id: "replacement" });
  resolve({ roomId: "a".repeat(32), inviteUrl: "https://example.com/phone#fixture", expiresAt: Date.now() + 60_000 });
  await expect(pairing).rejects.toThrow("ended before pairing");
  expect(f.request).toHaveBeenLastCalledWith(expect.anything(), "cloud", `/companion/desktop/${"a".repeat(32)}`, { revoke: true });
  expect(f.controller.snapshot().phone).toBeUndefined();
});
