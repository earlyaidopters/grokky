import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ComputerAccessService, type ComputerHostAdapter } from "../src/main/computer-access";
import { startRunnerServer } from "../src/main/runner-service";
import { defaultComputerAccess } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

function conversation(root: string): Conversation {
  const now = Date.now();
  return {
    id: "computer-test-chat",
    title: "Computer test",
    provider: "openrouter",
    model: "test/model",
    reasoning: "low",
    sandboxMode: "workspace-write",
    allowCommands: true,
    workingDirectory: root,
    messages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

describe("computer access service", () => {
  test("reports host permissions and routes local workspace tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-computer-"));
    await writeFile(join(root, "README.md"), "local runner evidence\n");
    const host: ComputerHostAdapter = {
      permissionStatus: (capability) => capability === "screen" ? "granted" : capability === "automation" ? "not-determined" : "not-required",
      requestPermission: async () => "granted",
      execute: async (name) => `executed ${name}`,
    };
    const service = new ComputerAccessService({ host });
    const state = defaultComputerAccess();
    const snapshot = service.snapshot(state, root);
    expect(snapshot.devices[0]).toMatchObject({ kind: "local", status: "online", root });
    expect(snapshot.capabilities.find((item) => item.id === "screen")?.permission).toBe("granted");
    await expect(service.execute({ state, conversation: conversation(root), name: "read_file", args: { path: "README.md" } })).resolves.toContain("local runner evidence");
    await expect(service.execute({ state, conversation: conversation(root), name: "capture_screen", args: {} })).resolves.toBe("executed capture_screen");
  });

  test("tests the workspace root without descending into protected folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-computer-probe-"));
    const protectedDirectory = join(root, ".protected");
    await mkdir(protectedDirectory);
    await chmod(protectedDirectory, 0o000);
    try {
      const service = new ComputerAccessService();
      const state = defaultComputerAccess();
      await expect(service.test(state, "files", conversation(root))).resolves.toMatch(/Workspace root is readable/);
    } finally {
      await chmod(protectedDirectory, 0o700);
    }
  });

  test("pairs a remote runner and executes inside its configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-remote-root-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "grokky-remote-state-"));
    await writeFile(join(root, "remote.txt"), "paired runner evidence\n");
    const runner = await startRunnerServer({
      root,
      statePath: join(stateDirectory, "state.json"),
      host: "127.0.0.1",
      port: 0,
      allowWrite: false,
      allowCommands: false,
    });
    try {
      const service = new ComputerAccessService();
      const state = defaultComputerAccess();
      await service.pair(state, runner.endpoint, runner.code);
      expect(state.activeDeviceId).toBe(runner.deviceId);
      await expect(service.execute({ state, conversation: conversation(root), name: "read_file", args: { path: "remote.txt" } })).resolves.toContain("paired runner evidence");
      await expect(service.execute({ state, conversation: conversation(root), name: "create_file", args: { path: "blocked.txt", content: "no" } })).rejects.toThrow(/read-only/);
    } finally {
      await runner.close();
    }
  });
});
