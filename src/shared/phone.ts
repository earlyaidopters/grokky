export interface PhonePairingReadiness {
  ready: boolean;
  reason?: string;
}

export type PhoneOwner = "agent" | "pausing" | "human" | "stopped";
export interface PhoneFrame { id: string; data: string; width: number; height: number }
export interface PhoneSnapshot {
  title: string;
  owner: PhoneOwner;
  epoch: number;
  expiresAt: number;
  confirmed: boolean;
  frame?: PhoneFrame;
  approval?: { id: string; action: string; target: string };
  detail: string;
}
export interface PhoneCommand {
  id: string;
  epoch: number;
  kind: "takeover" | "resume" | "stop" | "approve" | "deny" | "tap" | "type" | "key" | "scroll" | "refresh";
  frameId?: string;
  x?: number;
  y?: number;
  text?: string;
  approvalId?: string;
}
export interface PhoneDesktopStatus {
  conversationId: string;
  computerId: string;
  owner: PhoneOwner;
  inviteUrl?: string;
  claimed: boolean;
  confirmed: boolean;
  expiresAt: number;
  error?: string;
}

export function parsePhoneCommand(value: unknown): PhoneCommand {
  if (!value || typeof value !== "object") throw new Error("Invalid phone command");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(v.id) || !Number.isSafeInteger(v.epoch) || Number(v.epoch) < 0) throw new Error("Invalid command identity");
  if (!["takeover", "resume", "stop", "approve", "deny", "tap", "type", "key", "scroll", "refresh"].includes(String(v.kind))) throw new Error("Unsupported phone command");
  const command: PhoneCommand = { id: v.id, epoch: Number(v.epoch), kind: v.kind as PhoneCommand["kind"] };
  if (["tap", "type", "key", "scroll"].includes(command.kind)) {
    if (typeof v.frameId !== "string" || v.frameId.length > 100) throw new Error("A current browser frame is required");
    command.frameId = v.frameId;
  }
  if (command.kind === "tap") {
    if (typeof v.x !== "number" || typeof v.y !== "number" || !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) throw new Error("Invalid tap coordinates");
    command.x = v.x; command.y = v.y;
  }
  if (["type", "key", "scroll", "resume"].includes(command.kind)) {
    if (typeof v.text !== "string" || v.text.length > (command.kind === "type" ? 2_000 : 1_000)) throw new Error("Invalid phone input");
    command.text = v.text;
    if (command.kind === "key" && !["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"].includes(v.text)) throw new Error("Unsupported key");
    if (command.kind === "scroll" && !["up", "down"].includes(v.text)) throw new Error("Invalid scroll direction");
  }
  if (command.kind === "approve" || command.kind === "deny") {
    if (typeof v.approvalId !== "string" || v.approvalId.length > 160) throw new Error("Invalid approval");
    command.approvalId = v.approvalId;
  }
  return command;
}
