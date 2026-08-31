import { getSandbox } from "@cloudflare/sandbox";
import { GrokkyControl } from "./control";
import { boundedJson } from "./http";
import {
  canonicalJson,
  browserTools,
  browserUrlFromArgs,
  commandFromArgs,
  GATEWAY_PROTOCOL_VERSION,
  gatewayCapabilities,
  mintDeviceToken,
  parseExecuteRequest,
  remoteWorkspacePath,
  sandboxIdFor,
  secureEqual,
  semanticBrowserFeatureVersion,
  semanticBrowserTools,
  sha256Hex,
  verifyDeviceToken,
  type GatewayExecuteRequest,
} from "./protocol";
import { GrokkySandbox, type BrowserActionResult, type StoredActionResult, type StoredBrowserVisualArtifact } from "./sandbox";

export { GrokkyControl, GrokkySandbox };

const MAX_TOOL_OUTPUT_BYTES = 120_000;
const MAX_WRITABLE_FILE_BYTES = 500_000;
const textEncoder = new TextEncoder();

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
  const bytes = textEncoder.encode(value);
  const suffix = "\n[truncated by Grokky sandbox gateway]";
  const suffixBytes = textEncoder.encode(suffix);
  return bytes.length > MAX_TOOL_OUTPUT_BYTES
    ? `${new TextDecoder().decode(bytes.slice(0, MAX_TOOL_OUTPUT_BYTES - suffixBytes.length))}${suffix}`
    : value;
}

async function readBoundedUtf8(
  sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>,
  pathname: string,
  maximum = MAX_WRITABLE_FILE_BYTES,
): Promise<string> {
  const result = await sandbox.readFile(pathname, { encoding: "none" });
  if (result.size > maximum) {
    await result.content.cancel().catch(() => undefined);
    throw new Error(`File is too large; the sandbox limit is ${maximum} bytes`);
  }
  const reader = result.content.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let content = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`File is too large; the sandbox limit is ${maximum} bytes`);
      }
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Only UTF-8 text files can be read or edited");
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function listWorkspaceFiles(sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>): Promise<string[]> {
  const command = "find /workspace -type d \\( -name .git -o -name node_modules -o -name out -o -name release -o -name dist -o -name build -o -name .next \\) -prune -o -type f -print | head -n 2000";
  const process = await sandbox.exec(["/bin/bash", "-lc", command], {
    cwd: "/workspace",
    env: { HOME: "/workspace", CI: "1", NO_COLOR: "1" },
    timeout: 30_000,
  });
  const result = await process.output({ encoding: "utf8", maxBytes: MAX_TOOL_OUTPUT_BYTES, timeout: 35_000 });
  if (result.timedOut || result.exitCode !== 0) throw new Error("Sandbox file listing failed");
  return result.stdout.split("\n").flatMap((absolutePath) => {
    const relativePath = absolutePath.startsWith("/workspace/") ? absolutePath.slice("/workspace/".length) : "";
    if (!relativePath) return [];
    try {
      remoteWorkspacePath(relativePath);
      return [relativePath];
    } catch {
      return [];
    }
  }).slice(0, 240);
}

