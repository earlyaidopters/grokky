import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { AppSettings, ProviderStatus } from "../shared/contracts";

interface ResolvedCredential {
  apiKey: string;
  source: string;
}

export function isUsableOpenRouterKey(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return /^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(trimmed) && !/replace|example|your[_-]?key/i.test(trimmed);
}

export function parseEnvValue(source: string, key: string): string | undefined {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2]?.trim() ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    return value || undefined;
  }
  return undefined;
}

export function defaultOpenRouterCredentialCandidates(homeDirectory: string): string[] {
  return [
    process.env.GROKKY_OPENROUTER_ENV_FILE ?? "",
    join(homeDirectory, ".config", "grokky", ".env"),
  ].filter(Boolean);
}

export async function resolveOpenRouterCredential(
  settings: AppSettings,
  homeDirectory: string,
): Promise<ResolvedCredential | null> {
  const inherited = process.env.OPENROUTER_API_KEY?.trim();
  if (isUsableOpenRouterKey(inherited)) return { apiKey: inherited, source: "Process environment" };

  const candidates = [settings.openRouterCredentialPath, ...defaultOpenRouterCredentialCandidates(homeDirectory)]
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);

  for (const pathname of candidates) {
    try {
      const apiKey = parseEnvValue(await readFile(pathname, "utf8"), "OPENROUTER_API_KEY");
      if (isUsableOpenRouterKey(apiKey)) return { apiKey, source: pathname };
    } catch {
      // A missing or unreadable candidate is simply skipped.
    }
  }
  return null;
}

export async function providerStatuses(settings: AppSettings, homeDirectory: string): Promise<ProviderStatus[]> {
  const codexAuthPath = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : join(homeDirectory, ".codex", "auth.json");
  const codexReady = await access(codexAuthPath, constants.R_OK).then(() => true).catch(() => false);
  const openRouter = await resolveOpenRouterCredential(settings, homeDirectory);
  return [
    {
      id: "codex",
      ready: codexReady,
      label: codexReady ? "Codex signed in" : "Codex sign-in missing",
      source: codexReady ? "Saved ChatGPT session" : codexAuthPath,
      detail: codexReady
        ? "The official SDK will use the existing Codex authentication."
        : "Run codex login once, then refresh provider status.",
    },
    {
      id: "openrouter",
      ready: Boolean(openRouter),
      label: openRouter ? "OpenRouter configured" : "OpenRouter key missing",
      source: openRouter?.source ?? "No credential source found",
      detail: openRouter
        ? "The key stays in the Electron main process."
        : "Choose an env file containing OPENROUTER_API_KEY.",
    },
  ];
}
