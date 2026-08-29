import { describe, expect, test } from "vitest";
import {
  browserApplicationFromArgs,
  browserPointFromArgs,
  browserUrlFromArgs,
  canonicalJson,
  commandFromArgs,
  gatewayCapabilities,
  mintDeviceToken,
  parseExecuteRequest,
  remoteWorkspacePath,
  sha256Hex,
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
});
