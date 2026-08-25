import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDefinition, AgentDraft, AgentIcon, ReasoningEffort, SandboxMode } from "../shared/contracts";

const reasoningValues = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);
const sandboxValues = new Set<SandboxMode>(["read-only", "workspace-write"]);
const iconValues = new Set<AgentIcon>(["lime", "cyan", "coral", "violet", "amber", "mint"]);

const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "builtin:default",
    name: "default",
    description: "General-purpose fallback for work that does not need a specialized role.",
    developerInstructions: "Handle the assigned task carefully, stay within scope, and return a concise result to the parent agent.",
    scope: "built-in",
    builtIn: true,
    icon: "lime",
  },
  {
    id: "builtin:worker",
    name: "worker",
    description: "Execution-focused agent for implementation, fixes, and verification.",
    developerInstructions: "Own the bounded implementation task. Keep unrelated files untouched, verify the changed behavior, and report concrete results.",
    scope: "built-in",
    builtIn: true,
    icon: "coral",
    sandboxMode: "workspace-write",
  },
  {
    id: "builtin:explorer",
    name: "explorer",
    description: "Read-heavy codebase explorer for tracing behavior and gathering evidence.",
    developerInstructions: "Stay in exploration mode. Trace real execution paths, cite files and symbols, and avoid editing files.",
    scope: "built-in",
    builtIn: true,
    icon: "cyan",
    sandboxMode: "read-only",
  },
];

function parseTomlString(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const triple = content.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(?:\"\"\"([\\s\\S]*?)\"\"\"|'''([\\s\\S]*?)''')`, "m"));
  if (triple) return (triple[1] ?? triple[2] ?? "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const quoted = content.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(\"(?:\\\\.|[^\"])*\")`, "m"));
  if (quoted?.[1]) {
    try { return JSON.parse(quoted[1]) as string; } catch { return undefined; }
  }
  return content.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*'([^']*)'`, "m"))?.[1];
}

function parseGrokkyMetadata(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^[ \\t]*#[ \\t]*${escaped}[ \\t]*=[ \\t]*(\"(?:\\\\.|[^\"])*\")[ \\t]*$`, "m"));
  if (!match?.[1]) return undefined;
  try { return JSON.parse(match[1]) as string; } catch { return undefined; }
}

function agentId(pathname: string): string {
  return createHash("sha256").update(resolve(pathname)).digest("hex").slice(0, 20);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function normalizeDraft(value: AgentDraft): AgentDraft {
  const name = slug(value.name);
  const description = value.description.trim();
  const developerInstructions = value.developerInstructions.trim();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) throw new Error("Agent name must start with a letter and use letters, numbers, hyphens, or underscores");
  if (!description || description.length > 800) throw new Error("Agent description must be between 1 and 800 characters");
  if (!developerInstructions || developerInstructions.length > 30_000) throw new Error("Agent instructions must be between 1 and 30,000 characters");
  if (!new Set(["personal", "project"]).has(value.scope)) throw new Error("Agent scope is invalid");
  if (value.model && !/^[a-zA-Z0-9_~./:-]{2,160}$/.test(value.model)) throw new Error("Agent model is invalid");
  if (value.reasoning && !reasoningValues.has(value.reasoning)) throw new Error("Agent reasoning effort is invalid");
  if (value.sandboxMode && !sandboxValues.has(value.sandboxMode)) throw new Error("Agent workspace permission is invalid");
  if (value.icon && !iconValues.has(value.icon)) throw new Error("Agent icon is invalid");
  return {
    name,
    description,
    developerInstructions,
    scope: value.scope,
    ...(value.icon ? { icon: value.icon } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoning ? { reasoning: value.reasoning } : {}),
    ...(value.sandboxMode ? { sandboxMode: value.sandboxMode } : {}),
  };
}

function serializeAgent(draft: AgentDraft): string {
  return [
    ...(draft.icon ? [`# grokky_icon = ${JSON.stringify(draft.icon)}`] : []),
    `name = ${JSON.stringify(draft.name)}`,
    `description = ${JSON.stringify(draft.description)}`,
    ...(draft.model ? [`model = ${JSON.stringify(draft.model)}`] : []),
    ...(draft.reasoning ? [`model_reasoning_effort = ${JSON.stringify(draft.reasoning)}`] : []),
    ...(draft.sandboxMode ? [`sandbox_mode = ${JSON.stringify(draft.sandboxMode)}`] : []),
    `developer_instructions = ${JSON.stringify(draft.developerInstructions)}`,
    "",
  ].join("\n");
}

