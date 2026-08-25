import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CapabilitiesSnapshot,
  ConnectorCapability,
  McpCapability,
  SkillCapability,
} from "../shared/contracts";

interface ConfigSection {
  header: string;
  start: number;
  bodyStart: number;
  end: number;
}

interface SkillRoot {
  pathname: string;
  scope: SkillCapability["scope"];
}

const BENIGN_MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function configSections(content: string): ConfigSection[] {
  const matches = [...content.matchAll(/^[ \t]*(\[\[[^\r\n]+\]\]|\[[^\r\n]+\])[ \t]*(?:#.*)?$/gm)];
  return matches.map((match, index) => ({
    header: match[1]!,
    start: match.index,
    bodyStart: match.index + match[0].length,
    end: matches[index + 1]?.index ?? content.length,
  }));
}

function parseTomlString(body: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const doubleQuoted = body.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(\"(?:\\\\.|[^\"])*\")`, "m"));
  if (doubleQuoted?.[1]) {
    try {
      return JSON.parse(doubleQuoted[1]) as string;
    } catch {
      return undefined;
    }
  }
  return body.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*'([^']*)'`, "m"))?.[1];
}

function parseTomlBoolean(body: string, key: string, fallback = true): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(true|false)`, "m"));
  return match ? match[1] === "true" : fallback;
}

function cleanFrontmatterValue(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replaceAll("\\\"", '"');
  }
  return trimmed;
}

function titleFromSlug(value: string): string {
  return value
    .replace(/^plugin_/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function directTableId(header: string, prefix: string): string | null {
  if (!header.startsWith(`[${prefix}`) || !header.endsWith("]")) return null;
  const rest = header.slice(prefix.length + 1, -1);
  if (rest.startsWith('"')) {
    const match = rest.match(/^("(?:\\.|[^"])*")$/);
    if (!match?.[1]) return null;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  }
  return rest.includes(".") || !rest ? null : rest;
}

function configuredSkillStates(content: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const section of configSections(content)) {
    if (section.header !== "[[skills.config]]") continue;
    const body = content.slice(section.bodyStart, section.end);
    const pathname = parseTomlString(body, "path");
    if (pathname) states.set(resolve(pathname), parseTomlBoolean(body, "enabled"));
  }
  return states;
}

async function findProjectSkillRoots(workingDirectory: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  let current = resolve(workingDirectory);
  for (let depth = 0; depth < 18; depth += 1) {
    roots.push({ pathname: join(current, ".agents", "skills"), scope: "project" });
    try {
      if ((await stat(join(current, ".git"))).isDirectory()) break;
    } catch (error) {
      if (!BENIGN_MISSING_CODES.has(errorCode(error) ?? "")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function discoverSkillFiles(root: SkillRoot, limit: number): Promise<Array<{ pathname: string; scope: SkillCapability["scope"] }>> {
  const results: Array<{ pathname: string; scope: SkillCapability["scope"] }> = [];
  const visited = new Set<string>();

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12 || results.length >= limit) return;
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch (error) {
      if (BENIGN_MISSING_CODES.has(errorCode(error) ?? "")) return;
      throw error;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (BENIGN_MISSING_CODES.has(errorCode(error) ?? "")) return;
      throw error;
    }
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillFile) {
      const pathname = join(directory, "SKILL.md");
      const scope = pathname.includes("/.codex/skills/.system/") ? "system" : root.scope;
      results.push({ pathname, scope });
      return;
    }
    const children = entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !new Set([".git", "node_modules", "dist", "out", "release"]).has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) await walk(join(directory, child.name), depth + 1);
  }

  await walk(root.pathname, 0);
  return results;
}

async function describeSkill(
  item: { pathname: string; scope: SkillCapability["scope"] },
  states: Map<string, boolean>,
): Promise<SkillCapability | null> {
  try {
    const content = await readFile(item.pathname, "utf8");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const name = cleanFrontmatterValue(frontmatter.match(/^name:\s*(.+)$/m)?.[1]) || basename(dirname(item.pathname));
    const description = cleanFrontmatterValue(frontmatter.match(/^description:\s*(.+)$/m)?.[1]) || "Reusable Codex workflow";
    const canonical = resolve(item.pathname);
    return {
      id: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
      name,
      description: description.slice(0, 280),
      path: item.pathname,
      scope: item.scope,
      enabled: states.get(canonical) ?? true,
    };
  } catch (error) {
    if (BENIGN_MISSING_CODES.has(errorCode(error) ?? "")) return null;
    throw error;
  }
}

function mcpCapabilities(content: string): McpCapability[] {
  const result: McpCapability[] = [];
  for (const section of configSections(content)) {
    const id = directTableId(section.header, "mcp_servers.");
    if (!id) continue;
    const body = content.slice(section.bodyStart, section.end);
    result.push({
      id,
      name: titleFromSlug(id),
      transport: /^\s*url\s*=/m.test(body) ? "remote" : /^\s*command\s*=/m.test(body) ? "local" : "configured",
      enabled: parseTomlBoolean(body, "enabled"),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function connectorCapabilities(content: string): ConnectorCapability[] {
  const result: ConnectorCapability[] = [];
  for (const section of configSections(content)) {
    const id = directTableId(section.header, "plugins.");
    if (!id) continue;
    const body = content.slice(section.bodyStart, section.end);
    result.push({
      id,
      name: titleFromSlug(id.split("@")[0] ?? id),
      enabled: parseTomlBoolean(body, "enabled"),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export class CapabilitiesService {
  private readonly configPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly homeDirectory: string) {
    this.configPath = join(homeDirectory, ".codex", "config.toml");
  }

  async snapshot(workingDirectory: string): Promise<CapabilitiesSnapshot> {
    const content = await this.readConfig();
    const states = configuredSkillStates(content);
    const roots: SkillRoot[] = [
      ...(await findProjectSkillRoots(workingDirectory)),
      { pathname: join(this.homeDirectory, ".agents", "skills"), scope: "personal" },
      { pathname: join(this.homeDirectory, ".codex", "skills"), scope: "personal" },
      { pathname: join(this.homeDirectory, ".codex", "plugins", "cache"), scope: "plugin" },
    ];
    const discovered = (await Promise.all(roots.map((root) => discoverSkillFiles(root, 360)))).flat();
    const unique = [...new Map(discovered.map((item) => [resolve(item.pathname), item])).values()];
    const skills = (await Promise.all(unique.map((item) => describeSkill(item, states))))
      .filter((item): item is SkillCapability => Boolean(item))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      skills,
      mcpServers: mcpCapabilities(content),
      connectors: connectorCapabilities(content),
      configPath: this.configPath,
    };
  }

  async setSkillEnabled(pathname: string, enabled: boolean, workingDirectory: string): Promise<CapabilitiesSnapshot> {
    const normalized = resolve(pathname);
    if (basename(normalized) !== "SKILL.md" || !(await stat(normalized)).isFile()) throw new Error("Skill path is invalid");
    await this.updateConfig((content) => {
      const removals = configSections(content)
        .filter((section) => section.header === "[[skills.config]]")
        .filter((section) => resolve(parseTomlString(content.slice(section.bodyStart, section.end), "path") ?? "") === normalized)
        .sort((left, right) => right.start - left.start);
      let next = content;
      for (const section of removals) next = `${next.slice(0, section.start)}${next.slice(section.end)}`;
      const prefix = next.trimEnd();
      return `${prefix}${prefix ? "\n\n" : ""}[[skills.config]]\npath = ${JSON.stringify(normalized)}\nenabled = ${enabled}\n`;
    });
    return this.snapshot(workingDirectory);
  }

  async setMcpEnabled(id: string, enabled: boolean, workingDirectory: string): Promise<CapabilitiesSnapshot> {
    await this.setDirectTableEnabled("mcp_servers.", id, enabled);
    return this.snapshot(workingDirectory);
  }

  async setConnectorEnabled(id: string, enabled: boolean, workingDirectory: string): Promise<CapabilitiesSnapshot> {
    await this.setDirectTableEnabled("plugins.", id, enabled);
    return this.snapshot(workingDirectory);
  }

  private async setDirectTableEnabled(prefix: string, id: string, enabled: boolean): Promise<void> {
    if (!/^[a-zA-Z0-9_@./-]{1,240}$/.test(id)) throw new Error("Capability ID is invalid");
    await this.updateConfig((content) => {
      const section = configSections(content).find((candidate) => directTableId(candidate.header, prefix) === id);
      if (!section) throw new Error("Capability is no longer configured");
      const body = content.slice(section.bodyStart, section.end);
      const replacement = `enabled = ${enabled}`;
      const nextBody = /^\s*enabled\s*=\s*(?:true|false).*$/m.test(body)
        ? body.replace(/^\s*enabled\s*=\s*(?:true|false).*$/m, `\n${replacement}`)
        : `\n${replacement}${body}`;
      return `${content.slice(0, section.bodyStart)}${nextBody}${content.slice(section.end)}`;
    });
  }

  private async readConfig(): Promise<string> {
    try {
      return await readFile(this.configPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "";
      throw error;
    }
  }

  private updateConfig(transform: (content: string) => string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const content = await this.readConfig();
      const next = transform(content);
      const temporary = `${this.configPath}.grokky-next`;
      await mkdir(dirname(this.configPath), { recursive: true });
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, this.configPath);
    });
    return this.writeQueue;
  }
}
