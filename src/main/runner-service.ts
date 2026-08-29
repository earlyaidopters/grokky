import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerCapabilityId, SandboxMode } from "../shared/contracts";
import { executeWorkspaceTool, type WorkspaceToolName } from "./workspace-tools";

interface RunnerDiskState {
  deviceId: string;
  token: string;
  tokenEpoch: number;
}

interface RunnerOptions {
  root: string;
  host: string;
  port: number;
  statePath: string;
  allowWrite: boolean;
  allowCommands: boolean;
  onReady?(details: { endpoint: string; code: string; deviceId: string }): void;
}

interface RunnerHandle {
  endpoint: string;
  code: string;
  deviceId: string;
  close(): Promise<void>;
}

async function saveRunnerState(pathname: string, state: RunnerDiskState): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  const temporaryPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, pathname);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function appendRunnerAudit(pathname: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  await appendFile(pathname, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const toolNames = new Set<WorkspaceToolName>(["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"]);

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

function pairingCode(): string {
  return String(Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000).padStart(6, "0");
}

function tokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadRunnerState(pathname: string): Promise<RunnerDiskState> {
  try {
    const value = JSON.parse(await readFile(pathname, "utf8")) as Partial<RunnerDiskState>;
    if (typeof value.deviceId === "string" && typeof value.token === "string") {
      const tokenEpoch = typeof value.tokenEpoch === "number" && Number.isSafeInteger(value.tokenEpoch) && value.tokenEpoch >= 1 ? value.tokenEpoch : 1;
      return { deviceId: value.deviceId, token: value.token, tokenEpoch };
    }
  } catch {
    // The first run creates a private state file below.
  }
  const state = { deviceId: `remote-${randomUUID().replaceAll("-", "")}`, token: randomBytes(32).toString("base64url"), tokenEpoch: 1 };
  await saveRunnerState(pathname, state);
  return state;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 250_000) request.destroy(new Error("Request body is too large"));
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
        resolvePromise(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function send(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export async function startRunnerServer(options: Partial<RunnerOptions> & Pick<RunnerOptions, "root" | "statePath">): Promise<RunnerHandle> {
  const root = resolve(options.root);
  const statePath = resolve(options.statePath);
  const auditPath = `${statePath}.audit.jsonl`;
  const stateFromRoot = relative(root, statePath);
  if (stateFromRoot === "" || (!stateFromRoot.startsWith(`..${sep}`) && stateFromRoot !== ".." && !isAbsolute(stateFromRoot))) {
    throw new Error("Runner state must be stored outside the workspace root exposed to agents");
  }
  const state = await loadRunnerState(statePath);
  let code = pairingCode();
  let codeIssuedAt = Date.now();
  let failedPairAttempts = 0;
  const capabilities: ComputerCapabilityId[] = ["files"];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runner.local");
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, {
          ok: true,
          device: { id: state.deviceId, name: hostname() || "Grokky Runner", platform: platform(), root, capabilities },
        });
        return;
      }
      if (request.method !== "POST") {
        send(response, 404, { error: "Route not found" });
        return;
      }
      const body = await readJson(request);
      if (url.pathname === "/pair") {
        if (Date.now() - codeIssuedAt > 5 * 60_000 || failedPairAttempts >= 10 || typeof body.code !== "string" || !tokenEqual(body.code, code)) {
          failedPairAttempts += 1;
          send(response, 403, { error: "Pairing code is invalid or expired" });
          return;
        }
        code = pairingCode();
        codeIssuedAt = Date.now();
        failedPairAttempts = 0;
        send(response, 200, {
          token: state.token,
          tokenEpoch: state.tokenEpoch,
          device: { id: state.deviceId, name: hostname() || "Grokky Runner", platform: platform(), root, capabilities },
        });
        return;
      }
      if (!tokenEqual(bearer(request), state.token)) {
        send(response, 401, { error: "Runner authorization failed" });
        return;
      }
      if (url.pathname === "/heartbeat") {
        send(response, 200, { ok: true, deviceId: state.deviceId, tokenEpoch: state.tokenEpoch, capabilities });
        return;
      }
      if (url.pathname === "/revoke") {
        const receiptId = `runner-${randomUUID().replaceAll("-", "")}`;
        const tokenEpoch = state.tokenEpoch + 1;
        await appendRunnerAudit(auditPath, { receiptId, deviceId: state.deviceId, action: "revoke", tokenEpoch, status: "accepted", createdAt: Date.now() });
        state.token = randomBytes(32).toString("base64url");
        state.tokenEpoch = tokenEpoch;
        await saveRunnerState(statePath, state);
        await appendRunnerAudit(auditPath, { receiptId, deviceId: state.deviceId, action: "revoke", tokenEpoch, status: "completed", createdAt: Date.now() });
        send(response, 200, { ok: true, receiptId, tokenEpoch });
        return;
      }
      if (url.pathname === "/test") {
        const capability = body.capability;
        if (capability === "files") {
          const entries = await readdir(root);
          send(response, 200, { ok: true, detail: `Workspace root is readable (${entries.length} top-level ${entries.length === 1 ? "entry" : "entries"}).` });
          return;
        }
        send(response, 400, { error: "Capability is unavailable on this runner" });
        return;
      }
      if (url.pathname === "/execute") {
        if (typeof body.name !== "string" || !toolNames.has(body.name as WorkspaceToolName)) {
          send(response, 400, { error: "Runner tool is unsupported" });
          return;
        }
        if (body.name === "run_command") {
          send(response, 400, { error: "Remote command execution is unavailable until the runner has a separate disposable sandbox" });
          return;
        }
        const requestedMode: SandboxMode = body.mode === "workspace-write" ? "workspace-write" : "read-only";
        const mode: SandboxMode = options.allowWrite && requestedMode === "workspace-write" ? "workspace-write" : "read-only";
        const allowCommands = false;
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
        const auditContext = body.auditContext && typeof body.auditContext === "object" && !Array.isArray(body.auditContext)
          ? body.auditContext as Record<string, unknown>
          : {};
        const receiptId = `runner-${randomUUID().replaceAll("-", "")}`;
        const computedArgumentDigest = createHash("sha256").update(canonicalJson(args)).digest("hex");
        if (typeof auditContext.argumentDigest === "string" && auditContext.argumentDigest !== computedArgumentDigest) {
          send(response, 409, { error: "Authorized argument digest does not match the runner request" });
          return;
        }
        const receipt = {
          receiptId,
          deviceId: state.deviceId,
          clientActionId: typeof auditContext.actionId === "string" ? auditContext.actionId.slice(0, 160) : undefined,
          conversationId: typeof auditContext.conversationId === "string" ? auditContext.conversationId.slice(0, 160) : undefined,
          agentComputerId: typeof auditContext.agentComputerId === "string" ? auditContext.agentComputerId.slice(0, 160) : undefined,
          agentName: typeof auditContext.agentName === "string" ? auditContext.agentName.slice(0, 120) : undefined,
          action: body.name,
          argumentDigest: computedArgumentDigest,
        };
        await appendRunnerAudit(auditPath, { ...receipt, status: "accepted", createdAt: Date.now() });
        try {
          const output = await executeWorkspaceTool({ root, mode, allowCommands, name: body.name as WorkspaceToolName, args });
          await appendRunnerAudit(auditPath, { ...receipt, status: "completed", createdAt: Date.now() });
          send(response, 200, { output, receiptId, argumentDigest: receipt.argumentDigest });
        } catch (error) {
          await appendRunnerAudit(auditPath, { ...receipt, status: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : "Runner action failed", createdAt: Date.now() });
          throw error;
        }
        return;
      }
      send(response, 404, { error: "Route not found" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : "Runner request failed" });
    }
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4747;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const endpointHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const endpoint = `http://${endpointHost}:${actualPort}`;
  options.onReady?.({ endpoint, code, deviceId: state.deviceId });
  return {
    endpoint,
    code,
    deviceId: state.deviceId,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const root = argument("--root") ?? process.cwd();
  const host = argument("--host") ?? "127.0.0.1";
  const port = Number(argument("--port") ?? 4747);
  const statePath = argument("--state") ?? resolve(homedir(), ".grokky-runner", "state.json");
  await startRunnerServer({
    root,
    host,
    port,
    statePath,
    allowWrite: process.argv.includes("--allow-write"),
    allowCommands: false,
    onReady: (details) => {
      process.stdout.write(`Grokky Runner\nEndpoint: ${details.endpoint}\nPairing code: ${details.code}\nDevice: ${details.deviceId}\n`);
    },
  });
}
