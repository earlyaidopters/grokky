export const gatewayCapabilities = ["files", "commands", "browser", "screen", "automation"] as const;
export const workspaceTools = ["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"] as const;
export const legacyBrowserTools = ["browse_url", "capture_screen", "open_application", "click_screen", "type_text"] as const;
export const semanticBrowserTools = ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"] as const;
export const browserTools = [...legacyBrowserTools, ...semanticBrowserTools] as const;

export const GATEWAY_PROTOCOL_VERSION = 2;
export const semanticBrowserFeatureVersion = "v1" as const;

export type GatewayToolName = typeof workspaceTools[number] | typeof browserTools[number];
export type BrowserToolName = typeof browserTools[number];

export interface GatewayAuditContext {
  actionId: string;
  conversationId: string;
  agentComputerId: string;
  agentName?: string;
  argumentDigest: string;
  expiresAt: number;
}

export interface GatewayExecuteRequest {
  name: GatewayToolName;
  args: Record<string, unknown>;
  mode: "read-only" | "workspace-write";
  allowCommands: boolean;
  approvedTarget: boolean;
  networkAllowlist: string[];
  auditContext: GatewayAuditContext;
}

export type BrowserInspectMode = "interactive" | "content" | "both";
export type BrowserWaitCondition = "url_contains" | "text_visible" | "text_hidden" | "element_visible" | "element_hidden" | "value_equals" | "page_changed";

export interface BrowserInspectArguments {
  mode: BrowserInspectMode;
  limit: number;
}

export interface BrowserScrollArguments {
  direction: "up" | "down";
  amount: number;
  ref?: string;
}

export interface BrowserWaitArguments {
  condition: BrowserWaitCondition;
  timeoutMs: number;
  ref?: string;
  value?: string;
  fingerprint?: string;
}

const encoder = new TextEncoder();
const gatewayToolSet = new Set<string>([...workspaceTools, ...browserTools]);
const excludedSegments = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".wrangler", "node_modules", "out", "release", "dist", "build", ".next"]);
const blockedNames = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|auth\.json|credentials?(?:\..*)?|secrets?\.(?:json|ya?ml|txt)|\.npmrc|\.netrc|id_[^.]+(?:\.pub)?)$/i;
const blockedExtensions = /\.(?:pem|key|p12|pfx)$/i;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function secureEqual(left: string, right: string): Promise<boolean> {
  const key = await hmacKey(right);
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(right));
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(left));
}

export async function mintDeviceToken(payload: { deviceId: string; epoch: number; issuedAt: number }, secret: string): Promise<string> {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify({ v: 1, ...payload })));
  return `${encoded}.${base64UrlEncode(await hmac(encoded, secret))}`;
}

export async function verifyDeviceToken(token: string, secret: string): Promise<{ deviceId: string; epoch: number; issuedAt: number } | null> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  let supplied: Uint8Array;
  try {
    supplied = base64UrlDecode(signature);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const suppliedBytes = new Uint8Array([...supplied]);
  if (!await crypto.subtle.verify("HMAC", key, suppliedBytes, encoder.encode(encoded))) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.deviceId !== "string" || !/^sandbox-[a-f0-9]{32}$/.test(value.deviceId)) return null;
    if (!Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 || !Number.isSafeInteger(value.issuedAt)) return null;
    return { deviceId: value.deviceId, epoch: Number(value.epoch), issuedAt: Number(value.issuedAt) };
  } catch {
    return null;
  }
}

