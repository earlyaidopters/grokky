import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ComputerAccessService, isNonPublicAddress, isValidBrowserLiveViewUrl, isValidBrowserObservation, isValidBrowserOutcome, pointInsideDisplay, RemoteActionOutcomeUnknownError, targetForTool, type ComputerHostAdapter } from "../src/main/computer-access";
import { startRunnerServer } from "../src/main/runner-service";
import { defaultComputerAccess } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

function conversation(root: string): Conversation {
  const now = Date.now();
  return {
    id: "computer-test-chat",
    title: "Computer test",
    instructions: "",
    provider: "openrouter",
    model: "test/model",
    reasoning: "low",
    sandboxMode: "workspace-write",
    allowCommands: true,
    projectMode: "project",
    workingDirectory: root,
    messages: [],
    queuedMessages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "idle",
    unreadCount: 0,
    lastViewedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe("computer access service", () => {
  test("accepts only Cloudflare Browser Live View URLs", () => {
    expect(isValidBrowserLiveViewUrl("https://live.browser.run/ui/view?token=signed-value")).toBe(true);
    expect(isValidBrowserLiveViewUrl("https://live.browser.run.evil.example/ui/view?token=stolen")).toBe(false);
    expect(isValidBrowserLiveViewUrl("https://user@live.browser.run/ui/view?token=stolen")).toBe(false);
    expect(isValidBrowserLiveViewUrl("http://live.browser.run/ui/view?token=stolen")).toBe(false);
  });

  test("accepts only bounded protocol-v2 semantic browser evidence", () => {
    const observation = {
      snapshotId: "page-1234567890abcdef",
      fingerprint: "a".repeat(64),
      url: "https://example.com/flights",
      title: "Flights",
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0, maxY: 900 },
      dialogs: 0,
      elements: [{ ref: "el-1234567890abcdef-0-2", role: "textbox", name: "Departure", tag: "input", value: "YUL", visible: true, frameIndex: 0 }],
      visibleText: "Departure YUL",
      truncated: false,
    };
    const outcome = { effect: "changed", beforeFingerprint: "a".repeat(64), afterFingerprint: "b".repeat(64), changes: ["Departure changed to YUL"] };
    expect(isValidBrowserObservation(observation)).toBe(true);
    expect(isValidBrowserOutcome(outcome)).toBe(true);
    expect(isValidBrowserObservation({ ...observation, snapshotId: "page-stale", visibleText: "x".repeat(12_001) })).toBe(false);
    expect(isValidBrowserOutcome({ ...outcome, effect: "executed-javascript" })).toBe(false);
  });

  test("redacts semantic field values from approval targets", () => {
    expect(targetForTool("fill_field", { ref: "el-1234567890abcdef-0-2", value: "private passenger name" })).toBe("element el-1234567890abcdef-0-2 · 22 characters");
  });

  test("shows the exact text payload in an automation approval target", () => {
    expect(targetForTool("type_text", { text: "Confirm release candidate 42" })).toBe("active application · 28 characters\nConfirm release candidate 42");
  });

  test("keeps coordinate automation inside the display that was captured", () => {
    const bounds = { x: -1200, y: 40, width: 1200, height: 900 };
    expect(pointInsideDisplay(-1200, 40, bounds)).toBe(true);
    expect(pointInsideDisplay(-1, 939, bounds)).toBe(true);
    expect(pointInsideDisplay(0, 939, bounds)).toBe(false);
    expect(pointInsideDisplay(-1, 940, bounds)).toBe(false);
  });

  test("rejects local, reserved, mapped, and non-unicast network addresses", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.0.1", "192.168.1.1",
      "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2002:7f00:1::",
    ]) expect(isNonPublicAddress(address), address).toBe(true);
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });

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
    await expect(service.execute({ state, conversation: conversation(root), name: "read_file", args: { path: "README.md" } })).resolves.toMatchObject({ output: expect.stringContaining("local runner evidence") });
    await expect(service.execute({ state, conversation: conversation(root), name: "capture_screen", args: {} })).resolves.toEqual({ output: "executed capture_screen" });
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

  test("allows plain HTTP only for literal loopback runner endpoints", async () => {
    const service = new ComputerAccessService();
    for (const endpoint of [
      "http://1.1.1.1:4747",
      "http://10.0.0.1:4747",
      "http://100.64.0.1:4747",
      "http://192.168.1.10:4747",
      "http://localhost:4747",
    ]) {
      await expect(service.pair(defaultComputerAccess(), endpoint, "123456"), endpoint).rejects.toThrow(/literal loopback/);
    }
  });

  test("stops reading oversized local pages even when the server omits content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(500_001).fill(65));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "Content-Type": "text/html" } });
    Object.defineProperty(response, "url", { value: "https://1.1.1.1/" });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    try {
      const state = defaultComputerAccess();
      await expect(new ComputerAccessService().execute({
        state,
        conversation: conversation("/unused"),
        name: "browse_url",
        args: { url: "https://1.1.1.1/" },
        approvedTarget: true,
      })).rejects.toThrow(/too large/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rejects malformed pairing records before sealing or persisting them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      token: "valid-token-value-123456789",
      tokenEpoch: 1,
      device: {
        id: "sandbox-invalid-pair",
        name: "Sandbox",
        platform: "cloudflare-linux",
        root: "/workspace",
        capabilities: "commands",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    try {
      const state = defaultComputerAccess();
      await expect(new ComputerAccessService().pair(state, "http://127.0.0.1:4747", "123456")).rejects.toThrow(/invalid pairing response/);
      expect(state.remoteDevices).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("pairs with a one-time sandbox enrollment key and sends a short-lived seat lease", async () => {
    let observedLease: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/pair") {
        response.end(JSON.stringify({
          token: "sandbox-device-token",
          tokenEpoch: 1,
          device: { id: "sandbox-device-lease", name: "Sandbox", platform: "cloudflare-linux", root: "/workspace", capabilities: ["files", "commands"] },
        }));
        return;
      }
      const auditContext = body.auditContext as Record<string, unknown>;
      observedLease = auditContext;
      response.end(JSON.stringify({ output: "Exit code: 0", receiptId: "runner-sandboxreceipt01", argumentDigest: auditContext.argumentDigest }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    try {
      const state = defaultComputerAccess();
      state.enabled = true;
      const service = new ComputerAccessService();
      await service.pair(state, `http://127.0.0.1:${address.port}`, `gsk_${"a".repeat(40)}`);
      await expect(service.execute({
        state,
        conversation: conversation("/unused-local-root"),
        name: "run_command",
        args: { command: "npm test" },
        auditContext: {
          actionId: "computer-action-lease",
          conversationId: "computer-test-chat",
          agentComputerId: "agent-computer-lease",
          argumentDigest: "a".repeat(64),
        },
      })).resolves.toEqual({ output: "Exit code: 0" });
      expect(observedLease).toMatchObject({
        actionId: "computer-action-lease",
        conversationId: "computer-test-chat",
        agentComputerId: "agent-computer-lease",
        argumentDigest: "a".repeat(64),
      });
      expect(Number(observedLease?.expiresAt)).toBeGreaterThan(Date.now());
      expect(Number(observedLease?.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("refreshes cloud browser capabilities and accepts an integrity-described frame", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const sha256 = createHash("sha256").update(png).digest("hex");
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/pair") {
        response.end(JSON.stringify({
          token: "sandbox-browser-token",
          tokenEpoch: 1,
          device: { id: "sandbox-device-browser", name: "Sandbox", platform: "cloudflare-linux", root: "/workspace", capabilities: ["files", "commands"] },
        }));
        return;
      }
      if (request.url === "/heartbeat") {
        response.end(JSON.stringify({ ok: true, deviceId: "sandbox-device-browser", capabilities: ["files", "commands", "browser", "screen", "automation"] }));
        return;
      }
      const auditContext = body.auditContext as Record<string, unknown>;
      response.end(JSON.stringify({
        output: "Opened example.com in the cloud browser.",
        receiptId: "runner-browserreceipt01",
        argumentDigest: auditContext.argumentDigest,
        visualArtifact: {
          mimeType: "image/png",
          dataBase64: png.toString("base64"),
          sha256,
          currentUrl: "https://example.com/",
          pageTitle: "Example Domain",
          width: 1280,
          height: 800,
          liveViewUrl: "https://live.browser.run/ui/view?token=signed-value",
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    try {
      const state = defaultComputerAccess();
      state.enabled = true;
      const service = new ComputerAccessService();
      await service.pair(state, `http://127.0.0.1:${address.port}`, `gsk_${"b".repeat(40)}`);
      expect(state.remoteDevices[0]?.capabilities).toEqual(["files", "commands"]);
      await expect(service.heartbeat(state)).resolves.toBe(true);
      expect(state.remoteDevices[0]?.capabilities).toEqual(["files", "commands", "browser", "screen", "automation"]);
      await expect(service.execute({
        state,
        conversation: conversation("/unused-local-root"),
        name: "browse_url",
        args: { url: "https://1.1.1.1/" },
        approvedTarget: true,
        auditContext: {
          actionId: "computer-action-browser",
          conversationId: "computer-test-chat",
          agentComputerId: "agent-computer-browser",
          argumentDigest: "c".repeat(64),
        },
      })).resolves.toMatchObject({
        output: expect.stringContaining("Opened example.com"),
        visualArtifact: { sha256, currentUrl: "https://example.com/", width: 1280, height: 800, liveViewUrl: "https://live.browser.run/ui/view?token=signed-value" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("does not forget a runner without a complete revocation receipt", async () => {
    const responses = [
      { ok: false, receiptId: "runner-receipt0001", tokenEpoch: 2 },
      { ok: true, tokenEpoch: 2 },
      { ok: true, receiptId: "runner-receipt0003", tokenEpoch: 0 },
      { ok: true, receiptId: "runner-receipt0004", tokenEpoch: 2 },
    ];
    let responseIndex = 0;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(responses[responseIndex++]));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    try {
      const state = defaultComputerAccess();
      const encryptedToken = Buffer.from("test-runner-token", "utf8").toString("base64");
      state.remoteDevices.push({
        id: "receipt-test-runner",
        name: "Receipt test runner",
        platform: "test",
        endpoint: `http://127.0.0.1:${address.port}`,
        root: "/test",
        encryptedToken,
        capabilities: ["files"],
        lastSeenAt: Date.now(),
        revoked: false,
      });
      state.activeDeviceId = "receipt-test-runner";
      const service = new ComputerAccessService();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(service.revoke(state, "receipt-test-runner")).rejects.toThrow(/valid persisted revocation receipt/);
        expect(state.remoteDevices[0]).toMatchObject({ revoked: false, encryptedToken });
      }
      await expect(service.revoke(state, "receipt-test-runner")).resolves.toBeUndefined();
      expect(state.remoteDevices[0]).toMatchObject({ revoked: true, encryptedToken: "", tokenEpoch: 2 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("refuses to place the runner bearer inside the agent-readable workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-runner-root-"));
    await expect(startRunnerServer({ root, statePath: join(root, ".runner", "state.json"), port: 0 })).rejects.toThrow(/outside the workspace root/);
  });

  test("pairs a remote runner and executes inside its configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-remote-root-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "grokky-remote-state-"));
    const runnerStatePath = join(stateDirectory, "state.json");
    await writeFile(join(root, "remote.txt"), "paired runner evidence\n");
    const runner = await startRunnerServer({
      root,
      statePath: runnerStatePath,
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
      state.remoteDevices[0]!.lastSeenAt = Date.now() - 10 * 60_000;
      expect(service.snapshot(state, root).devices.find((device) => device.id === runner.deviceId)?.status).toBe("offline");
      await expect(service.heartbeat(state)).resolves.toBe(true);
      expect(service.snapshot(state, root).devices.find((device) => device.id === runner.deviceId)?.status).toBe("online");
      await expect(service.execute({ state, conversation: conversation(root), name: "read_file", args: { path: "remote.txt" } })).resolves.toMatchObject({ output: expect.stringContaining("paired runner evidence") });
      const receipts = (await readFile(`${runnerStatePath}.audit.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { receiptId: string; status: string; action: string; argumentDigest?: string });
      expect(receipts.slice(0, 2)).toEqual([
        expect.objectContaining({ status: "accepted", action: "read_file", argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ status: "completed", action: "read_file", argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]);
      expect(receipts[0]?.receiptId).toBe(receipts[1]?.receiptId);
      await expect(service.execute({ state, conversation: conversation(root), name: "create_file", args: { path: "blocked.txt", content: "no" } })).rejects.toThrow(/read-only/);
      const oldToken = Buffer.from(state.remoteDevices[0]!.encryptedToken, "base64").toString("utf8");
      const directExecution = await fetch(`${runner.endpoint}/execute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "read_file", args: { path: "remote.txt" }, mode: "read-only", allowCommands: false }),
      });
      const directPayload = await directExecution.json() as { output?: string; receiptId?: string; argumentDigest?: string };
      expect(directPayload).toMatchObject({
        output: expect.stringContaining("paired runner evidence"),
        receiptId: expect.stringMatching(/^runner-/),
        argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await service.revoke(state, runner.deviceId);
      expect(state.remoteDevices[0]).toMatchObject({ revoked: true, encryptedToken: "" });
      const persistedRunnerState = JSON.parse(await readFile(runnerStatePath, "utf8")) as { token?: string; tokenEpoch?: number };
      expect(persistedRunnerState).toMatchObject({ tokenEpoch: 2 });
      expect(persistedRunnerState.token).not.toBe(oldToken);
      const rejected = await fetch(`${runner.endpoint}/execute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "read_file", args: { path: "remote.txt" }, mode: "read-only", allowCommands: false }),
      });
      expect(rejected.status).toBe(401);
    } finally {
      await runner.close();
    }
  });

  test("treats a missing or mismatched post-actuation receipt as an unknown remote outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-remote-receipt-"));
    let responseIndex = 0;
    const server = createServer((_request, response) => {
      response.writeHead(responseIndex === 0 ? 409 : 200, { "Content-Type": "application/json" });
      response.end(responseIndex++ === 0
        ? JSON.stringify({ error: "Authorized argument digest does not match the runner request" })
        : JSON.stringify({ output: "side effect may have happened", receiptId: "runner-receipt0001", argumentDigest: "0".repeat(64) }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    try {
      const state = defaultComputerAccess();
      state.remoteDevices.push({
        id: "receipt-runner", name: "Receipt runner", platform: "test", endpoint: `http://127.0.0.1:${address.port}`, root,
        encryptedToken: Buffer.from("token", "utf8").toString("base64"), capabilities: ["files"], lastSeenAt: Date.now(), revoked: false,
      });
      state.activeDeviceId = "receipt-runner";
      const service = new ComputerAccessService();
      const request = {
        state,
        conversation: conversation(root),
        name: "read_file" as const,
        args: { path: "README.md" },
        auditContext: { actionId: "action-1", conversationId: "computer-test-chat", argumentDigest: "a".repeat(64) },
      };
      await expect(service.execute(request)).rejects.not.toBeInstanceOf(RemoteActionOutcomeUnknownError);
      await expect(service.execute(request)).rejects.toBeInstanceOf(RemoteActionOutcomeUnknownError);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("rejects oversized chunked runner responses and malformed execution output as unknown outcomes", async () => {
    const state = defaultComputerAccess();
    state.enabled = true;
    state.remoteDevices.push({
      id: "sandbox-oversized-runner",
      name: "Oversized runner",
      platform: "cloudflare-linux",
      endpoint: "http://127.0.0.1:4747",
      root: "/workspace",
      encryptedToken: Buffer.from("test-runner-token", "utf8").toString("base64"),
      capabilities: ["files", "commands"],
      lastSeenAt: Date.now(),
      revoked: false,
    });
    state.activeDeviceId = "sandbox-oversized-runner";
    const request = {
      state,
      conversation: conversation("/unused"),
      name: "read_file" as const,
      args: { path: "README.md" },
      auditContext: { actionId: "action-bounded", conversationId: "computer-test-chat", argumentDigest: "a".repeat(64) },
    };
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1_000_001).fill(65));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(oversized, { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: 42,
        receiptId: "runner-malformedoutput01",
        argumentDigest: "a".repeat(64),
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ComputerAccessService().execute(request)).rejects.toBeInstanceOf(RemoteActionOutcomeUnknownError);
      await expect(new ComputerAccessService().execute(request)).rejects.toBeInstanceOf(RemoteActionOutcomeUnknownError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("tears down Cloudflare seats even after a heartbeat temporarily drops command capability", async () => {
    const state = defaultComputerAccess();
    state.remoteDevices.push({
      id: "sandbox-capability-drop",
      name: "Cloud seat",
      platform: "cloudflare-linux",
      endpoint: "http://127.0.0.1:4747",
      root: "/workspace",
      encryptedToken: Buffer.from("test-runner-token", "utf8").toString("base64"),
      capabilities: ["browser", "screen", "automation"],
      lastSeenAt: Date.now(),
      revoked: false,
    });
    state.activeDeviceId = "sandbox-capability-drop";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, receiptId: "runner-disposereceipt01" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ComputerAccessService().disposeSeat(state, "sandbox-capability-drop", "conversation-1", "seat-1")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4747/dispose");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("persists a monotonic token epoch across runner restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-epoch-root-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "grokky-epoch-state-"));
    const runnerStatePath = join(stateDirectory, "state.json");
    for (const expectedEpoch of [2, 3]) {
      const runner = await startRunnerServer({ root, statePath: runnerStatePath, host: "127.0.0.1", port: 0, allowWrite: false, allowCommands: false });
      try {
        const service = new ComputerAccessService();
        const state = defaultComputerAccess();
        await service.pair(state, runner.endpoint, runner.code);
        await service.revoke(state, runner.deviceId);
        const persisted = JSON.parse(await readFile(runnerStatePath, "utf8")) as { tokenEpoch?: number };
        expect(persisted.tokenEpoch).toBe(expectedEpoch);
      } finally {
        await runner.close();
      }
    }
  });
});
