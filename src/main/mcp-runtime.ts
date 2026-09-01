import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse } from "smol-toml";

interface McpServerConfig {
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
}

interface ConnectedServer {
  fingerprint: string;
  client: Client;
}

export interface ExternalToolDefinition {
  id: string;
  serverId: string;
  toolName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = recordValue(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) => typeof item === "string" ? [[key, item]] : []));
}

function configsFromToml(content: string): Map<string, McpServerConfig> {
  const parsed = parse(content) as Record<string, unknown>;
  const servers = recordValue(parsed.mcp_servers) ?? {};
  const configs = new Map<string, McpServerConfig>();
  for (const [id, raw] of Object.entries(servers)) {
    const value = recordValue(raw);
    if (!value || value.enabled === false) continue;
    const config: McpServerConfig = {
      ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(Array.isArray(value.args) ? { args: value.args.filter((entry): entry is string => typeof entry === "string") } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.bearer_token_env_var === "string" ? { bearer_token_env_var: value.bearer_token_env_var } : {}),
      env: stringRecord(value.env),
      http_headers: stringRecord(value.http_headers),
      env_http_headers: stringRecord(value.env_http_headers),
    };
    if (config.command || config.url) configs.set(id, config);
  }
  return configs;
}

function fingerprint(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function safeToolPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return normalized || "tool";
}

function boundedInputSchema(value: unknown): Record<string, unknown> | undefined {
  const schema = recordValue(value);
  if (!schema) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf8") <= 50_000 ? schema : undefined;
  } catch {
    return undefined;
  }
}

function renderToolResult(value: unknown): string {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (item.type === "text") return [item.text];
    if (item.type === "resource_link") return [`Resource: ${String(item.name ?? "resource")}\n${String(item.uri ?? "")}${item.description ? `\n${String(item.description)}` : ""}`];
    if (item.type === "resource") {
      const resource = recordValue(item.resource) ?? {};
      return [typeof resource.text === "string" ? `Resource ${String(resource.uri ?? "")}\n${resource.text}` : `Binary resource ${String(resource.uri ?? "")} (${String(resource.mimeType ?? "unknown type")})`];
    }
    if (item.type === "image") return [`Image result (${String(item.mimeType ?? "unknown type")}, ${typeof item.data === "string" ? item.data.length : 0} encoded characters) was withheld from the text transcript.`];
    if (item.type === "audio") return [`Audio result (${String(item.mimeType ?? "unknown type")}, ${typeof item.data === "string" ? item.data.length : 0} encoded characters) was withheld from the text transcript.`];
    return [];
  });
  const structured = result.structuredContent ? `\nStructured result:\n${JSON.stringify(result.structuredContent)}` : "";
  const output = `${parts.join("\n\n")}${structured}`.trim();
  return `${result.isError === true ? "MCP tool reported an error.\n" : ""}${output || "MCP tool completed without text output."}`.slice(0, 80_000);
}

export class McpRuntime {
  private readonly configPath: string;
  private readonly connections = new Map<string, ConnectedServer>();
  private tools = new Map<string, ExternalToolDefinition>();

  constructor(homeDirectory: string, private readonly appVersion: string) {
    this.configPath = join(homeDirectory, ".codex", "config.toml");
  }

  async listTools(): Promise<{ tools: ExternalToolDefinition[]; errors: string[] }> {
    let content = "";
    try {
      content = await readFile(this.configPath, "utf8");
    } catch {
      this.tools.clear();
      return { tools: [], errors: [] };
    }
    let configs: Map<string, McpServerConfig>;
    try {
      configs = configsFromToml(content);
    } catch {
      this.tools.clear();
      return { tools: [], errors: ["The Codex MCP configuration could not be parsed."] };
    }
    const nextTools = new Map<string, ExternalToolDefinition>();
    const errors: string[] = [];
    for (const [serverId, config] of configs) {
      try {
        const client = await this.clientFor(serverId, config);
        const result = await client.listTools(undefined, { timeout: 12_000 });
        for (const tool of result.tools.slice(0, 80)) {
          const name = `mcp__${safeToolPart(serverId)}__${safeToolPart(tool.name)}`.slice(0, 120);
          if (nextTools.has(name)) {
            errors.push(`${serverId}: tool name ${tool.name} collides with another normalized MCP tool name`.slice(0, 500));
            continue;
          }
          const inputSchema = boundedInputSchema(tool.inputSchema);
          if (!inputSchema) {
            errors.push(`${serverId}: tool ${tool.name} advertised an invalid or oversized input schema`.slice(0, 500));
            continue;
          }
          const definition: ExternalToolDefinition = {
            id: `${serverId}/${tool.name}`,
            serverId,
            toolName: tool.name,
            name,
            description: `[${serverId}] ${(tool.description || tool.title || tool.name).slice(0, 1_500)}`,
            inputSchema,
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint !== false && tool.annotations?.readOnlyHint !== true,
            openWorld: tool.annotations?.openWorldHint !== false,
          };
          nextTools.set(name, definition);
        }
      } catch (error) {
        errors.push(`${serverId}: ${error instanceof Error ? error.message : "connection failed"}`.slice(0, 500));
      }
    }
    for (const [serverId, connection] of this.connections) {
      if (configs.has(serverId)) continue;
      await connection.client.close().catch(() => undefined);
      this.connections.delete(serverId);
    }
    this.tools = nextTools;
    return { tools: [...nextTools.values()], errors };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const definition = this.tools.get(name);
    if (!definition) throw new Error("External tool is no longer available; refresh capabilities and try again");
    const content = await readFile(this.configPath, "utf8");
    const config = configsFromToml(content).get(definition.serverId);
    if (!config) throw new Error("External tool server is disabled or no longer configured");
    const client = await this.clientFor(definition.serverId, config);
    const result = await client.callTool({ name: definition.toolName, arguments: args }, undefined, { signal, timeout: 120_000, maxTotalTimeout: 180_000 });
    return renderToolResult(result);
  }

  definition(name: string): ExternalToolDefinition | undefined {
    return this.tools.get(name);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.client.close()));
    this.connections.clear();
    this.tools.clear();
  }

  private async clientFor(serverId: string, config: McpServerConfig): Promise<Client> {
    const expectedFingerprint = fingerprint(config);
    const existing = this.connections.get(serverId);
    if (existing?.fingerprint === expectedFingerprint) return existing.client;
    if (existing) await existing.client.close().catch(() => undefined);
    const client = new Client({ name: "grokky", version: this.appVersion }, { capabilities: {} });
    try {
      if (config.url) {
        const url = new URL(config.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Remote MCP servers must use http or https");
        const headers = new Headers(config.http_headers);
        for (const [header, envName] of Object.entries(config.env_http_headers ?? {})) {
          const value = process.env[envName];
          if (value) headers.set(header, value);
        }
        if (config.bearer_token_env_var) {
          const token = process.env[config.bearer_token_env_var];
          if (token) headers.set("Authorization", `Bearer ${token}`);
        }
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      } else if (config.command) {
        await client.connect(new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
            ...(config.env ?? {}),
          },
          stderr: "ignore",
        }));
      } else {
        throw new Error("MCP server has no supported transport");
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.connections.set(serverId, { fingerprint: expectedFingerprint, client });
    return client;
  }
}
