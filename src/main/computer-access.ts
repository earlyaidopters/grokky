import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
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

export const semanticBrowserTools = ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"] as const;
export type SemanticBrowserToolName = typeof semanticBrowserTools[number];
export type ComputerToolName = WorkspaceToolName | "browse_url" | "capture_screen" | "open_application" | "click_screen" | "type_text" | SemanticBrowserToolName;

export type BrowserActionEffect = "changed" | "no_effect" | "already_satisfied" | "navigated" | "opened_dialog" | "opened_popup" | "stale_reference" | "blocked" | "uncertain";

export interface BrowserElementObservation {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  dateHint?: string;
  placeholder?: string;
  text?: string;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  scrollable?: boolean;
  visible: boolean;
  frameIndex: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserObservation {
  snapshotId: string;
  fingerprint: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxY: number };
  activeElement?: { role: string; name: string; value?: string };
  dialogs: number;
  elements: BrowserElementObservation[];
  visibleText: string;
  truncated: boolean;
}

export interface BrowserActionOutcome {
  effect: BrowserActionEffect;
  beforeFingerprint: string;
  afterFingerprint: string;
  changes: string[];
}

export interface ComputerVisualArtifact {
  mimeType: "image/png";
  dataBase64: string;
  sha256: string;
  currentUrl: string;
  pageTitle: string;
  width: number;
  height: number;
  liveViewUrl?: string;
}

export interface ComputerExecutionResult {
  output: string;
  visualArtifact?: ComputerVisualArtifact;
  browserObservation?: BrowserObservation;
  browserOutcome?: BrowserActionOutcome;
}

/** The request crossed the remote actuation boundary, but its final effect cannot be proven. */
export class RemoteActionOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteActionOutcomeUnknownError";
  }
}

class RunnerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RunnerHttpError";
  }
}

export interface ComputerHostAdapter {
  permissionStatus(capability: ComputerCapabilityId): ComputerPermissionStatus;
  requestPermission(capability: ComputerCapabilityId): Promise<ComputerPermissionStatus>;
  execute(name: Exclude<ComputerToolName, WorkspaceToolName | "browse_url" | SemanticBrowserToolName>, args: Record<string, unknown>, root: string): Promise<string>;
}

export interface ComputerAccessSecrets {
  seal(value: string): string;
  unseal(value: string): string;
}

const capabilityCopy: Record<ComputerCapabilityId, Pick<ComputerCapability, "label" | "description">> = {
  files: { label: "Files and folders", description: "Read and edit files inside the selected workspace only." },
  commands: { label: "Development commands", description: "Codex can run commands in its native sandbox. OpenRouter commands stay off until a disposable sandbox is available." },
  browser: { label: "Browser and web pages", description: "Open approved public web pages and return readable page content." },
  screen: { label: "Screen visibility", description: "Capture the current display so an agent can inspect visible application state." },
  automation: { label: "Application control", description: "Open apps, click coordinates, and type text through supported system accessibility controls." },
};

const localCapabilities: ComputerCapabilityId[] = ["files", "commands", "browser", "screen", "automation"];
const workspaceTools = new Set<WorkspaceToolName>(["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"]);
const semanticBrowserToolSet = new Set<string>(semanticBrowserTools);
const MAX_LOCAL_PAGE_BYTES = 500_000;
const MAX_RUNNER_RESPONSE_BYTES = 8_000_000;
const MAX_RUNNER_OUTPUT_CHARACTERS = 250_000;

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

export function isValidBrowserLiveViewUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 12_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "live.browser.run"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname.startsWith("/ui/");
  } catch {
    return false;
  }
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function isValidBrowserObservation(value: unknown): value is BrowserObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrowserObservation>;
  if (!/^page-[a-f0-9]{16}$/.test(item.snapshotId ?? "") || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? "")) return false;
  if (!validBoundedString(item.url, 4_000) || !validBoundedString(item.title, 240)) return false;
  if (!item.viewport || !Number.isSafeInteger(item.viewport.width) || !Number.isSafeInteger(item.viewport.height)) return false;
  if (!item.scroll || ![item.scroll.x, item.scroll.y, item.scroll.maxY].every(Number.isFinite)) return false;
  if (!Number.isSafeInteger(item.dialogs) || (item.dialogs ?? -1) < 0 || (item.dialogs ?? 21) > 20) return false;
  if (!Array.isArray(item.elements) || item.elements.length > 120) return false;
  if (!item.elements.every((element) => {
    if (!element || !/^el-[a-zA-Z0-9_-]{8,176}$/.test(element.ref ?? "")) return false;
    if (!validBoundedString(element.role, 40) || !validBoundedString(element.name, 500) || !validBoundedString(element.tag, 40)) return false;
    if (element.type !== undefined && !validBoundedString(element.type, 80)) return false;
    if (element.value !== undefined && !validBoundedString(element.value, 1_000)) return false;
    if (element.dateHint !== undefined && !validBoundedString(element.dateHint, 120)) return false;
    return typeof element.visible === "boolean"
      && (element.scrollable === undefined || typeof element.scrollable === "boolean")
      && Number.isSafeInteger(element.frameIndex)
      && element.frameIndex >= 0
      && element.frameIndex <= 100;
  })) return false;
  return validBoundedString(item.visibleText, 12_000) && typeof item.truncated === "boolean";
}

export function isValidBrowserOutcome(value: unknown): value is BrowserActionOutcome {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrowserActionOutcome>;
  const effects = new Set<BrowserActionEffect>(["changed", "no_effect", "already_satisfied", "navigated", "opened_dialog", "opened_popup", "stale_reference", "blocked", "uncertain"]);
  return effects.has(item.effect as BrowserActionEffect)
    && /^[a-f0-9]{64}$/.test(item.beforeFingerprint ?? "")
    && /^[a-f0-9]{64}$/.test(item.afterFingerprint ?? "")
    && Array.isArray(item.changes)
    && item.changes.length <= 20
    && item.changes.every((change) => validBoundedString(change, 1_000));
}

export function capabilityForTool(name: ComputerToolName): ComputerCapabilityId {
  if (name === "run_command") return "commands";
  if (workspaceTools.has(name as WorkspaceToolName)) return "files";
  if (name === "browse_url" || name === "inspect_page" || name === "wait_for") return "browser";
  if (name === "capture_screen") return "screen";
  return "automation";
}

export function targetForTool(name: ComputerToolName, args: Record<string, unknown>): string {
  if (name === "browse_url") return String(args.url ?? "web page").slice(0, 4_000);
  if (name === "run_command") return String(args.command ?? "command").slice(0, 4_000);
  if (name === "open_application") return String(args.name ?? "application").slice(0, 500);
  if (name === "capture_screen") return "current display";
  if (name === "click_screen") return `${String(args.x ?? "?")}, ${String(args.y ?? "?")}`;
  if (name === "type_text") {
    const text = String(args.text ?? "").slice(0, 4_000);
    return `active application · ${text.length} characters\n${text}`;
  }
  if (name === "inspect_page") return `page inspection · ${String(args.mode ?? "both")}`;
  if (name === "click_element") return `element ${String(args.ref ?? "?")}`;
  if (name === "fill_field") return `element ${String(args.ref ?? "?")} · ${String(args.value ?? "").length} characters`;
  if (name === "press_key") return `${String(args.key ?? "key")} · ${String(args.ref ?? "page")}`;
  if (name === "select_option") return `element ${String(args.ref ?? "?")} · option selected`;
  if (name === "scroll_page") return `${String(args.direction ?? "down")} · ${String(args.amount ?? "viewport")}`;
  if (name === "wait_for") return `${String(args.condition ?? "page_changed")} · ${String(args.ref ?? args.value ?? "page")}`.slice(0, 500);
  return String(args.path ?? args.query ?? "workspace").slice(0, 500);
}

