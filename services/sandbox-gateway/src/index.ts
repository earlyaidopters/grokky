import { getSandbox } from "@cloudflare/sandbox";
import { GrokkyControl } from "./control";
import {
  canonicalJson,
  commandFromArgs,
  gatewayCapabilities,
  mintDeviceToken,
  parseExecuteRequest,
  remoteWorkspacePath,
  sandboxIdFor,
  secureEqual,
  sha256Hex,
  verifyDeviceToken,
  type GatewayExecuteRequest,
} from "./protocol";
import { GrokkySandbox } from "./sandbox";

export { GrokkyControl, GrokkySandbox };

const MAX_JSON_BYTES = 300_000;
const MAX_TOOL_OUTPUT_BYTES = 120_000;

interface AuthorizedDevice {
  deviceId: string;
  epoch: number;
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) throw new Error("Request body is too large");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new Error("Request body is too large");
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function authorizeDevice(request: Request, env: Env): Promise<AuthorizedDevice | null> {
  const token = await verifyDeviceToken(bearer(request), env.GROKKY_TOKEN_SECRET);
  if (!token) return null;
  const epoch = await env.CONTROL.getByName(token.deviceId).currentEpoch(token.deviceId);
  return epoch === token.epoch ? { deviceId: token.deviceId, epoch } : null;
}

function parentPath(pathname: string): string {
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/workspace" : pathname.slice(0, index);
}

function trimmedOutput(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_BYTES ? `${value.slice(0, MAX_TOOL_OUTPUT_BYTES)}\n[truncated by Grokky sandbox gateway]` : value;
}

