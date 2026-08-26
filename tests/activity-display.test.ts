import { describe, expect, test } from "vitest";
import { commandActivityLabel } from "../src/shared/activity-labels";
import { activitiesForDisplay } from "../src/renderer/src/activity-display";
import type { ActivityItem } from "../src/shared/contracts";

describe("activity presentation", () => {
  test("turns shell plumbing into human work labels", () => {
    expect(commandActivityLabel("/bin/zsh -lc 'pwd && rg --files | sed -n 1,160p'")).toBe("Mapping the workspace");
    expect(commandActivityLabel("/bin/zsh -lc 'sed -n 1,320p /tmp/.codex/skills/taste/SKILL.md'")).toBe("Reading project guidance");
    expect(commandActivityLabel("npm run test")).toBe("Running tests");
    expect(commandActivityLabel("git diff -- src/main.ts")).toBe("Reviewing code changes");
  });

  test("groups repeated inspection actions and coordinator notes into phases", () => {
    const activities: ActivityItem[] = [
      { id: "map", kind: "command", label: "Mapping the workspace", detail: "Command\npwd", status: "completed", createdAt: 1 },
      { id: "read-1", kind: "command", label: "Reading project guidance", detail: "Command\nsed first", status: "completed", createdAt: 2 },
      { id: "note-1", kind: "notice", label: "Coordinator update", detail: "Using the design skill.", status: "completed", createdAt: 3 },
      { id: "read-2", kind: "command", label: "Reading project guidance", detail: "Command\nsed second", status: "completed", createdAt: 4 },
      { id: "note-2", kind: "notice", label: "Coordinator update", detail: "Starting implementation.", status: "completed", createdAt: 5 },
      { id: "legacy", kind: "command", label: "/bin/zsh -lc 'sed -n 1,320p /tmp/AGENTS.md'", status: "completed", createdAt: 6 },
    ];
    const displayed = activitiesForDisplay(activities);
    expect(displayed.map((activity) => [activity.label, activity.count])).toEqual([
      ["Mapping the workspace", 1],
      ["Reading project guidance", 3],
      ["Progress notes", 2],
    ]);
    expect(displayed[1]?.detail).toContain("sed first");
    expect(displayed[1]?.detail).toContain("sed second");
  });
});
