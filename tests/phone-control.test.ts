import { describe, expect, test } from "vitest";
import { HandoffGate } from "../src/main/handoff-gate";
import { parsePhoneCommand } from "../src/shared/phone";
import { browserRequestMessages } from "../src/main/providers/browser-context";
import type { ChatMessages } from "@openrouter/sdk/models";

describe("phone control ownership", () => {
  test("waits for an in-flight action, rejects stale agent input, and resumes with a new epoch", async () => {
    const gate = new HandoffGate();
    let finish!: () => void;
    const active = gate.agentAction(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pause = gate.takeover();
    expect(gate.owner).toBe("pausing");
    let staleExecuted = false;
    await expect(gate.agentAction(async () => { staleExecuted = true; })).rejects.toThrow(/control changed/);
    expect(staleExecuted).toBe(false);
    finish(); await active; await pause;
    expect(gate.owner).toBe("human");
    let unblocked = false;
    const checkpoint = gate.checkpoint().then((value) => { unblocked = true; return value; });
    await Promise.resolve(); expect(unblocked).toBe(false);
    await gate.resume("Continue with the chosen option");
    expect(await checkpoint).toMatchObject({ note: "Continue with the chosen option", epoch: 3 });
  });
  test("does not resume automation while a human input is in flight", async () => {
    const gate = new HandoffGate(); await gate.takeover();
    let finish!: () => void;
    const input = gate.humanAction(() => new Promise<void>((resolve) => { finish = resolve; }));
    const resume = gate.resume("");
    expect(gate.owner).toBe("pausing");
    await expect(gate.humanAction(async () => undefined)).rejects.toThrow(/no longer active/);
    finish(); await input; await resume; expect(gate.owner).toBe("agent");
  });
  test("cancellation wakes a paused model without granting control", async () => {
    const gate = new HandoffGate(); await gate.takeover();
    const waiting = gate.checkpoint(); gate.stop();
    await expect(waiting).rejects.toThrow(/cancelled/);
    await expect(gate.resume("")).rejects.toThrow();
  });
  test("rejects out-of-frame clicks, stale identities, and arbitrary key chords", () => {
    const base = { id: "a".repeat(32), epoch: 1, kind: "tap", frameId: "frame-one", x: .5, y: .5 };
    expect(parsePhoneCommand(base)).toMatchObject({ kind: "tap", x: .5 });
    expect(() => parsePhoneCommand({ ...base, x: 1.1 })).toThrow(/coordinates/);
    expect(() => parsePhoneCommand({ ...base, epoch: -1 })).toThrow(/identity/);
    expect(() => parsePhoneCommand({ ...base, kind: "key", text: "Meta+Q" })).toThrow(/Unsupported key/);
  });
});

describe("bounded model image context", () => {
  test("retains recent frames, user images, text evidence, and the original history", () => {
    const messages: ChatMessages[] = [{ role: "user", content: [{ type: "image_url", imageUrl: { url: "data:image/png;base64,user" } }] },
      ...Array.from({ length: 5 }, (_, index): ChatMessages => ({ role: "tool", toolCallId: `frame-${index}`, content: [{ type: "text", text: `evidence-${index}` }, { type: "image_url", imageUrl: { url: `data:image/png;base64,${index}` } }] }))];
    const bounded = browserRequestMessages(messages);
    const images = (items: ChatMessages[]) => JSON.stringify(items).match(/image_url/g)?.length;
    expect(images(messages)).toBe(6); expect(images(bounded)).toBe(3);
    expect(bounded[0]).toBe(messages[0]);
    expect(JSON.stringify(bounded)).toContain("evidence-0");
    expect(JSON.stringify(bounded)).toContain("frame-0");
    expect(images(browserRequestMessages(messages, true))).toBe(6);
  });
});
