import { randomUUID } from "node:crypto";
import type { GeneratedArtifact } from "../shared/contracts";

const ARTIFACT_PATTERN = /```grokky-artifact\s*\n([\s\S]*?)```/gi;

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maximum) : undefined;
}

function normalizeArtifact(value: unknown, now: number): GeneratedArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!new Set(["table", "metrics", "checklist", "timeline"]).has(String(item.kind))) return null;
  const title = boundedText(item.title, 160);
  if (!title) return null;
  const artifact: GeneratedArtifact = {
    id: `artifact-${randomUUID()}`,
    kind: item.kind as GeneratedArtifact["kind"],
    title,
    ...(boundedText(item.description, 800) ? { description: boundedText(item.description, 800) } : {}),
    createdAt: now,
  };
  if (artifact.kind === "table") {
    if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return null;
    const columns = item.columns.flatMap((entry) => boundedText(entry, 80) ?? []).slice(0, 12);
    const rows = item.rows.flatMap((row) => {
      if (!Array.isArray(row)) return [];
      return [row.slice(0, columns.length).map((cell) => typeof cell === "number" && Number.isFinite(cell) ? cell : String(cell).slice(0, 500))];
    }).slice(0, 100);
    if (!columns.length || !rows.length) return null;
    artifact.columns = columns;
    artifact.rows = rows;
  } else {
    if (!Array.isArray(item.items)) return null;
    const items = item.items.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const label = boundedText(record.label, 160);
      if (!label) return [];
      const status = new Set(["pending", "active", "complete", "blocked"]).has(String(record.status))
        ? record.status as "pending" | "active" | "complete" | "blocked"
        : undefined;
      return [{
        label,
        ...(typeof record.value === "number" && Number.isFinite(record.value)
          ? { value: record.value }
          : boundedText(record.value, 240) ? { value: boundedText(record.value, 240) } : {}),
        ...(boundedText(record.detail, 500) ? { detail: boundedText(record.detail, 500) } : {}),
        ...(status ? { status } : {}),
      }];
    }).slice(0, 60);
    if (!items.length) return null;
    artifact.items = items;
  }
  return artifact;
}

export function extractGeneratedArtifacts(content: string, now = Date.now()): { text: string; artifacts: GeneratedArtifact[] } {
  const artifacts: GeneratedArtifact[] = [];
  const text = content.replace(ARTIFACT_PATTERN, (_block, payload: string) => {
    try {
      const value = JSON.parse(payload) as unknown;
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        const artifact = normalizeArtifact(candidate, now);
        if (artifact && artifacts.length < 4) artifacts.push(artifact);
      }
    } catch {
      return "";
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text, artifacts };
}

export const GENERATED_ARTIFACT_INSTRUCTIONS = [
  "When the user explicitly asks for a table, dashboard, checklist, timeline, comparison board, or metrics view, you may append one fenced grokky-artifact JSON block after the prose answer.",
  "Use kind table with title, columns, and rows; or kind metrics/checklist/timeline with title and items containing label plus optional value, detail, and status.",
  "Only include facts present in the answer or tool evidence. Never invent measurements. The block is machine-rendered and must contain strict JSON with no comments.",
].join(" ");