async function readAgent(pathname: string, scope: "personal" | "project"): Promise<AgentDefinition | null> {
  try {
    const content = await readFile(pathname, "utf8");
    const name = parseTomlString(content, "name") ?? basename(pathname, ".toml");
    const description = parseTomlString(content, "description");
    const developerInstructions = parseTomlString(content, "developer_instructions");
    if (!description || !developerInstructions) return null;
    const model = parseTomlString(content, "model");
    const reasoning = parseTomlString(content, "model_reasoning_effort");
    const sandboxMode = parseTomlString(content, "sandbox_mode");
    const icon = parseGrokkyMetadata(content, "grokky_icon");
    return {
      id: agentId(pathname),
      name,
      description,
      developerInstructions,
      scope,
      builtIn: false,
      path: pathname,
      ...(iconValues.has(icon as AgentIcon) ? { icon: icon as AgentIcon } : {}),
      ...(model ? { model } : {}),
      ...(reasoningValues.has(reasoning as ReasoningEffort) ? { reasoning: reasoning as ReasoningEffort } : {}),
      ...(sandboxValues.has(sandboxMode as SandboxMode) ? { sandboxMode: sandboxMode as SandboxMode } : {}),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function listDirectory(pathname: string, scope: "personal" | "project"): Promise<AgentDefinition[]> {
  try {
    const entries = await readdir(pathname, { withFileTypes: true });
    const agents = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map((entry) => readAgent(join(pathname, entry.name), scope)));
    return agents.filter((agent): agent is AgentDefinition => Boolean(agent));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export class AgentService {
  constructor(private readonly homeDirectory: string) {}

  async list(workingDirectory: string): Promise<AgentDefinition[]> {
    const personalDirectory = join(this.homeDirectory, ".codex", "agents");
    const projectDirectory = join(resolve(workingDirectory), ".codex", "agents");
    const [personal, project] = await Promise.all([
      listDirectory(personalDirectory, "personal"),
      listDirectory(projectDirectory, "project"),
    ]);
    return [...BUILT_IN_AGENTS, ...project, ...personal].sort((left, right) => {
      if (left.scope === "built-in" && right.scope !== "built-in") return -1;
      if (right.scope === "built-in" && left.scope !== "built-in") return 1;
      return left.name.localeCompare(right.name);
    });
  }

  async selected(ids: string[], workingDirectory: string): Promise<AgentDefinition[]> {
    const wanted = new Set(ids);
    return (await this.list(workingDirectory)).filter((agent) => wanted.has(agent.id));
  }

  async create(value: AgentDraft, workingDirectory: string): Promise<AgentDefinition[]> {
    const draft = normalizeDraft(value);
    const directory = this.directoryFor(draft.scope, workingDirectory);
    await mkdir(directory, { recursive: true });
    let pathname = join(directory, `${draft.name}.toml`);
    for (let suffix = 2; ; suffix += 1) {
      try {
        await stat(pathname);
        pathname = join(directory, `${draft.name}-${suffix}.toml`);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
    }
    await this.atomicWrite(pathname, serializeAgent(draft));
    return this.list(workingDirectory);
  }

  async update(id: string, value: AgentDraft, workingDirectory: string): Promise<AgentDefinition[]> {
    const current = (await this.list(workingDirectory)).find((agent) => agent.id === id);
    if (!current || current.builtIn || !current.path) throw new Error("Built-in agents cannot be edited");
    const draft = normalizeDraft(value);
    const expectedDirectory = this.directoryFor(current.scope as "personal" | "project", workingDirectory);
    if (resolve(dirname(current.path)) !== resolve(expectedDirectory)) throw new Error("Agent path is outside the active scope");
    if (draft.scope !== current.scope) throw new Error("Duplicate the agent to change its scope");
    await this.atomicWrite(current.path, serializeAgent(draft));
    return this.list(workingDirectory);
  }

  async delete(id: string, workingDirectory: string): Promise<AgentDefinition[]> {
    const current = (await this.list(workingDirectory)).find((agent) => agent.id === id);
    if (!current || current.builtIn || !current.path) throw new Error("Built-in agents cannot be deleted");
    const expectedDirectory = this.directoryFor(current.scope as "personal" | "project", workingDirectory);
    if (resolve(dirname(current.path)) !== resolve(expectedDirectory)) throw new Error("Agent path is outside the active scope");
    await unlink(current.path);
    return this.list(workingDirectory);
  }

  private directoryFor(scope: "personal" | "project", workingDirectory: string): string {
    return scope === "personal"
      ? join(this.homeDirectory, ".codex", "agents")
      : join(resolve(workingDirectory), ".codex", "agents");
  }

  private async atomicWrite(pathname: string, content: string): Promise<void> {
    const temporary = `${pathname}.grokky-next`;
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, pathname);
  }
}