async function processOutput(sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>, argv: [string, ...string[]], timeout = 120_000): Promise<string> {
  const process = await sandbox.exec(argv, {
    cwd: "/workspace",
    env: { HOME: "/workspace", CI: "1", NO_COLOR: "1" },
    timeout,
  });
  const result = await process.output({ encoding: "utf8", maxBytes: MAX_TOOL_OUTPUT_BYTES, timeout: timeout + 5_000 });
  return trimmedOutput([
    `Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
    result.stdout ? `\nSTDOUT\n${result.stdout}` : "",
    result.stderr ? `\nSTDERR\n${result.stderr}` : "",
    result.truncated ? "\n[output truncated by sandbox runtime]" : "",
  ].join(""));
}

async function executeTool(sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>, request: GatewayExecuteRequest): Promise<string> {
  const { name, args } = request;
  if (name === "run_command") return processOutput(sandbox, ["/bin/bash", "-lc", commandFromArgs(args)]);
  if (name === "list_files") {
    const result = await sandbox.listFiles("/workspace", { recursive: true, includeHidden: false });
    const files = result.files
      .filter((file) => file.type === "file" && !file.relativePath.split("/").some((part) => [".git", "node_modules", "out", "release", "dist", "build", ".next"].includes(part)))
      .slice(0, 240)
      .map((file) => file.relativePath);
    return files.length ? files.join("\n") : "No readable files found.";
  }
  if (name === "search_files") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query || query.length > 500) throw new Error("Search query must be between 1 and 500 characters");
    return processOutput(sandbox, ["grep", "-R", "-n", "-F", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", query, "/workspace"], 30_000);
  }
  const pathname = remoteWorkspacePath(args.path);
  if (name === "read_file") {
    const result = await sandbox.readFile(pathname, { encoding: "utf8" });
    if (result.isBinary) throw new Error("Only UTF-8 text files can be read");
    return trimmedOutput(result.content);
  }
  if (name === "create_file") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content.length > 200_000) throw new Error("File content is too large");
    if ((await sandbox.exists(pathname)).exists) throw new Error("File already exists; use edit_file instead");
    await sandbox.mkdir(parentPath(pathname), { recursive: true });
    await sandbox.writeFile(pathname, content, { encoding: "utf8" });
    return `Created ${pathname.slice("/workspace/".length)}`;
  }
  const before = typeof args.old_text === "string" ? args.old_text : "";
  const after = typeof args.new_text === "string" ? args.new_text : "";
  if (!before) throw new Error("old_text cannot be empty");
  const current = await sandbox.readFile(pathname, { encoding: "utf8" });
  if (current.isBinary) throw new Error("Only UTF-8 text files can be edited");
  const first = current.content.indexOf(before);
  if (first < 0) throw new Error("old_text was not found");
  if (current.content.indexOf(before, first + before.length) >= 0) throw new Error("old_text is not unique; include more context");
  await sandbox.writeFile(pathname, `${current.content.slice(0, first)}${after}${current.content.slice(first + before.length)}`, { encoding: "utf8" });
  return `Updated ${pathname.slice("/workspace/".length)}`;
}

async function handlePair(body: Record<string, unknown>, env: Env): Promise<Response> {
  const enrollment = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^gsk_[a-zA-Z0-9_-]{32,180}$/.test(enrollment) || !await secureEqual(enrollment, env.GROKKY_ENROLLMENT_TOKEN)) {
    return json({ error: "Enrollment key is invalid or already used" }, 403);
  }
  const digest = await sha256Hex(enrollment);
  const control = env.CONTROL.getByName("enrollment");
  const result = await control.enroll(digest, Date.now());
  if (!result.ok) return json({ error: "Enrollment key is invalid or already used" }, 403);
  await env.CONTROL.getByName(result.deviceId).initDevice(result.deviceId, Date.now());
  const token = await mintDeviceToken({ deviceId: result.deviceId, epoch: result.epoch, issuedAt: Date.now() }, env.GROKKY_TOKEN_SECRET);
  return json({
    token,
    tokenEpoch: result.epoch,
    device: { id: result.deviceId, name: "Grokky Cloud Sandbox", platform: "cloudflare-linux", root: "/workspace", capabilities: gatewayCapabilities },
  });
}

async function handleExecute(body: Record<string, unknown>, device: AuthorizedDevice, env: Env): Promise<Response> {
  const request = parseExecuteRequest(body);
  const computedDigest = await sha256Hex(canonicalJson(request.args));
  if (computedDigest !== request.auditContext.argumentDigest) return json({ error: "Authorized argument digest does not match the runner request" }, 409);
  const identityDigest = await sha256Hex(`${device.deviceId}\n${request.auditContext.conversationId}\n${request.auditContext.agentComputerId}`);
  const sandbox = getSandbox(env.Sandbox, sandboxIdFor(request.auditContext.conversationId, request.auditContext.agentComputerId, identityDigest), {
    sleepAfter: "5m",
    keepAlive: false,
    normalizeId: true,
  });
  const claim = await sandbox.claimAction(request.auditContext.actionId, computedDigest, Date.now());
  if (claim.kind === "in-flight") return json({ error: "This action is already in flight; its outcome is not yet known", receiptId: claim.receiptId }, 409);
  if (claim.kind === "replay") return json({ output: claim.result.output, receiptId: claim.receiptId, argumentDigest: claim.result.argumentDigest, replayed: true });
  let output: string;
  try {
    output = await executeTool(sandbox, request);
  } catch (error) {
    output = `Sandbox action failed: ${error instanceof Error ? error.message : "unknown execution error"}`;
  }
  await sandbox.completeAction(request.auditContext.actionId, computedDigest, output, Date.now());
  return json({ output, receiptId: claim.receiptId, argumentDigest: computedDigest });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "grokky-sandbox-gateway", isolation: "disposable-container", capabilities: gatewayCapabilities });
      }
      if (request.method !== "POST") return json({ error: "Route not found" }, 404);
      const body = await boundedJson(request);
      if (url.pathname === "/pair") return handlePair(body, env);
      const device = await authorizeDevice(request, env);
      if (!device) return json({ error: "Runner authorization failed" }, 401);
      if (url.pathname === "/heartbeat") {
        return json({ ok: true, deviceId: device.deviceId, tokenEpoch: device.epoch, capabilities: gatewayCapabilities });
      }
      if (url.pathname === "/revoke") {
        const tokenEpoch = await env.CONTROL.getByName(device.deviceId).revoke(device.deviceId, device.epoch, Date.now());
        if (!tokenEpoch) return json({ error: "Runner authorization is stale" }, 409);
        return json({ ok: true, receiptId: `runner-${crypto.randomUUID().replaceAll("-", "")}`, tokenEpoch });
      }
      if (url.pathname === "/test") {
        if (body.capability !== "files" && body.capability !== "commands") return json({ error: "Capability is unavailable on this runner" }, 400);
        const sandbox = getSandbox(env.Sandbox, `test-${device.deviceId.slice("sandbox-".length)}`, { sleepAfter: "1m", normalizeId: true });
        try {
          const detail = body.capability === "commands"
            ? await processOutput(sandbox, ["/usr/bin/id", "-u"], 20_000)
            : (await sandbox.listFiles("/workspace", { recursive: false })).success ? "Sandbox workspace is readable." : "Sandbox workspace probe failed.";
          return json({ ok: true, detail: `Disposable sandbox provisioned successfully. ${detail}` });
        } finally {
          await sandbox.destroy();
        }
      }
      if (url.pathname === "/dispose") {
        const conversationId = typeof body.conversationId === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(body.conversationId) ? body.conversationId : "";
        const agentComputerId = typeof body.agentComputerId === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(body.agentComputerId) ? body.agentComputerId : "";
        if (!conversationId || !agentComputerId) return json({ error: "A valid seat identity is required" }, 400);
        const identityDigest = await sha256Hex(`${device.deviceId}\n${conversationId}\n${agentComputerId}`);
        const sandbox = getSandbox(env.Sandbox, sandboxIdFor(conversationId, agentComputerId, identityDigest), { normalizeId: true });
        await sandbox.destroy();
        return json({ ok: true, receiptId: `runner-${crypto.randomUUID().replaceAll("-", "")}` });
      }
      if (url.pathname === "/execute") return handleExecute(body, device, env);
      return json({ error: "Route not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: "sandbox gateway request failed", requestId, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: error instanceof SyntaxError ? "Invalid JSON request" : error instanceof Error ? error.message : "Sandbox gateway request failed", requestId }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