function requireBoundedString(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || value.length > maximum || (pattern && !pattern.test(value))) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseExecuteRequest(value: unknown, now = Date.now()): GatewayExecuteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  const input = value as Record<string, unknown>;
  const name = requireBoundedString(input.name, "tool name", 40) as GatewayToolName;
  if (!gatewayToolSet.has(name)) throw new Error("Runner tool is unsupported");
  const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args as Record<string, unknown> : {};
  const mode = input.mode === "workspace-write" ? "workspace-write" : "read-only";
  const allowCommands = input.allowCommands === true;
  const approvedTarget = input.approvedTarget === true;
  const networkAllowlist = Array.isArray(input.networkAllowlist)
    ? input.networkAllowlist
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 300)
      .slice(0, 80)
    : [];
  if (!input.auditContext || typeof input.auditContext !== "object" || Array.isArray(input.auditContext)) throw new Error("A seat-bound action lease is required");
  const audit = input.auditContext as Record<string, unknown>;
  const expiresAt = Number(audit.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now - 5_000 || expiresAt > now + 5 * 60_000) throw new Error("Action lease is expired or invalid");
  const auditContext: GatewayAuditContext = {
    actionId: requireBoundedString(audit.actionId, "action ID", 160, /^[a-zA-Z0-9:_-]{8,160}$/),
    conversationId: requireBoundedString(audit.conversationId, "conversation ID", 160, /^[a-zA-Z0-9:_-]{8,160}$/),
    agentComputerId: requireBoundedString(audit.agentComputerId, "agent computer ID", 160, /^[a-zA-Z0-9:_-]{8,160}$/),
    ...(typeof audit.agentName === "string" && audit.agentName ? { agentName: audit.agentName.slice(0, 120) } : {}),
    argumentDigest: requireBoundedString(audit.argumentDigest, "argument digest", 64, /^[a-f0-9]{64}$/),
    expiresAt,
  };
  if (name === "run_command" && (mode !== "workspace-write" || !allowCommands)) throw new Error("Commands require an explicit Full access conversation");
  if ((name === "create_file" || name === "edit_file") && mode !== "workspace-write") throw new Error("This conversation is read-only");
  return { name, args, mode, allowCommands, approvedTarget, networkAllowlist, auditContext };
}

function ipv4Parts(value: string): number[] | undefined {
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

function nonPublicIpv4(parts: number[]): boolean {
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2))
    || (parts[0] === 192 && parts[1] === 88 && parts[2] === 99)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51))
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || (parts[0] ?? 0) >= 224;
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
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

function nonPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    const mappedAddress = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    const parts = ipv4Parts(mappedAddress)!;
    return nonPublicIpv4(parts);
  }
  const first = words[0] ?? 0;
  const globalUnicast = first >= 0x2000 && first <= 0x3fff;
  const documentation = first === 0x2001 && words[1] === 0x0db8;
  const sixToFour = first === 0x2002;
  return !globalUnicast || documentation || sixToFour;
}

/** Conservative URL boundary for the Cloudflare browser before Chromium sees a target. */
export function browserUrlFromArgs(args: Record<string, unknown>): URL {
  const value = requireBoundedString(args.url, "browser URL", 4_000);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be opened");
  if (url.username || url.password) throw new Error("URLs containing credentials are blocked");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = ipv4Parts(hostname);
  const blockedIpv4 = ipv4 && nonPublicIpv4(ipv4);
  const blockedIpv6 = hostname.includes(":") && nonPublicIpv6(hostname);
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "::"
    || hostname === "::1"
    || /^f[cd]/.test(hostname)
    || /^fe[89ab]/.test(hostname)
    || /^ff/.test(hostname)
    || blockedIpv6
    || blockedIpv4
  ) throw new Error("Private, local, and link-local network addresses are blocked from browser tools");
  return url;
}

export function browserPointFromArgs(args: Record<string, unknown>): { x: number; y: number } {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 1280 || y >= 800) {
    throw new Error("Browser clicks must stay inside the current 1280 by 800 frame");
  }
  return { x, y };
}

export function browserTextFromArgs(args: Record<string, unknown>): string {
  return requireBoundedString(args.text, "text input", 20_000);
}

export function browserElementRefFromArgs(args: Record<string, unknown>, optional = false): string | undefined {
  if (optional && (args.ref === undefined || args.ref === null || args.ref === "")) return undefined;
  return requireBoundedString(args.ref, "element reference", 180, /^el-[a-zA-Z0-9_-]{8,176}$/);
}

export function browserInspectFromArgs(args: Record<string, unknown>): BrowserInspectArguments {
  const mode = args.mode === "content" || args.mode === "both" ? args.mode : "interactive";
  const requested = args.limit === undefined ? 80 : Number(args.limit);
  if (!Number.isInteger(requested) || requested < 1 || requested > 120) throw new Error("Page inspection limit must be between 1 and 120");
  return { mode, limit: requested };
}

export function browserFillFromArgs(args: Record<string, unknown>): { ref: string; value: string } {
  const ref = browserElementRefFromArgs(args);
  const value = typeof args.value === "string" ? args.value : undefined;
  if (value === undefined || value.length > 4_000 || /\0/.test(value)) throw new Error("Field value must contain at most 4,000 characters and no null bytes");
  return { ref: ref!, value };
}

