export const gatewayCapabilities = ["files", "commands", "browser", "screen", "automation"] as const;
export const workspaceTools = ["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"] as const;
export const browserTools = ["browse_url", "capture_screen", "open_application", "click_screen", "type_text"] as const;

export type GatewayToolName = typeof workspaceTools[number] | typeof browserTools[number];

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

const encoder = new TextEncoder();
const gatewayToolSet = new Set<string>([...workspaceTools, ...browserTools]);
const excludedSegments = new Set([".git", "node_modules", "out", "release", "dist", "build", ".next"]);
const blockedNames = /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|\.npmrc|\.netrc|id_[^.]+(?:\.pub)?)$/i;
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

/** Conservative URL boundary for the Cloudflare browser before Chromium sees a target. */
export function browserUrlFromArgs(args: Record<string, unknown>): URL {
  const value = requireBoundedString(args.url, "browser URL", 4_000);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be opened");
  if (url.username || url.password) throw new Error("URLs containing credentials are blocked");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = ipv4Parts(hostname);
  const blockedIpv4 = ipv4 && (
    ipv4[0] === 0
    || ipv4[0] === 10
    || ipv4[0] === 127
    || (ipv4[0] === 100 && (ipv4[1] ?? 0) >= 64 && (ipv4[1] ?? 0) <= 127)
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && (ipv4[1] ?? 0) >= 16 && (ipv4[1] ?? 0) <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 0 && (ipv4[2] === 0 || ipv4[2] === 2))
    || (ipv4[0] === 192 && ipv4[1] === 168)
    || (ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19 || ipv4[1] === 51))
    || (ipv4[0] === 203 && ipv4[1] === 0 && ipv4[2] === 113)
    || (ipv4[0] ?? 0) >= 224
  );
  const mappedIpv4 = hostname.startsWith("::ffff:") ? ipv4Parts(hostname.slice("::ffff:".length)) : undefined;
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
    || Boolean(mappedIpv4)
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

export function browserApplicationFromArgs(args: Record<string, unknown>): "browser" | "terminal" | "files" {
  const value = requireBoundedString(args.name, "application name", 120).trim().toLowerCase();
  if (/^(?:browser|chrome|chromium|web)$/.test(value)) return "browser";
  if (/^(?:terminal|shell|console)$/.test(value)) return "terminal";
  if (/^(?:files|file browser|workspace)$/.test(value)) return "files";
  throw new Error("This cloud computer currently exposes Browser, Terminal, and Files");
}

export function remoteWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2_000 || value.startsWith("/") || value.includes("\\")) throw new Error("Tool paths must be relative to the sandbox workspace");
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
