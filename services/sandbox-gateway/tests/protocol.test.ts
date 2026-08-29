import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  commandFromArgs,
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
    expect(() => remoteWorkspacePath("keys/service.pem")).toThrow(/Credential/);
    expect(() => remoteWorkspacePath("node_modules/pkg/index.js")).toThrow(/excluded/);
  });

  test("passes a complete command as one shell argv value", () => {
    expect(commandFromArgs({ command: "printf '%s' '$HOME' && npm test" })).toBe("printf '%s' '$HOME' && npm test");
    expect(() => commandFromArgs({ command: "" })).toThrow(/Invalid command|empty/);
    expect(() => commandFromArgs({ command: "x".repeat(20_001) })).toThrow(/Invalid command/);
  });
});
