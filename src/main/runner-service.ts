import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerCapabilityId, SandboxMode } from "../shared/contracts";
import { executeWorkspaceTool, type WorkspaceToolName } from "./workspace-tools";

interface RunnerDiskState {
  deviceId: string;
  token: string;
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

const toolNames = new Set<WorkspaceToolName>(["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"]);

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
    if (typeof value.deviceId === "string" && typeof value.token === "string") return { deviceId: value.deviceId, token: value.token };
  } catch {
    // The first run creates a private state file below.
  }
  const state = { deviceId: `remote-${randomUUID().replaceAll("-", "")}`, token: randomBytes(32).toString("base64url") };
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
  const state = await loadRunnerState(options.statePath);
  let code = pairingCode();
  const capabilities: ComputerCapabilityId[] = ["files", ...(options.allowCommands ? ["commands" as const] : [])];
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
        if (typeof body.code !== "string" || !tokenEqual(body.code, code)) {
          send(response, 403, { error: "Pairing code is invalid or expired" });
          return;
        }
        code = pairingCode();
        send(response, 200, {
          token: state.token,
          device: { id: state.deviceId, name: hostname() || "Grokky Runner", platform: platform(), root, capabilities },
        });
        return;
      }
      if (!tokenEqual(bearer(request), state.token)) {
        send(response, 401, { error: "Runner authorization failed" });
        return;
      }
      if (url.pathname === "/test") {
        const capability = body.capability;
        if (capability === "files") {
          const entries = await readdir(root);
          send(response, 200, { ok: true, detail: `Workspace root is readable (${entries.length} top-level ${entries.length === 1 ? "entry" : "entries"}).` });
          return;
        }
        if (capability === "commands" && options.allowCommands) {
          const detail = await executeWorkspaceTool({ root, mode: "workspace-write", allowCommands: true, name: "run_command", args: { command: "pwd" } });
          send(response, 200, { ok: true, detail });
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
        const requestedMode: SandboxMode = body.mode === "workspace-write" ? "workspace-write" : "read-only";
        const mode: SandboxMode = options.allowWrite && requestedMode === "workspace-write" ? "workspace-write" : "read-only";
        const allowCommands = options.allowCommands === true && body.allowCommands === true;
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
        const output = await executeWorkspaceTool({ root, mode, allowCommands, name: body.name as WorkspaceToolName, args });
        send(response, 200, { output });
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
    allowCommands: process.argv.includes("--allow-commands"),
    onReady: (details) => {
      process.stdout.write(`Grokky Runner\nEndpoint: ${details.endpoint}\nPairing code: ${details.code}\nDevice: ${details.deviceId}\n`);
    },
  });
}