async function assertWorkspaceTarget(
  sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>,
  pathname: string,
  allowMissing = false,
): Promise<void> {
  const process = await sandbox.exec(["readlink", allowMissing ? "-m" : "-f", "--", pathname], {
    cwd: "/workspace",
    env: { HOME: "/workspace", CI: "1", NO_COLOR: "1" },
    timeout: 10_000,
  });
  const result = await process.output({ encoding: "utf8", maxBytes: 4_096, timeout: 15_000 });
  const resolved = result.stdout.trim();
  if (result.timedOut || result.exitCode !== 0 || (resolved !== "/workspace" && !resolved.startsWith("/workspace/"))) {
    throw new Error("Symlinked paths outside the sandbox workspace are blocked");
  }
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

function browserHostAllowed(hostname: string, allowlist: string[]): boolean {
  const target = hostname.toLowerCase();
  return allowlist.some((entry) => {
    try {
      const normalized = entry.trim().replace(/^https?:\/\//i, "").replace(/^\*\./, "").split("/")[0];
      const host = new URL(`https://${normalized}`).hostname.toLowerCase();
      return target === host || target.endsWith(`.${host}`);
    } catch {
      return false;
    }
  });
}

async function executeTool(sandbox: ReturnType<typeof getSandbox<GrokkySandbox>>, request: GatewayExecuteRequest): Promise<BrowserActionResult> {
  const { name, args } = request;
  if (browserTools.includes(name as typeof browserTools[number])) {
    if (name === "browse_url") {
      const target = browserUrlFromArgs(args);
      if (!request.approvedTarget && !browserHostAllowed(target.hostname, request.networkAllowlist)) {
        throw new Error(`The browser target ${target.hostname} was not authorized by Grokky`);
      }
    }
    return sandbox.executeBrowserAction(name as typeof browserTools[number], args, request.networkAllowlist);
  }
  if (name === "run_command") return { output: await processOutput(sandbox, ["/bin/bash", "-lc", commandFromArgs(args)]) };
  if (name === "list_files") {
    const files = await listWorkspaceFiles(sandbox);
    return { output: files.length ? files.join("\n") : "No readable files found." };
  }
  if (name === "search_files") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query || query.length > 500) throw new Error("Search query must be between 1 and 500 characters");
    return { output: await processOutput(sandbox, ["grep", "-r", "-n", "-F", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", query, "/workspace"], 30_000) };
  }
  const pathname = remoteWorkspacePath(args.path);
  if (name === "read_file") {
    await assertWorkspaceTarget(sandbox, pathname);
    return { output: trimmedOutput(await readBoundedUtf8(sandbox, pathname)) };
  }
  if (name === "create_file") {
    const content = typeof args.content === "string" ? args.content : "";
    if (textEncoder.encode(content).length > 200_000) throw new Error("File content is too large");
    if ((await sandbox.exists(pathname)).exists) throw new Error("File already exists; use edit_file instead");
    await assertWorkspaceTarget(sandbox, pathname, true);
    await sandbox.mkdir(parentPath(pathname), { recursive: true });
    await sandbox.writeFile(pathname, content, { encoding: "utf8" });
    return { output: `Created ${pathname.slice("/workspace/".length)}` };
  }
  const before = typeof args.old_text === "string" ? args.old_text : "";
  const after = typeof args.new_text === "string" ? args.new_text : "";
  if (!before) throw new Error("old_text cannot be empty");
  if (textEncoder.encode(before).length > 200_000 || textEncoder.encode(after).length > 200_000) throw new Error("Edit text is too large");
  await assertWorkspaceTarget(sandbox, pathname);
  const current = await readBoundedUtf8(sandbox, pathname);
  const first = current.indexOf(before);
  if (first < 0) throw new Error("old_text was not found");
  if (current.indexOf(before, first + before.length) >= 0) throw new Error("old_text is not unique; include more context");
  const updated = `${current.slice(0, first)}${after}${current.slice(first + before.length)}`;
  if (textEncoder.encode(updated).length > MAX_WRITABLE_FILE_BYTES) throw new Error(`Edited file is too large; the sandbox limit is ${MAX_WRITABLE_FILE_BYTES} bytes`);
  await sandbox.writeFile(pathname, updated, { encoding: "utf8" });
  return { output: `Updated ${pathname.slice("/workspace/".length)}` };
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
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    browserTools: semanticBrowserTools,
    semanticBrowser: semanticBrowserFeatureVersion,
    device: { id: result.deviceId, name: "Grokky Cloud Sandbox", platform: "cloudflare-linux", root: "/workspace", capabilities: gatewayCapabilities },
  });
}

async function handleExecute(body: Record<string, unknown>, device: AuthorizedDevice, env: Env): Promise<Response> {
  let request: GatewayExecuteRequest;
  try {
    request = parseExecuteRequest(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid execution request" }, 400);
  }
  const computedDigest = await sha256Hex(canonicalJson(request.args));
  if (computedDigest !== request.auditContext.argumentDigest) return json({ error: "Authorized argument digest does not match the runner request" }, 409);
  const identityDigest = await sha256Hex(`${device.deviceId}\n${request.auditContext.conversationId}\n${request.auditContext.agentComputerId}`);
  const sandbox = getSandbox(env.Sandbox, sandboxIdFor(request.auditContext.conversationId, request.auditContext.agentComputerId, identityDigest), {
    sleepAfter: "5m",
    keepAlive: false,
    normalizeId: true,
  });
  const claim = await sandbox.claimAction(request.auditContext.actionId, computedDigest, Date.now());
  if (claim.kind === "conflict") return json({ error: "Action ID was already claimed for different arguments", receiptId: claim.receiptId }, 409);
  if (claim.kind === "in-flight") return json({ error: "This action is already in flight; its outcome is not yet known", receiptId: claim.receiptId }, 409);
  if (claim.kind === "replay") return json({ ...claim.result, receiptId: claim.receiptId, replayed: true });
  let result: BrowserActionResult;
  try {
    result = await executeTool(sandbox, request);
  } catch (error) {
    result = { output: `Sandbox action failed: ${error instanceof Error ? error.message : "unknown execution error"}` };
  }
  result.output = trimmedOutput(result.output);
  const storedVisualArtifact: StoredBrowserVisualArtifact | undefined = result.visualArtifact ? {
    mimeType: result.visualArtifact.mimeType,
    dataBase64: result.visualArtifact.dataBase64,
    sha256: result.visualArtifact.sha256,
    currentUrl: result.visualArtifact.currentUrl,
    pageTitle: result.visualArtifact.pageTitle,
    width: result.visualArtifact.width,
    height: result.visualArtifact.height,
  } : undefined;
  const storedResult: StoredActionResult = {
    output: result.output,
    argumentDigest: computedDigest,
    ...(storedVisualArtifact ? { visualArtifact: storedVisualArtifact } : {}),
    ...(result.browserObservation ? { browserObservation: result.browserObservation } : {}),
    ...(result.browserOutcome ? { browserOutcome: result.browserOutcome } : {}),
  };
  await sandbox.completeAction(request.auditContext.actionId, storedResult, Date.now());
  return json({ ...result, argumentDigest: computedDigest, receiptId: claim.receiptId });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          service: "grokky-sandbox-gateway",
          isolation: "disposable-container",
          capabilities: gatewayCapabilities,
          protocolVersion: GATEWAY_PROTOCOL_VERSION,
          browserTools: semanticBrowserTools,
          semanticBrowser: semanticBrowserFeatureVersion,
        });
      }
      if (request.method !== "POST") return json({ error: "Route not found" }, 404);
      const body = await boundedJson(request);
      if (url.pathname === "/pair") return await handlePair(body, env);
      const device = await authorizeDevice(request, env);
      if (!device) return json({ error: "Runner authorization failed" }, 401);
      if (url.pathname === "/heartbeat") {
        return json({
          ok: true,
          deviceId: device.deviceId,
          tokenEpoch: device.epoch,
          capabilities: gatewayCapabilities,
          protocolVersion: GATEWAY_PROTOCOL_VERSION,
          browserTools: semanticBrowserTools,
          semanticBrowser: semanticBrowserFeatureVersion,
        });
      }
      if (url.pathname === "/revoke") {
        const tokenEpoch = await env.CONTROL.getByName(device.deviceId).revoke(device.deviceId, device.epoch, Date.now());
        if (!tokenEpoch) return json({ error: "Runner authorization is stale" }, 409);
        return json({ ok: true, receiptId: `runner-${crypto.randomUUID().replaceAll("-", "")}`, tokenEpoch });
      }
      if (url.pathname === "/test") {
        if (!gatewayCapabilities.includes(body.capability as typeof gatewayCapabilities[number])) return json({ error: "Capability is unavailable on this runner" }, 400);
        const sandbox = getSandbox(env.Sandbox, `test-${device.deviceId.slice("sandbox-".length)}`, { sleepAfter: "1m", normalizeId: true });
        try {
          const detail = body.capability === "commands"
            ? await processOutput(sandbox, ["/usr/bin/id", "-u"], 20_000)
            : body.capability === "files"
              ? (await sandbox.listFiles("/workspace", { recursive: false })).success ? "Sandbox workspace is readable." : "Sandbox workspace probe failed."
              : (await sandbox.executeBrowserAction("browse_url", { url: "https://example.com" }, ["example.com"])).output.split("\n").slice(0, 4).join(" ");
          return json({ ok: true, detail: `Disposable sandbox provisioned successfully. ${detail}` });
        } finally {
          await sandbox.disposeBrowser().catch(() => undefined);
          await sandbox.destroy();
        }
      }
      if (url.pathname === "/dispose") {
        const conversationId = typeof body.conversationId === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(body.conversationId) ? body.conversationId : "";
        const agentComputerId = typeof body.agentComputerId === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(body.agentComputerId) ? body.agentComputerId : "";
        if (!conversationId || !agentComputerId) return json({ error: "A valid seat identity is required" }, 400);
        const identityDigest = await sha256Hex(`${device.deviceId}\n${conversationId}\n${agentComputerId}`);
        const sandbox = getSandbox(env.Sandbox, sandboxIdFor(conversationId, agentComputerId, identityDigest), { normalizeId: true });
        await sandbox.disposeBrowser().catch(() => undefined);
        await sandbox.destroy();
        return json({ ok: true, receiptId: `runner-${crypto.randomUUID().replaceAll("-", "")}` });
      }
      if (url.pathname === "/execute") return await handleExecute(body, device, env);
      return json({ error: "Route not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: "sandbox gateway request failed", requestId, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: error instanceof SyntaxError ? "Invalid JSON request" : error instanceof Error ? error.message : "Sandbox gateway request failed", requestId }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
