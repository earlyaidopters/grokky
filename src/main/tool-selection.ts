export interface SelectableTool {
  name: string;
  group: "workspace" | "browser" | "computer" | "external" | "delegation" | "completion";
}

export interface ToolSelection<T extends SelectableTool> {
  offered: T[];
  reason: "under-floor" | "selected" | "nothing-chosen";
  granted: number;
}

const BROWSER_INTENT = /\b(?:browser|website|web page|navigate|click|fill|flight|date picker|scroll|page|url|sign[ -]?in)\b/i;
const WORKSPACE_INTENT = /\b(?:file|folder|workspace|project|code|implement|source tree|command|terminal|repository|repo)\b/i;
const COMPUTER_INTENT = /\b(?:screen|desktop|application|app|computer|capture|type|coordinate)\b/i;
const EXTERNAL_INTENT = /\b(?:gmail|email|calendar|drive|slack|notion|jira|connector|mcp|crm|database|sheet|document)\b/i;
const DELEGATION_INTENT = /\b(?:agent|specialist|delegate|crew|researcher|reviewer|expert|ask mark|ask me|human)\b/i;

export function selectToolsForPrompt<T extends SelectableTool>(tools: readonly T[], prompt: string, floor = 12): ToolSelection<T> {
  const everything = (reason: ToolSelection<T>["reason"]): ToolSelection<T> => ({ offered: [...tools], reason, granted: tools.length });
  if (tools.length <= floor) return everything("under-floor");
  const groups = new Set<SelectableTool["group"]>();
  if (BROWSER_INTENT.test(prompt)) groups.add("browser");
  if (WORKSPACE_INTENT.test(prompt)) groups.add("workspace");
  if (COMPUTER_INTENT.test(prompt)) groups.add("computer");
  if (EXTERNAL_INTENT.test(prompt)) groups.add("external");
  if (DELEGATION_INTENT.test(prompt)) groups.add("delegation");
  if (!groups.size) return everything("nothing-chosen");
  const offered = tools.filter((tool) => groups.has(tool.group) || tool.group === "completion");
  return offered.length ? { offered, reason: "selected", granted: tools.length } : everything("nothing-chosen");
}
