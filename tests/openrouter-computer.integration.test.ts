import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ComputerAccessService, isValidBrowserLiveViewUrl, type ComputerToolName } from "../src/main/computer-access";
import { isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";
import { runOpenRouter, toolsFor } from "../src/main/providers/openrouter-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import { defaultComputerAccess } from "../src/main/state-store";
import type { AppSettings, Conversation, UsageSummary } from "../src/shared/contracts";

const live = process.env.GROKKY_LIVE_OPENROUTER_COMPUTER === "1";
const run = live ? describe : describe.skip;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function argumentDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

async function envValue(pathname: string, name: string): Promise<string> {
  const value = parseEnvValue(await readFile(pathname, "utf8"), name);
  if (!value) throw new Error(`${name} is missing from ${pathname}`);
  return value;
}

run("live OpenRouter cloud-computer judgment", () => {
  test("lets Sol inspect and interact with the production browser visually", async () => {
    const credentialPath = process.env.GROKKY_OPENROUTER_ENV_FILE;
    if (!credentialPath) throw new Error("GROKKY_OPENROUTER_ENV_FILE is required");
    const apiKey = await envValue(credentialPath, "OPENROUTER_API_KEY");
    if (!isUsableOpenRouterKey(apiKey)) throw new Error("The OpenRouter credential is invalid");

    const cloudEnvironment = process.env.GROKKY_CLOUD_DEVICE_ENV_FILE;
    if (!cloudEnvironment) throw new Error("GROKKY_CLOUD_DEVICE_ENV_FILE is required");
    const enrollment = await envValue(cloudEnvironment, "GROKKY_ENROLLMENT_TOKEN");
    const endpoint = process.env.GROKKY_CLOUD_DEVICE_SMOKE_ENDPOINT ?? "https://grokky-sandbox-gateway.steep-water-fa9f.workers.dev";
    const model = process.env.GROKKY_OPENROUTER_SMOKE_MODEL ?? "openai/gpt-5.6-sol";
    const typedProof = `Grokky Sol visual proof ${new Date().toISOString().slice(0, 10)}`;
    const targetUrl = "https://httpbin.org/forms/post";
    const state = defaultComputerAccess();
    state.grants = { files: "allow", commands: "allow", browser: "allow", screen: "allow", automation: "allow", external: "allow" };
    state.networkAllowlist = ["httpbin.org"];
    const computerAccess = new ComputerAccessService({ secrets: { seal: (value) => value, unseal: (value) => value } });
    const evidenceDirectory = await mkdtemp(join(tmpdir(), "grokky-openrouter-computer-"));
    const conversationId = `openrouter-computer-${randomUUID().replaceAll("-", "")}`;
    const agentComputerId = `agent-computer-${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const conversation: Conversation = {
      id: conversationId,
      title: "OpenRouter Sol computer proof",
      instructions: "",
      provider: "openrouter",
      model,
      reasoning: "medium",
      sandboxMode: "workspace-write",
      allowCommands: true,
      projectMode: "none",
      workingDirectory: "/workspace",
      messages: [],
      queuedMessages: [],
      activities: [],
      selectedAgentIds: [],
      agentRuns: [],
      crewCommunications: [],
      agentTasks: [],
      agentMeetings: [],
      agentComputers: [],
      status: "running",
      unreadCount: 0,
      lastViewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: "/workspace",
      recentWorkingDirectories: [],
      openRouterCredentialPath: credentialPath,
      theme: "dark",
      accentPalette: "lime",
      multiAgentEnabled: false,
      maxAgentThreads: 1,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      spreadAgentComputers: false,
      connectorsEnabled: false,
      webSearchEnabled: false,
    };
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 300_000);
    const actions: Array<{ name: ComputerToolName; args: Record<string, unknown>; currentUrl?: string }> = [];
    let final = "";
    let usage: UsageSummary | undefined;
    let frameCount = 0;
    let liveViewCount = 0;
    let deviceId = "";
    let disposed = false;
    try {
      await computerAccess.pair(state, endpoint, enrollment);
      deviceId = state.activeDeviceId;
      expect(await computerAccess.heartbeat(state)).toBe(true);
      const device = state.remoteDevices.find((candidate) => candidate.id === deviceId);
      if (!device) throw new Error("The paired cloud device is missing");
      conversation.agentComputers = [{
        id: agentComputerId,
        conversationId,
        agentId: "grokky-lead",
        agentName: "Grokky lead",
        role: "lead",
        icon: "lime",
        task: "Complete the visual browser proof",
        status: "working",
        isolation: "cloud-browser",
        deviceId,
        deviceName: device.name,
        workspaceRoot: device.root,
        actions: [],
        evidence: [],
        createdAt: now,
        updatedAt: now,
      }];
      const offeredTools = toolsFor({ computerAccess: state }, conversation, false, { agentId: "grokky-lead", agentName: "Grokky lead" })
        .flatMap((tool) => "function" in tool ? [tool.function.name] : []);
      expect(offeredTools).toEqual(expect.arrayContaining(["browse_url", "click_screen", "type_text", "capture_screen"]));

      await runOpenRouter({
        conversation,
        settings,
        agents: [],
        prompt: [
          `This is a live computer-use test. You must call browse_url as your first action with ${targetUrl}; do not answer from memory.`,
          "Inspect the returned screen image before acting.",
          "You must then call click_screen on the Customer name field and call type_text with the exact text below once:",
          typedProof,
          "Do not submit the form and do not navigate away.",
          "You must call capture_screen exactly once after typing, then report the page title, the exact text typed, and whether the form was submitted.",
        ].join("\n"),
        images: [],
        readImageDataUrl: async () => { throw new Error("No prompt images are expected"); },
        signal: controller.signal,
        computerAccess: state,
        approvedBrowserOrigins: [],
        apiKey,
        executeTool: async (name, args) => {
          const execution = await computerAccess.execute({
            state,
            conversation,
            name,
            args,
            approvedTarget: true,
            deviceId,
            signal: controller.signal,
            auditContext: {
              actionId: `sol-proof-${actions.length + 1}-${randomUUID().replaceAll("-", "")}`,
              conversationId,
              agentComputerId,
              agentName: "Grokky lead",
              argumentDigest: argumentDigest(args),
            },
          });
          actions.push({ name, args: structuredClone(args), ...(execution.visualArtifact?.currentUrl ? { currentUrl: execution.visualArtifact.currentUrl } : {}) });
          if (!execution.visualArtifact) return { output: execution.output };
          const artifact = execution.visualArtifact;
          const bytes = Buffer.from(artifact.dataBase64, "base64");
          expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
          expect([artifact.width, artifact.height]).toEqual([1280, 800]);
          frameCount += 1;
          if (artifact.liveViewUrl) {
            expect(isValidBrowserLiveViewUrl(artifact.liveViewUrl)).toBe(true);
            liveViewCount += 1;
          }
          const attachmentPath = join(evidenceDirectory, `${String(frameCount).padStart(2, "0")}-${name}.png`);
          await writeFile(attachmentPath, bytes, { mode: 0o600 });
          return { output: execution.output, attachmentPath, attachmentMimeType: "image/png" as const };
        },
        onEvent: (event: ProviderEvent) => {
          if (event.type === "final") final = event.text;
          if (event.type === "usage") usage = event.usage;
        },
      });

      const names = actions.map((action) => action.name);
      console.log(`grokky-openrouter-computer-result:${JSON.stringify({ model, offeredTools, actionNames: names, final, usage })}`);
      expect(names).toContain("browse_url");
      expect(names).toContain("click_screen");
      expect(names).toContain("type_text");
      expect(names).toContain("capture_screen");
      expect(actions.some((action) => action.name === "type_text" && action.args.text === typedProof)).toBe(true);
      expect(actions.filter((action) => action.name === "type_text")).toHaveLength(1);
      expect(actions.filter((action) => action.name === "capture_screen")).toHaveLength(1);
      expect(actions.filter((action) => action.currentUrl).every((action) => action.currentUrl === targetUrl)).toBe(true);
      expect(frameCount).toBeGreaterThanOrEqual(4);
      expect(liveViewCount).toBeGreaterThan(0);
      expect(final).toContain(typedProof);
      expect(final.toLowerCase()).toContain("httpbin.org");
      expect(final.toLowerCase().replaceAll("*", "")).toMatch(/not submitted|was not submitted|submitted:\s*no/);

      await computerAccess.disposeSeat(state, deviceId, conversationId, agentComputerId);
      disposed = true;
      console.log(`grokky-openrouter-computer-ok:${JSON.stringify({
        model,
        actionNames: names,
        frameCount,
        liveViewCount,
        final,
        usage,
      })}`);
    } finally {
      clearTimeout(deadline);
      if (deviceId && !disposed) await computerAccess.disposeSeat(state, deviceId, conversationId, agentComputerId).catch(() => undefined);
      if (deviceId) await computerAccess.revoke(state, deviceId).catch(() => undefined);
    }
  }, 360_000);
});
