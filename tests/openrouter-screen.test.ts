import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { describeOpenRouterError, openRouterToolContent, shouldRunSeparateWebResearch, toolsFor } from "../src/main/providers/openrouter-provider";
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

  test("guides browser runs away from redundant app launches, captures, and repeated typing", () => {
    const computerAccess = defaultComputerAccess();
    const conversation = {
      id: "conversation-browser-guidance",
      provider: "openrouter",
      sandboxMode: "workspace-write",
      allowCommands: true,
    } as Conversation;
    const descriptions = new Map(toolsFor({ computerAccess }, conversation, false)
      .flatMap((tool) => "function" in tool ? [[tool.function.name, tool.function.description ?? ""] as const] : []));

    expect(descriptions.get("browse_url")).toContain("Do not call open_application first");
    expect(descriptions.get("open_application")).toContain("call browse_url directly");
    expect(descriptions.get("capture_screen")).toContain("already return a current frame");
    expect(descriptions.get("type_text")).toContain("Do not repeat the same text");
  });

  test("offers semantic browser tools only to a negotiated protocol-v2 seat", () => {
    const computerAccess = defaultComputerAccess();
    const baseDevice = {
      id: "sandbox-browser-v2",
      name: "Sandbox",
      platform: "cloudflare-linux",
      endpoint: "https://sandbox.example.com",
      root: "/workspace",
      encryptedToken: "sealed",
      capabilities: ["browser", "screen", "automation"] as const,
      lastSeenAt: Date.now(),
      revoked: false,
    };
    computerAccess.remoteDevices.push({
      ...baseDevice,
      capabilities: [...baseDevice.capabilities],
      protocolVersion: 2,
      browserTools: ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"],
    });
    computerAccess.activeDeviceId = baseDevice.id;
    const conversation = {
      id: "conversation-semantic-browser",
      provider: "openrouter",
      sandboxMode: "workspace-write",
      allowCommands: false,
      agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: baseDevice.id }],
    } as Conversation;
    const names = toolsFor({ computerAccess }, conversation, false, { agentId: "grokky-lead", agentName: "Grokky lead" })
      .flatMap((tool) => "function" in tool ? [tool.function.name] : []);
    expect(names).toEqual(expect.arrayContaining(["browse_url", "inspect_page", "click_element", "fill_field", "wait_for"]));

    computerAccess.remoteDevices[0]!.protocolVersion = 1;
    const legacyNames = toolsFor({ computerAccess }, conversation, false, { agentId: "grokky-lead", agentName: "Grokky lead" })
      .flatMap((tool) => "function" in tool ? [tool.function.name] : []);
    expect(legacyNames).not.toContain("inspect_page");
  });

  test("keeps every strict OpenAI tool schema fully required", () => {
    const computerAccess = defaultComputerAccess();
    const now = Date.now();
    computerAccess.remoteDevices.push({
      id: "strict-schema-browser", name: "Cloud browser", platform: "cloudflare-linux", endpoint: "https://sandbox.example.com", root: "/workspace",
      encryptedToken: "sealed", capabilities: ["files", "browser", "screen", "automation"], lastSeenAt: now, revoked: false, protocolVersion: 2,
      browserTools: ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"],
    });
    computerAccess.activeDeviceId = "strict-schema-browser";
    const conversation = {
      id: "strict-schema-conversation", provider: "openrouter", sandboxMode: "workspace-write", allowCommands: false,
      agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: "strict-schema-browser" }],
    } as Conversation;

    const tools = toolsFor({ computerAccess }, conversation, false, { agentId: "grokky-lead", agentName: "Grokky lead" });
    for (const tool of tools) {
      if (!("function" in tool) || tool.function.strict !== true) continue;
      const schema = tool.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.required, `${tool.function.name} must declare required for strict mode`).toEqual(Object.keys(schema.properties ?? {}));
    }
    const strictByName = new Map(tools.flatMap((tool) => "function" in tool ? [[tool.function.name, tool.function.strict] as const] : []));
    expect(strictByName.get("inspect_page")).toBe(false);
    expect(strictByName.get("press_key")).toBe(false);
    expect(strictByName.get("scroll_page")).toBe(false);
    expect(strictByName.get("wait_for")).toBe(false);
  });

  test("routes explicit computer searches to the browser instead of mandatory web preflight", () => {
    expect(shouldRunSeparateWebResearch("Use your computer to search Google Flights for Lisbon", true, true)).toBe(false);
    expect(shouldRunSeparateWebResearch("Browse a website and click its date picker", true, true)).toBe(false);
    expect(shouldRunSeparateWebResearch("Search the current web for primary sources", true, true)).toBe(true);
    expect(shouldRunSeparateWebResearch("Use your computer to search Google Flights", true, false)).toBe(true);
  });

  test("surfaces the nested provider validation message instead of the generic wrapper", () => {
    expect(describeOpenRouterError({
      message: "Provider returned error",
      body: JSON.stringify({
        error: {
          message: "Provider returned error",
          metadata: { raw: JSON.stringify({ error: { message: "Invalid schema for function 'inspect_page'" } }) },
        },
      }),
    })).toBe("Invalid schema for function 'inspect_page'");
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

  test("attaches every cloud browser action frame for the model's next decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-browser-tool-"));
    const pathname = join(directory, "browser.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(pathname, png);

    for (const name of ["browse_url", "click_screen", "type_text", "open_application"]) {
      const content = await openRouterToolContent(name, {
        output: `${name} completed`,
        attachmentPath: pathname,
        attachmentMimeType: "image/png",
      });
      expect(content).toEqual(expect.arrayContaining([
        { type: "image_url", imageUrl: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" } },
      ]));
    }
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
