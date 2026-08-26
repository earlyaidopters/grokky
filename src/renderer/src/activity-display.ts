import type { ActivityItem } from "../../shared/contracts";
import { commandActivityLabel, looksLikeRawCommand } from "../../shared/activity-labels";

const contextBudgetNotice = "Skill descriptions were shortened to fit the skills context budget.";

export interface DisplayActivity extends ActivityItem {
  count: number;
}

function normalizedActivity(activity: ActivityItem): ActivityItem {
  if (activity.label === "Coordinator update") return { ...activity, label: "Progress notes" };
  if (activity.kind === "command" && looksLikeRawCommand(activity.label)) {
    return {
      ...activity,
      label: commandActivityLabel(activity.label),
      detail: [`Command\n${activity.label}`, ...(activity.detail ? [`Output\n${activity.detail}`] : [])].join("\n\n"),
    };
  }
  return activity;
}

function isGroupable(activity: ActivityItem): boolean {
  return activity.kind === "command"
    || activity.kind === "reasoning"
    || activity.label === "Progress notes";
}

function combinedStatus(previous: ActivityItem["status"], next: ActivityItem["status"]): ActivityItem["status"] {
  if (previous === "failed" || next === "failed") return "failed";
  if (previous === "running" || next === "running") return "running";
  return "completed";
}

function combinedDetail(previous: string | undefined, next: string | undefined): string | undefined {
  const parts = [previous, next].filter((value): value is string => Boolean(value));
  if (!parts.length) return undefined;
  return parts.join("\n\n──────────\n\n").slice(-24_000);
}

export function activitiesForDisplay(activities: ActivityItem[]): DisplayActivity[] {
  const result: DisplayActivity[] = [];
  for (const source of activities) {
    if (source.detail?.startsWith(contextBudgetNotice)) continue;
    const activity = normalizedActivity(source);
    const key = `${activity.kind}:${activity.label}`;
    const existingIndex = isGroupable(activity)
      ? result.findIndex((candidate) => `${candidate.kind}:${candidate.label}` === key)
      : -1;
    if (existingIndex < 0) {
      result.push({ ...activity, count: 1 });
      continue;
    }
    const existing = result[existingIndex]!;
    result[existingIndex] = {
      ...existing,
      id: activity.id,
      status: combinedStatus(existing.status, activity.status),
      detail: combinedDetail(existing.detail, activity.detail),
      createdAt: activity.createdAt,
      count: existing.count + 1,
    };
  }
  return result;
}
