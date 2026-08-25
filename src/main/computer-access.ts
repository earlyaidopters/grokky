import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdir } from "node:fs/promises";
import { hostname, platform } from "node:os";
import type {
  ComputerAccessLevel,
  ComputerAccessSnapshot,
  ComputerCapability,
  ComputerCapabilityId,
  ComputerDevice,
  ComputerPermissionStatus,
  Conversation,
} from "../shared/contracts";
import type { PersistedComputerAccess, PersistedRemoteDevice } from "./state-store";
import { executeWorkspaceTool, type WorkspaceToolName } from "./workspace-tools";

export type ComputerToolName = WorkspaceToolName | "browse_url" | "capture_screen" | "open_application" | "click_screen" | "type_text";

export interface ComputerHostAdapter {
  permissionStatus(capability: ComputerCapabilityId): ComputerPermissionStatus;
  requestPermission(capability: ComputerCapabilityId): Promise<ComputerPermissionStatus>;
  execute(name: Exclude<ComputerToolName, WorkspaceToolName | "browse_url">, args: Record<string, unknown>, root: string): Promise<string>;
}

export interface ComputerAccessSecrets {
  seal(value: string): string;
  unseal(value: string): string;
}

const capabilityCopy: Record<ComputerCapabilityId, Pick<ComputerCapability, "label" | "description">> = {
  files: { label: "Files and folders", description: "Read and edit files inside the selected workspace only." },
  commands: { label: "Development commands", description: "Run bounded build, test, inspection, and version-control commands." },
  browser: { label: "Browser and web pages", description: "Open approved public web pages and return readable page content." },
  screen: { label: "Screen visibility", description: "Capture the current display so an agent can inspect visible application state." },
  automation: { label: "Application control", description: "Open apps, click coordinates, and type text through supported system accessibility controls." },
};

const localCapabilities: ComputerCapabilityId[] = ["files", "commands", "browser", "screen", "automation"];
const workspaceTools = new Set<WorkspaceToolName>(["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"]);

export function capabilityForTool(name: ComputerToolName): ComputerCapabilityId {
  if (name === "run_command") return "commands";
  if (workspaceTools.has(name as WorkspaceToolName)) return "files";
  if (name === "browse_url") return "browser";
  if (name === "capture_screen") return "screen";
  return "automation";
}

export function targetForTool(name: ComputerToolName, args: Record<string, unknown>): string {
  if (name === "browse_url") return String(args.url ?? "web page").slice(0, 500);
  if (name === "run_command") return String(args.command ?? "command").slice(0, 500);
  if (name === "open_application") return String(args.name ?? "application").slice(0, 500);
  if (name === "capture_screen") return "current display";
  if (name === "click_screen") return `${String(args.x ?? "?")}, ${String(args.y ?? "?")}`;
  if (name === "type_text") return "active application";
  return String(args.path ?? args.query ?? "workspace").slice(0, 500);
}

function defaultHostAdapter(): ComputerHostAdapter {
  return {
    permissionStatus: (capability) => capability === "screen" || capability === "automation" ? "unavailable" : "not-required",
    requestPermission: async (capability) => capability === "screen" || capability === "automation" ? "unavailable" : "not-required",
    execute: async () => { throw new Error("Desktop control is unavailable in this runtime"); },
  };
}

function defaultSecrets(): ComputerAccessSecrets {
  return {
    seal: (value) => Buffer.from(value, "utf8").toString("base64"),
    unseal: (value) => Buffer.from(value, "base64").toString("utf8"),
  };
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Runner endpoint must use http or https");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = 0, b = 0] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be opened");
  if (url.username || url.password) throw new Error("URLs containing credentials are blocked");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Private, local, and link-local network addresses are blocked from browser tools");
  }
}

