import { createHash, randomUUID } from "node:crypto";
import type { ComputerToolName, ComputerAccessService } from "./computer-access";
import type { PersistedComputerAccess } from "./state-store";
import type { Conversation } from "../shared/contracts";

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

function digestArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runPairedCloudDeviceSmoke(
  state: PersistedComputerAccess,
  conversation: Conversation,
  computerAccess: ComputerAccessService,
): Promise<{ checks: number; gatewayHost: string; liveView: true }> {
  const device = state.remoteDevices.find((candidate) => candidate.id === state.activeDeviceId && !candidate.revoked)
    ?? state.remoteDevices.find((candidate) => !candidate.revoked && candidate.platform === "cloudflare-linux");
  requireValue(device, "No paired Cloudflare computer is available in Grokky state");
  const endpoint = new URL(device.endpoint);
  requireValue(endpoint.protocol === "https:", "The production Cloudflare computer must use HTTPS");
  state.activeDeviceId = device.id;
  console.log("grokky-cloud-device-smoke-step:heartbeat:start");
  requireValue(await computerAccess.heartbeat(state), "The paired Cloudflare computer did not answer its heartbeat");
  console.log("grokky-cloud-device-smoke-step:heartbeat:ok");

  console.log("grokky-cloud-device-smoke-step:health:start");
  const healthResponse = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(15_000) });
  const health = await healthResponse.json() as { ok?: unknown };
  requireValue(healthResponse.ok && health.ok === true, "The Cloudflare computer health endpoint failed");
  console.log("grokky-cloud-device-smoke-step:health:ok");

  const runId = randomUUID().replaceAll("-", "");
  const conversationId = `conversation-production-${runId}`;
  const agentComputerId = `agent-computer-production-${runId}`;
  const executionConversation: Conversation = {
    ...structuredClone(conversation),
    id: conversationId,
    provider: "openrouter",
    sandboxMode: "workspace-write",
    allowCommands: true,
  };
  let actionIndex = 0;
  let disposed = false;

  const execute = async (name: ComputerToolName, args: Record<string, unknown>) => {
    actionIndex += 1;
    console.log(`grokky-cloud-device-smoke-step:${actionIndex}:${name}:start`);
    const result = await computerAccess.execute({
      state,
      conversation: executionConversation,
      name,
      args,
      approvedTarget: true,
      deviceId: device.id,
      auditContext: {
        actionId: `computer-production-${runId}-${actionIndex}`,
        conversationId,
        agentComputerId,
        agentName: "production smoke",
        argumentDigest: digestArguments(args),
      },
    });
    console.log(`grokky-cloud-device-smoke-step:${actionIndex}:${name}:ok`);
    return result;
  };

  try {
    const relativePath = `smoke/${runId}.txt`;
    await execute("create_file", { path: relativePath, content: "production-alpha\nproduction-beta\n" });
    requireValue((await execute("read_file", { path: relativePath })).output.includes("production-beta"), "Production read_file verification failed");
    await execute("edit_file", { path: relativePath, old_text: "production-beta", new_text: "production-gamma" });
    requireValue((await execute("list_files", {})).output.includes(runId), "Production list_files verification failed");
    requireValue((await execute("search_files", { query: "production-gamma" })).output.includes(runId), "Production search_files verification failed");
    requireValue((await execute("run_command", { command: "id -u && printf 'production-command-ok\\n'" })).output.includes("STDOUT\n1000\nproduction-command-ok"), "Production non-root command verification failed");

    const browserTarget = process.env.GROKKY_CLOUD_DEVICE_SMOKE_URL || "https://www.cloudflare.com/";
    const browserTargetHost = new URL(browserTarget).hostname;
    const browse = await execute("browse_url", { url: browserTarget });
    requireValue(browse.output.includes("Title:") && browse.output.includes(browserTargetHost), "Production Browser Run page verification failed");
    const artifact = browse.visualArtifact;
    requireValue(artifact?.mimeType === "image/png" && artifact.width === 1280 && artifact.height === 800, "Production Browser Run frame metadata is invalid");
    const frame = Buffer.from(artifact.dataBase64, "base64");
    requireValue(frame.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Production Browser Run frame is not PNG");
    requireValue(createHash("sha256").update(frame).digest("hex") === artifact.sha256, "Production Browser Run frame digest failed");
    const liveView = new URL(artifact.liveViewUrl ?? "");
    requireValue(liveView.protocol === "https:" && liveView.hostname === "live.browser.run" && liveView.pathname.startsWith("/ui/"), "Production Browser Run did not return a valid Live View");
    for (const [name, args] of [
      ["click_screen", { x: 100, y: 100 }],
      ["type_text", { text: "production smoke input" }],
      ["capture_screen", {}],
    ] as const) {
      const action = await execute(name, args);
      requireValue(action.visualArtifact?.width === 1280 && action.visualArtifact.height === 800, `Production ${name} frame verification failed`);
    }

    console.log("grokky-cloud-device-smoke-step:dispose:start");
    await computerAccess.disposeSeat(state, device.id, conversationId, agentComputerId);
    console.log("grokky-cloud-device-smoke-step:dispose:ok");
    disposed = true;
    return { checks: 15, gatewayHost: endpoint.hostname, liveView: true };
  } finally {
    if (!disposed) await computerAccess.disposeSeat(state, device.id, conversationId, agentComputerId).catch(() => undefined);
  }
}