export function pointInsideDisplay(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }): boolean {
  return Number.isInteger(x) && Number.isInteger(y)
    && x >= bounds.x && y >= bounds.y
    && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
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

async function assertRunnerTransport(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol === "https:") return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const parts = ipv4Parts(hostname);
  const words = ipv6Words(hostname);
  const ipv4Loopback = parts?.[0] === 127;
  const ipv6Loopback = words?.slice(0, 7).every((word) => word === 0) === true && words[7] === 1;
  if (!ipv4Loopback && !ipv6Loopback) {
    throw new Error("Plain-HTTP runner endpoints require a literal loopback address; use HTTPS for every remote runner");
  }
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

function ipv6Words(address: string): number[] | undefined {
  let value = address.toLowerCase().split("%")[0] ?? "";
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const parts = ipv4Parts(value.slice(separator + 1));
    if (separator < 0 || !parts) return undefined;
    value = `${value.slice(0, separator)}:${((parts[0] ?? 0) << 8 | (parts[1] ?? 0)).toString(16)}:${((parts[2] ?? 0) << 8 | (parts[3] ?? 0)).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return undefined;
  const [leftText = "", rightText = ""] = value.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = value.includes("::") && rightText ? rightText.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((!value.includes("::") && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    .map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

/** True for every address that is not ordinary globally routable unicast. */
export function isNonPublicAddress(address: string): boolean {
  const kind = isIP(address.split("%")[0] ?? address);
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = ipv4Parts(address) ?? [];
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (kind !== 6) return true;
  const words = ipv6Words(address);
  if (!words) return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isNonPublicAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = words[0] ?? 0;
  const isGlobalUnicast = first >= 0x2000 && first <= 0x3fff;
  const documentation = first === 0x2001 && words[1] === 0x0db8;
  const sixToFour = first === 0x2002;
  return !isGlobalUnicast || documentation || sixToFour;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be opened");
  if (url.username || url.password) throw new Error("URLs containing credentials are blocked");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isNonPublicAddress(entry.address))) {
    throw new Error("Private, local, and link-local network addresses are blocked from browser tools");
  }
}

export function domainAllowed(hostnameValue: string, allowlist: string[]): boolean {
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

async function browseUrl(value: string, allowlist: string[], approvedTarget: boolean, signal?: AbortSignal): Promise<string> {
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
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      headers: { "User-Agent": "GrokkyRunner/0.1 (+local computer tool)" },
    });
    const finalUrl = new URL(response.url);
    await assertPublicUrl(finalUrl);
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(?:html|plain)|application\/(?:json|xml)/i.test(contentType)) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    const raw = await boundedResponseText(response, MAX_LOCAL_PAGE_BYTES, "Page response");
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

async function boundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} is too large`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} is too large`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function jsonRequest<T>(url: string, init: RequestInit, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const response = await fetch(url, { ...init, signal });
    const raw = await boundedResponseText(response, MAX_RUNNER_RESPONSE_BYTES, "Runner response");
    let payload: { error?: string } & T;
    try {
      const value = raw ? JSON.parse(raw) : {};
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
      payload = value as { error?: string } & T;
    } catch {
      throw new RunnerHttpError(response.status, response.ok ? "Runner returned invalid JSON" : `Runner returned HTTP ${response.status}`);
    }
    if (!response.ok) throw new RunnerHttpError(response.status, payload.error || `Runner returned HTTP ${response.status}`);
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
  private readonly runnerTokenEpochs = new Map<string, number>();

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
        ...(device.protocolVersion ? { protocolVersion: device.protocolVersion } : {}),
        ...(device.browserTools ? { browserTools: [...device.browserTools] } : {}),
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

  async heartbeat(state: PersistedComputerAccess): Promise<boolean> {
    const results = await Promise.all(state.remoteDevices.filter((device) => !device.revoked).map(async (device) => {
      try {
        const payload = await this.remoteRequest<{ ok?: boolean; deviceId?: string; capabilities?: ComputerCapabilityId[]; protocolVersion?: number; browserTools?: string[] }>(device, "/heartbeat", {}, undefined, 5_000);
        if (payload.ok !== true || payload.deviceId !== device.id) return false;
        if (Array.isArray(payload.capabilities)) {
          device.capabilities = payload.capabilities.filter((capability) => localCapabilities.includes(capability));
        }
        if (Number.isSafeInteger(payload.protocolVersion) && (payload.protocolVersion ?? 0) >= 1) device.protocolVersion = payload.protocolVersion;
        if (Array.isArray(payload.browserTools)) device.browserTools = payload.browserTools.filter((tool): tool is string => typeof tool === "string" && semanticBrowserToolSet.has(tool));
        device.lastSeenAt = Date.now();
        return true;
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }

  setCapability(state: PersistedComputerAccess, capability: ComputerCapabilityId, level: ComputerAccessLevel): void {
    state.grants[capability] = level;
  }

  async pair(state: PersistedComputerAccess, endpointValue: string, code: string): Promise<void> {
    const endpoint = normalizedEndpoint(endpointValue);
    await assertRunnerTransport(endpoint);
    if (!/^\d{6}$/.test(code.trim()) && !/^gsk_[a-zA-Z0-9_-]{32,180}$/.test(code.trim())) {
      throw new Error("Enter a six-digit runner code or a valid sandbox enrollment key");
    }
    const payload = await jsonRequest<{
      device: { id: string; name: string; platform: string; root: string; capabilities: ComputerCapabilityId[] };
      token: string;
      tokenEpoch: number;
      protocolVersion?: number;
      browserTools?: string[];
    }>(`${endpoint}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    const validDevice = payload.device
      && typeof payload.device.id === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,179}$/.test(payload.device.id)
      && typeof payload.device.name === "string"
      && payload.device.name.length > 0
      && payload.device.name.length <= 120
      && typeof payload.device.platform === "string"
      && payload.device.platform.length > 0
      && payload.device.platform.length <= 80
      && typeof payload.device.root === "string"
      && payload.device.root.length > 0
      && payload.device.root.length <= 1_000
      && Array.isArray(payload.device.capabilities)
      && payload.device.capabilities.length <= 32;
    if (
      !validDevice
      || typeof payload.token !== "string"
      || payload.token.length < 16
      || payload.token.length > 4_096
      || !Number.isSafeInteger(payload.tokenEpoch)
      || payload.tokenEpoch < 1
    ) {
      throw new Error("Runner returned an invalid pairing response");
    }
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
      tokenEpoch: payload.tokenEpoch,
      ...(Number.isSafeInteger(payload.protocolVersion) && (payload.protocolVersion ?? 0) >= 1 ? { protocolVersion: payload.protocolVersion } : {}),
      ...(Array.isArray(payload.browserTools)
        ? { browserTools: payload.browserTools.filter((tool): tool is string => typeof tool === "string" && semanticBrowserToolSet.has(tool)) }
        : {}),
    };
    const existing = state.remoteDevices.findIndex((device) => device.id === record.id);
    if (existing >= 0) state.remoteDevices[existing] = record;
    else state.remoteDevices.push(record);
    this.runnerTokenEpochs.set(record.id, payload.tokenEpoch);
    state.activeDeviceId = record.id;
  }

  select(state: PersistedComputerAccess, deviceId: string): void {
    const valid = deviceId === state.localDeviceId || state.remoteDevices.some((device) => device.id === deviceId && !device.revoked);
    if (!valid) throw new Error("Computer is unavailable or revoked");
    state.activeDeviceId = deviceId;
  }

  async revoke(state: PersistedComputerAccess, deviceId: string): Promise<void> {
    if (deviceId === state.localDeviceId) throw new Error("The local computer cannot be revoked");
    const device = state.remoteDevices.find((item) => item.id === deviceId);
    if (!device) throw new Error("Computer not found");
    const payload = await this.remoteRequest<{ ok: boolean; receiptId?: string; tokenEpoch?: number }>(device, "/revoke", {});
    const previousEpoch = this.runnerTokenEpochs.get(device.id) ?? device.tokenEpoch ?? 1;
    const validReceipt = typeof payload.receiptId === "string" && /^runner-[a-zA-Z0-9_-]{8,160}$/.test(payload.receiptId);
    const validEpoch = Number.isSafeInteger(payload.tokenEpoch) && (payload.tokenEpoch ?? 0) > previousEpoch;
    if (payload.ok !== true || !validReceipt || !validEpoch) {
      throw new Error("Runner did not return a valid persisted revocation receipt");
    }
    this.runnerTokenEpochs.set(device.id, payload.tokenEpoch!);
    device.tokenEpoch = payload.tokenEpoch!;
    device.revoked = true;
    device.encryptedToken = "";
    if (state.activeDeviceId === deviceId) state.activeDeviceId = state.localDeviceId;
  }

  async test(state: PersistedComputerAccess, capability: ComputerCapabilityId, conversation: Conversation): Promise<string> {
    if (state.activeDeviceId !== state.localDeviceId) {
      const device = this.remoteDevice(state);
      const payload = await this.remoteRequest<{ ok: boolean; detail: string }>(device, "/test", { capability });
      if (payload.ok !== true || typeof payload.detail !== "string" || payload.detail.length > 4_000) {
        throw new Error("Runner returned an invalid capability-test response");
      }
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
    deviceId?: string;
    signal?: AbortSignal;
    auditContext?: { actionId: string; conversationId: string; agentComputerId?: string; agentName?: string; argumentDigest?: string };
  }): Promise<ComputerExecutionResult> {
    const { state, conversation, name, args } = options;
    if (!state.enabled) throw new Error("Computer access is disabled");
    const deviceId = options.deviceId ?? state.activeDeviceId;
    if (deviceId !== state.localDeviceId) {
      const device = this.remoteDevice(state, deviceId);
      if (name === "browse_url") await assertPublicUrl(new URL(String(args.url ?? "")));
      let result: { output: string; receiptId?: string; argumentDigest?: string; visualArtifact?: ComputerVisualArtifact; browserObservation?: unknown; browserOutcome?: unknown };
      try {
        result = await this.remoteRequest(device, "/execute", {
          name,
          args,
          mode: conversation.sandboxMode,
          allowCommands: conversation.allowCommands,
          approvedTarget: options.approvedTarget === true,
          networkAllowlist: state.networkAllowlist,
          ...(options.auditContext ? { auditContext: { ...options.auditContext, expiresAt: Date.now() + 120_000 } } : {}),
        }, options.signal);
      } catch (error) {
        if (error instanceof RunnerHttpError) throw error;
        throw new RemoteActionOutcomeUnknownError(
          "Remote runner did not return a conclusive execution receipt; the external outcome is unknown",
          { cause: error },
        );
      }
      const expectedDigest = options.auditContext?.argumentDigest ?? digestArguments(args);
      if (!/^runner-[a-zA-Z0-9_-]{8,160}$/.test(result.receiptId ?? "") || result.argumentDigest !== expectedDigest) {
        throw new RemoteActionOutcomeUnknownError("Runner execution receipt did not match the authorized action arguments; the external outcome is unknown");
      }
      if (typeof result.output !== "string" || result.output.length > MAX_RUNNER_OUTPUT_CHARACTERS) {
        throw new RemoteActionOutcomeUnknownError("Runner returned an invalid execution result; the external outcome is unknown");
      }
      if (result.output.startsWith("Sandbox action failed:")) {
        device.lastSeenAt = Date.now();
        throw new Error(result.output);
      }
      if (result.visualArtifact) {
        const artifact = result.visualArtifact;
        if (
          artifact.mimeType !== "image/png"
          || typeof artifact.dataBase64 !== "string"
          || artifact.dataBase64.length < 12
          || artifact.dataBase64.length > 6_000_000
          || !/^[a-zA-Z0-9+/]+={0,2}$/.test(artifact.dataBase64)
          || !/^[a-f0-9]{64}$/.test(artifact.sha256)
          || typeof artifact.currentUrl !== "string"
          || typeof artifact.pageTitle !== "string"
          || artifact.currentUrl.length > 4_000
          || artifact.pageTitle.length > 240
          || artifact.width !== 1280
          || artifact.height !== 800
          || (artifact.liveViewUrl !== undefined && !isValidBrowserLiveViewUrl(artifact.liveViewUrl))
        ) throw new RemoteActionOutcomeUnknownError("Runner returned an invalid visual artifact; the external outcome is unknown");
      }
      if (result.browserObservation !== undefined && !isValidBrowserObservation(result.browserObservation)) {
        throw new RemoteActionOutcomeUnknownError("Runner returned an invalid browser observation; the external outcome is unknown");
      }
      if (result.browserOutcome !== undefined && !isValidBrowserOutcome(result.browserOutcome)) {
        throw new RemoteActionOutcomeUnknownError("Runner returned an invalid browser action outcome; the external outcome is unknown");
      }
      device.lastSeenAt = Date.now();
      return {
        output: result.output,
        ...(result.visualArtifact ? { visualArtifact: result.visualArtifact } : {}),
        ...(result.browserObservation ? { browserObservation: result.browserObservation } : {}),
        ...(result.browserOutcome ? { browserOutcome: result.browserOutcome } : {}),
      };
    }
    if (workspaceTools.has(name as WorkspaceToolName)) {
      return { output: await executeWorkspaceTool({
        root: conversation.workingDirectory,
        mode: conversation.sandboxMode,
        allowCommands: conversation.allowCommands,
        name: name as WorkspaceToolName,
        args,
      }) };
    }
    if (name === "browse_url") return { output: await browseUrl(String(args.url ?? ""), state.networkAllowlist, options.approvedTarget === true, options.signal) };
    if (semanticBrowserToolSet.has(name)) throw new Error("Semantic browser actions require a compatible cloud browser seat");
    return { output: await this.host.execute(name as Exclude<ComputerToolName, WorkspaceToolName | "browse_url" | SemanticBrowserToolName>, args, conversation.workingDirectory) };
  }

  async disposeSeat(state: PersistedComputerAccess, deviceId: string, conversationId: string, agentComputerId: string): Promise<void> {
    if (deviceId === state.localDeviceId) return;
    const device = this.remoteDevice(state, deviceId);
    if (device.platform !== "cloudflare-linux" && !device.capabilities.includes("commands")) return;
    const result = await this.remoteRequest<{ ok?: boolean; receiptId?: string }>(device, "/dispose", { conversationId, agentComputerId }, undefined, 10_000);
    if (result.ok !== true || !/^runner-[a-zA-Z0-9_-]{8,160}$/.test(result.receiptId ?? "")) {
      throw new Error("Sandbox gateway did not confirm seat teardown");
    }
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

  private remoteDevice(state: PersistedComputerAccess, deviceId = state.activeDeviceId): PersistedRemoteDevice {
    const device = state.remoteDevices.find((item) => item.id === deviceId && !item.revoked);
    if (!device) throw new Error("Remote computer is unavailable or revoked");
    return device;
  }

  private async remoteRequest<T>(device: PersistedRemoteDevice, pathname: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 125_000): Promise<T> {
    await assertRunnerTransport(device.endpoint);
    const token = this.secrets.unseal(device.encryptedToken);
    if (!token) throw new Error("Remote computer credential is unavailable");
    return jsonRequest<T>(`${device.endpoint}${pathname}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }, timeoutMs);
  }
}

export function newAuditId(): string {
  return `computer-${randomUUID().replaceAll("-", "")}`;
}
