import { describe, expect, test } from "vitest";
import {
  browserApplicationFromArgs,
  browserElementRefFromArgs,
  browserFillFromArgs,
  browserInspectFromArgs,
  browserKeyFromArgs,
  browserPointFromArgs,
  browserScrollFromArgs,
  browserSelectFromArgs,
  browserUrlFromArgs,
  browserWaitFromArgs,
  canonicalJson,
  commandFromArgs,
  gatewayCapabilities,
  GATEWAY_PROTOCOL_VERSION,
  mintDeviceToken,
  parseExecuteRequest,
  remoteWorkspacePath,
  sha256Hex,
  semanticBrowserTools,
  verifyDeviceToken,
} from "../src/protocol";

describe("sandbox gateway protocol", () => {
  test("uses the same canonical argument digest as Grokky", async () => {
    const args = { z: [3, { b: true, a: "x" }], a: 1 };
    expect(canonicalJson(args)).toBe('{"a":1,"z":[3,{"a":"x","b":true}]}');
    expect(await sha256Hex(canonicalJson(args))).toMatch(/^[a-f0-9]{64}$/);
  });

  test("mints tamper-evident device tokens", async () => {
    const secret = "a".repeat(48);
    const token = await mintDeviceToken({ deviceId: `sandbox-${"b".repeat(32)}`, epoch: 3, issuedAt: 123 }, secret);
    await expect(verifyDeviceToken(token, secret)).resolves.toEqual({ deviceId: `sandbox-${"b".repeat(32)}`, epoch: 3, issuedAt: 123 });
    await expect(verifyDeviceToken(`${token.slice(0, -1)}x`, secret)).resolves.toBeNull();
  });

  test("requires a short-lived seat-bound command lease", () => {
    const now = 1_000_000;
    const value = parseExecuteRequest({
      name: "run_command",
      args: { command: "npm test" },
      mode: "workspace-write",
      allowCommands: true,
      auditContext: {
        actionId: "computer-action-123",
        conversationId: "conversation-123",
        agentComputerId: "agent-computer-123",
        argumentDigest: "a".repeat(64),
        expiresAt: now + 60_000,
      },
    }, now);
    expect(value.name).toBe("run_command");
    expect(() => parseExecuteRequest({ ...value, auditContext: { ...value.auditContext, expiresAt: now - 6_000 } }, now)).toThrow(/expired/);
    expect(() => parseExecuteRequest({ ...value, allowCommands: false }, now)).toThrow(/Full access/);
    expect(() => parseExecuteRequest({ ...value, auditContext: { ...value.auditContext, agentComputerId: undefined } }, now)).toThrow(/agent computer/);
  });

  test("keeps file paths inside a credential-filtered workspace", () => {
    expect(remoteWorkspacePath("src/index.ts")).toBe("/workspace/src/index.ts");
    expect(() => remoteWorkspacePath("../secret.txt")).toThrow(/excluded/);
    expect(() => remoteWorkspacePath(".env.production")).toThrow(/Credential/);
    expect(() => remoteWorkspacePath(".dev.vars")).toThrow(/Credential/);
    expect(() => remoteWorkspacePath(".ssh/config")).toThrow(/excluded/);
    expect(() => remoteWorkspacePath(".aws/credentials")).toThrow(/excluded/);
    expect(() => remoteWorkspacePath("keys/service.pem")).toThrow(/Credential/);
    expect(() => remoteWorkspacePath("src/bad\0name.ts")).toThrow(/relative/);
    expect(() => remoteWorkspacePath("node_modules/pkg/index.js")).toThrow(/excluded/);
  });

  test("passes a complete command as one shell argv value", () => {
    expect(commandFromArgs({ command: "printf '%s' '$HOME' && npm test" })).toBe("printf '%s' '$HOME' && npm test");
    expect(() => commandFromArgs({ command: "" })).toThrow(/Invalid command|empty/);
    expect(() => commandFromArgs({ command: "x".repeat(20_001) })).toThrow(/Invalid command/);
  });

  test("advertises and validates the seat-bound cloud browser tools", () => {
    expect(gatewayCapabilities).toEqual(["files", "commands", "browser", "screen", "automation"]);
    const now = 1_000_000;
    const request = parseExecuteRequest({
      name: "browse_url",
      args: { url: "https://example.com/docs" },
      mode: "read-only",
      allowCommands: false,
      approvedTarget: true,
      networkAllowlist: ["example.com"],
      auditContext: {
        actionId: "computer-browser-123",
        conversationId: "conversation-browser-123",
        agentComputerId: "agent-computer-browser-123",
        argumentDigest: "b".repeat(64),
        expiresAt: now + 60_000,
      },
    }, now);
    expect(request).toMatchObject({ name: "browse_url", approvedTarget: true, networkAllowlist: ["example.com"] });
    expect(browserUrlFromArgs(request.args).toString()).toBe("https://example.com/docs");
    expect(browserPointFromArgs({ x: 1279, y: 799 })).toEqual({ x: 1279, y: 799 });
    expect(browserApplicationFromArgs({ name: "Chrome" })).toBe("browser");
  });

  test("blocks local browser targets and out-of-frame input", () => {
    for (const url of [
      "http://127.0.0.1",
      "http://169.254.169.254",
      "http://localhost",
      "http://[::1]",
      "http://[::ffff:7f00:1]",
      "http://[2001:db8::1]",
      "http://[2002:7f00:1::]",
      "file:///etc/passwd",
      "https://user:pass@example.com",
    ]) {
      expect(() => browserUrlFromArgs({ url }), url).toThrow();
    }
    expect(browserUrlFromArgs({ url: "https://[2606:4700:4700::1111]/" }).hostname).toContain("2606:4700");
    expect(() => browserPointFromArgs({ x: 1280, y: 20 })).toThrow(/1280 by 800/);
    expect(() => browserPointFromArgs({ x: 20, y: -1 })).toThrow(/1280 by 800/);
    expect(() => browserApplicationFromArgs({ name: "Password Manager" })).toThrow(/Browser, Terminal, and Files/);
  });

  test("advertises protocol v2 and validates bounded semantic browser actions", () => {
    const ref = "el-abcdefgh12345678";
    expect(GATEWAY_PROTOCOL_VERSION).toBe(2);
    expect(semanticBrowserTools).toEqual(["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"]);
    expect(browserElementRefFromArgs({ ref })).toBe(ref);
    expect(browserInspectFromArgs({ mode: "both", limit: 120 })).toEqual({ mode: "both", limit: 120 });
    expect(browserFillFromArgs({ ref, value: "13 December 2026" })).toEqual({ ref, value: "13 December 2026" });
    expect(browserKeyFromArgs({ ref, key: "Enter" })).toEqual({ ref, key: "Enter" });
    expect(browserSelectFromArgs({ ref, value: "YUL" })).toEqual({ ref, value: "YUL" });
    expect(browserScrollFromArgs({ direction: "down", amount: 800 })).toEqual({ direction: "down", amount: 800 });
    expect(browserWaitFromArgs({ condition: "value_equals", ref, value: "YUL", timeout_ms: 5_000 })).toEqual({ condition: "value_equals", ref, value: "YUL", timeoutMs: 5_000 });
    expect(browserWaitFromArgs({ condition: "page_changed", fingerprint: "a".repeat(64) })).toMatchObject({ condition: "page_changed", fingerprint: "a".repeat(64) });
  });

  test("rejects stale-shaped refs, unbounded values, arbitrary keys, and incomplete waits", () => {
    const ref = "el-abcdefgh12345678";
    expect(() => browserElementRefFromArgs({ ref: "#departure-date" })).toThrow(/reference/);
    expect(() => browserInspectFromArgs({ limit: 121 })).toThrow(/between 1 and 120/);
    expect(() => browserFillFromArgs({ ref, value: "x".repeat(4_001) })).toThrow(/4,000/);
    expect(() => browserKeyFromArgs({ ref, key: "Control+Shift+I" })).toThrow(/not allowed/);
    expect(() => browserSelectFromArgs({ ref, value: "" })).toThrow(/option value/);
    expect(() => browserScrollFromArgs({ direction: "sideways" })).toThrow(/up or down/);
    expect(() => browserWaitFromArgs({ condition: "value_equals", ref })).toThrow(/requires a value/);
    expect(() => browserWaitFromArgs({ condition: "page_changed" })).toThrow(/prior fingerprint/);
  });
});