const browserKeys = new Set([
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space",
  "Control+A", "Meta+A", "Shift+Tab",
]);

export function browserKeyFromArgs(args: Record<string, unknown>): { key: string; ref?: string } {
  const key = requireBoundedString(args.key, "browser key", 40);
  if (!browserKeys.has(key)) throw new Error("Browser key is not allowed");
  const ref = browserElementRefFromArgs(args, true);
  return { key, ...(ref ? { ref } : {}) };
}

export function browserSelectFromArgs(args: Record<string, unknown>): { ref: string; value: string } {
  const ref = browserElementRefFromArgs(args);
  const value = requireBoundedString(args.value, "option value", 500);
  return { ref: ref!, value };
}

export function browserScrollFromArgs(args: Record<string, unknown>): BrowserScrollArguments {
  const direction = args.direction === "up" ? "up" : args.direction === "down" ? "down" : undefined;
  if (!direction) throw new Error("Scroll direction must be up or down");
  const amount = args.amount === undefined ? 640 : Number(args.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 4_000) throw new Error("Scroll amount must be between 1 and 4,000 pixels");
  const ref = browserElementRefFromArgs(args, true);
  return { direction, amount, ...(ref ? { ref } : {}) };
}

export function browserWaitFromArgs(args: Record<string, unknown>): BrowserWaitArguments {
  const conditions = new Set<BrowserWaitCondition>(["url_contains", "text_visible", "text_hidden", "element_visible", "element_hidden", "value_equals", "page_changed"]);
  const condition = typeof args.condition === "string" && conditions.has(args.condition as BrowserWaitCondition)
    ? args.condition as BrowserWaitCondition
    : undefined;
  if (!condition) throw new Error("Unsupported browser wait condition");
  const timeoutMs = args.timeout_ms === undefined ? 5_000 : Number(args.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw new Error("Wait timeout must be between 100 and 15,000 milliseconds");
  const ref = browserElementRefFromArgs(args, true);
  const value = typeof args.value === "string" && args.value.length <= 1_000 ? args.value : undefined;
  const fingerprint = typeof args.fingerprint === "string" && /^[a-f0-9]{64}$/.test(args.fingerprint) ? args.fingerprint : undefined;
  if ((condition === "element_visible" || condition === "element_hidden" || condition === "value_equals") && !ref) throw new Error(`${condition} requires an element reference`);
  if ((condition === "url_contains" || condition === "text_visible" || condition === "text_hidden" || condition === "value_equals") && value === undefined) throw new Error(`${condition} requires a value`);
  if (condition === "page_changed" && !fingerprint) throw new Error("page_changed requires a prior fingerprint");
  return { condition, timeoutMs, ...(ref ? { ref } : {}), ...(value !== undefined ? { value } : {}), ...(fingerprint ? { fingerprint } : {}) };
}

export function browserApplicationFromArgs(args: Record<string, unknown>): "browser" | "terminal" | "files" {
  const value = requireBoundedString(args.name, "application name", 120).trim().toLowerCase();
  if (/^(?:browser|chrome|chromium|web)$/.test(value)) return "browser";
  if (/^(?:terminal|shell|console)$/.test(value)) return "terminal";
  if (/^(?:files|file browser|workspace)$/.test(value)) return "files";
  throw new Error("This cloud computer currently exposes Browser, Terminal, and Files");
}

export function remoteWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2_000 || value.startsWith("/") || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) throw new Error("Tool paths must be relative to the sandbox workspace");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || excludedSegments.has(segment))) throw new Error("That path is excluded from sandbox workspace tools");
  if (segments.some((segment) => blockedNames.test(segment) || blockedExtensions.test(segment))) throw new Error("Credential and private-key files are never exposed to model tools");
  return `/workspace/${segments.join("/")}`;
}

export function commandFromArgs(args: Record<string, unknown>): string {
  const command = requireBoundedString(args.command, "command", 20_000).trim();
  if (!command) throw new Error("Command cannot be empty");
  return command;
}

export function sandboxIdFor(conversationId: string, agentComputerId: string, digest: string): string {
  return `seat-${digest.slice(0, 48)}`;
}
