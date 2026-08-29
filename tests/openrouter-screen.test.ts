import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openRouterToolContent, toolsFor } from "../src/main/providers/openrouter-provider";
import { defaultComputerAccess } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

describe("OpenRouter screen tool content", () => {
  test("offers commands only for Full access on the selected command sandbox", () => {
    const computerAccess = defaultComputerAccess();
    computerAccess.enabled = true;
    computerAccess.remoteDevices.push({
      id: "sandbox-device-123",
      name: "Sandbox",
      platform: "cloudflare-linux",
      endpoint: "https://sandbox.example.com",
      root: "/workspace",
      encryptedToken: "sealed",
      capabilities: ["files", "commands"],
      lastSeenAt: Date.now(),
      revoked: false,
    });
    computerAccess.activeDeviceId = "sandbox-device-123";
    const conversation = {
      id: "conversation-command-test",
      provider: "openrouter",
      sandboxMode: "workspace-write",
      allowCommands: true,
      agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: "sandbox-device-123" }],
    } as Conversation;
    const toolNames = toolsFor({ computerAccess }, conversation, false, { agentId: "grokky-lead", agentName: "Grokky lead" })
      .flatMap((tool) => "function" in tool ? [tool.function.name] : []);
    expect(toolNames).toContain("run_command");
    expect(toolsFor({ computerAccess }, { ...conversation, allowCommands: false }, false).flatMap((tool) => "function" in tool ? [tool.function.name] : [])).not.toContain("run_command");
    expect(toolsFor({ computerAccess }, conversation, true).flatMap((tool) => "function" in tool ? [tool.function.name] : [])).not.toContain("run_command");
  });

  test("attaches a local screen capture as model-visible image content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-screen-tool-"));
    const pathname = join(directory, "screen.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(pathname, png);

    const content = await openRouterToolContent("capture_screen", {
      output: "Captured the current display",
      attachmentPath: pathname,
      attachmentMimeType: "image/png",
    });
    expect(content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "image_url",
        imageUrl: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" },
      },
    ]);
  });

  test("keeps ordinary tool output textual", async () => {
    await expect(openRouterToolContent("read_file", { output: "hello" })).resolves.toBe("hello");
  });

  test("uses the owned evidence path instead of parsing a deleted temporary path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-screen-owned-"));
    const ownedPath = join(directory, "owned.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(ownedPath, png);

    const content = await openRouterToolContent("capture_screen", {
      output: "Captured the current display to /tmp/already-deleted.png",
      attachmentPath: ownedPath,
      attachmentMimeType: "image/png",
    });
    expect(content).toEqual(expect.arrayContaining([
      { type: "image_url", imageUrl: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" } },
    ]));
  });
});