function domainAllowed(hostnameValue: string, allowlist: string[]): boolean {
  const target = hostnameValue.toLowerCase();
  return allowlist.some((entry) => {
    const domain = entry.replace(/^https?:\/\//, "").replace(/^\*\./, "").split("/")[0]!.toLowerCase();
    return target === domain || target.endsWith(`.${domain}`);
  });
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

async function browseUrl(value: string, allowlist: string[], approvedTarget: boolean): Promise<string> {
  const url = new URL(value);
  await assertPublicUrl(url);
  if (!approvedTarget && !domainAllowed(url.hostname, allowlist)) {
    throw new Error(`Add ${url.hostname} to the computer network allowlist or approve this page once`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "GrokkyRunner/0.1 (+local computer tool)" },
    });
    const finalUrl = new URL(response.url);
    await assertPublicUrl(finalUrl);
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(?:html|plain)|application\/(?:json|xml)/i.test(contentType)) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    const raw = (await response.text()).slice(0, 500_000);
    const title = decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? finalUrl.hostname);
    const text = decodeEntities(raw
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim())
      .slice(0, 40_000);
    return `Title: ${title}\nURL: ${finalUrl.toString()}\n\n${text || "No readable text was found."}`;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRequest<T>(url: string, init: RequestInit, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json() as { error?: string } & T;
    if (!response.ok) throw new Error(payload.error || `Runner returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function probeReadableRoot(root: string): Promise<string> {
  const entries = await readdir(root);
  return `Workspace root is readable (${entries.length} top-level ${entries.length === 1 ? "entry" : "entries"}).`;
}

export class ComputerAccessService {
  private readonly host: ComputerHostAdapter;
  private readonly secrets: ComputerAccessSecrets;

  constructor(options: { host?: ComputerHostAdapter; secrets?: ComputerAccessSecrets } = {}) {
    this.host = options.host ?? defaultHostAdapter();
    this.secrets = options.secrets ?? defaultSecrets();
  }

  snapshot(state: PersistedComputerAccess, root: string, pendingApproval?: ComputerAccessSnapshot["pendingApproval"]): ComputerAccessSnapshot {
    const activeRemote = state.remoteDevices.find((device) => device.id === state.activeDeviceId && !device.revoked);
    const activeCapabilities = activeRemote?.capabilities ?? localCapabilities;
    const capabilities = localCapabilities.map((id): ComputerCapability => ({
      id,
      ...capabilityCopy[id],
      level: state.grants[id],
      permission: activeRemote ? "not-required" : this.host.permissionStatus(id),
      available: activeCapabilities.includes(id),
    }));
    const devices: ComputerDevice[] = [
      {
        id: state.localDeviceId,
        name: hostname() || "This computer",
        platform: platform(),
        kind: "local",
        status: "online",
        root,
        capabilities: localCapabilities,
        lastSeenAt: Date.now(),
      },
      ...state.remoteDevices.map((device): ComputerDevice => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        kind: "remote",
        status: device.revoked ? "revoked" : device.lastSeenAt > Date.now() - 90_000 ? "online" : "offline",
        root: device.root,
        endpoint: device.endpoint,
        capabilities: device.capabilities,
        lastSeenAt: device.lastSeenAt,
      })),
    ];
    return {
      enabled: state.enabled,
      activeDeviceId: state.activeDeviceId,
      devices,
      capabilities,
      networkAllowlist: [...state.networkAllowlist],
      auditLog: [...state.auditLog].sort((left, right) => right.createdAt - left.createdAt).slice(0, 120),
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }

  async requestPermission(capability: ComputerCapabilityId): Promise<ComputerPermissionStatus> {
    return this.host.requestPermission(capability);
  }

  setCapability(state: PersistedComputerAccess, capability: ComputerCapabilityId, level: ComputerAccessLevel): void {
    state.grants[capability] = level;
  }

  async pair(state: PersistedComputerAccess, endpointValue: string, code: string): Promise<void> {
    const endpoint = normalizedEndpoint(endpointValue);
    if (!/^\d{6}$/.test(code.trim())) throw new Error("Pairing code must contain six digits");
    const payload = await jsonRequest<{
      device: { id: string; name: string; platform: string; root: string; capabilities: ComputerCapabilityId[] };
      token: string;
    }>(`${endpoint}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    if (!payload.device?.id || !payload.token) throw new Error("Runner returned an invalid pairing response");
    const record: PersistedRemoteDevice = {
      id: payload.device.id,
      name: payload.device.name || "Remote computer",
      platform: payload.device.platform || "unknown",
      endpoint,
      root: payload.device.root || "workspace",
      encryptedToken: this.secrets.seal(payload.token),
      capabilities: payload.device.capabilities.filter((capability) => localCapabilities.includes(capability)),
      lastSeenAt: Date.now(),
      revoked: false,
    };
    const existing = state.remoteDevices.findIndex((device) => device.id === record.id);
    if (existing >= 0) state.remoteDevices[existing] = record;
    else state.remoteDevices.push(record);
    state.activeDeviceId = record.id;
  }

  select(state: PersistedComputerAccess, deviceId: string): void {
    const valid = deviceId === state.localDeviceId || state.remoteDevices.some((device) => device.id === deviceId && !device.revoked);
    if (!valid) throw new Error("Computer is unavailable or revoked");
    state.activeDeviceId = deviceId;
  }

  revoke(state: PersistedComputerAccess, deviceId: string): void {
    if (deviceId === state.localDeviceId) throw new Error("The local computer cannot be revoked");
    const device = state.remoteDevices.find((item) => item.id === deviceId);
    if (!device) throw new Error("Computer not found");
    device.revoked = true;
    device.encryptedToken = "";
    if (state.activeDeviceId === deviceId) state.activeDeviceId = state.localDeviceId;
  }

  async test(state: PersistedComputerAccess, capability: ComputerCapabilityId, conversation: Conversation): Promise<string> {
    if (state.activeDeviceId !== state.localDeviceId) {
      const device = this.remoteDevice(state);
      const payload = await this.remoteRequest<{ ok: boolean; detail: string }>(device, "/test", { capability });
      device.lastSeenAt = Date.now();
      return payload.detail;
    }
    if (capability === "files") {
      return probeReadableRoot(conversation.workingDirectory);
    }
    if (capability === "commands") {
      return executeWorkspaceTool({ root: conversation.workingDirectory, mode: "workspace-write", allowCommands: true, name: "run_command", args: { command: "pwd" } });
    }
    if (capability === "browser") return browseUrl("https://example.com", [], true);
    if (capability === "screen") return this.host.execute("capture_screen", {}, conversation.workingDirectory);
    const status = await this.host.requestPermission("automation");
    if (status !== "granted") throw new Error("Accessibility permission is not granted");
    return "Accessibility permission is ready for application control.";
  }

  async execute(options: {
    state: PersistedComputerAccess;
    conversation: Conversation;
    name: ComputerToolName;
    args: Record<string, unknown>;
    approvedTarget?: boolean;
  }): Promise<string> {
    const { state, conversation, name, args } = options;
    if (!state.enabled) throw new Error("Computer access is disabled");
    if (state.activeDeviceId !== state.localDeviceId) {
      const device = this.remoteDevice(state);
      const result = await this.remoteRequest<{ output: string }>(device, "/execute", {
        name,
        args,
        mode: conversation.sandboxMode,
        allowCommands: conversation.allowCommands,
      });
      device.lastSeenAt = Date.now();
      return result.output;
    }
    if (workspaceTools.has(name as WorkspaceToolName)) {
      return executeWorkspaceTool({
        root: conversation.workingDirectory,
        mode: conversation.sandboxMode,
        allowCommands: conversation.allowCommands,
        name: name as WorkspaceToolName,
        args,
      });
    }
    if (name === "browse_url") return browseUrl(String(args.url ?? ""), state.networkAllowlist, options.approvedTarget === true);
    return this.host.execute(name as Exclude<ComputerToolName, WorkspaceToolName | "browse_url">, args, conversation.workingDirectory);
  }

  generatePairingSecret(): { code: string; token: string } {
    return {
      code: String(Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000).padStart(6, "0"),
      token: randomBytes(32).toString("base64url"),
    };
  }

  safeTokenEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private remoteDevice(state: PersistedComputerAccess): PersistedRemoteDevice {
    const device = state.remoteDevices.find((item) => item.id === state.activeDeviceId && !item.revoked);
    if (!device) throw new Error("Remote computer is unavailable or revoked");
    return device;
  }

  private remoteRequest<T>(device: PersistedRemoteDevice, pathname: string, body: Record<string, unknown>): Promise<T> {
    const token = this.secrets.unseal(device.encryptedToken);
    if (!token) throw new Error("Remote computer credential is unavailable");
    return jsonRequest<T>(`${device.endpoint}${pathname}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 125_000);
  }
}

export function newAuditId(): string {
  return `computer-${randomUUID().replaceAll("-", "")}`;
}
