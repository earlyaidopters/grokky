import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AgentService } from "../src/main/agents";

describe("AgentService", () => {
  test("lists a personal agent once when the workspace is the home directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-agent-home-workspace-"));
    const service = new AgentService(home);

    const agents = await service.create({
      name: "tester",
      description: "Reproduces failures and checks edge cases.",
      developerInstructions: "Test the assigned behavior independently and report exact results.",
      scope: "personal",
      icon: "cyan",
      sandboxMode: "read-only",
    }, home);
    const testers = agents.filter((agent) => agent.name === "tester");

    expect(testers).toHaveLength(1);
    expect(testers[0]).toMatchObject({ scope: "personal", builtIn: false });
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(agents.length);
  });

  test("creates, discovers, updates, resolves, and deletes official Codex agent definitions", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-agent-home-"));
    const project = await mkdtemp(join(tmpdir(), "grokky-agent-project-"));
    const service = new AgentService(home);

    expect((await service.list(project)).filter((agent) => agent.builtIn).map((agent) => agent.name)).toEqual(["default", "explorer", "worker"]);

    let agents = await service.create({
      name: "QA Scout",
      description: "Finds risky behavior and missing tests.",
      developerInstructions: "Inspect evidence in read-only mode and report exact reproduction steps.",
      scope: "project",
      icon: "violet",
      model: "gpt-5.6-terra",
      reasoning: "high",
      sandboxMode: "read-only",
    }, project);
    const created = agents.find((agent) => agent.name === "qa_scout");
    expect(created).toMatchObject({ scope: "project", icon: "violet", model: "gpt-5.6-terra", reasoning: "high", sandboxMode: "read-only" });
    expect(created?.path).toBe(join(project, ".codex", "agents", "qa_scout.toml"));

    const source = await readFile(created!.path!, "utf8");
    expect(source).toContain('name = "qa_scout"');
    expect(source).toContain('# grokky_icon = "violet"');
    expect(source).toContain('description = "Finds risky behavior and missing tests."');
    expect(source).toContain('developer_instructions = "Inspect evidence in read-only mode and report exact reproduction steps."');

    agents = await service.update(created!.id, {
      name: "qa_scout",
      description: "Reproduces failures and checks recovery.",
      developerInstructions: "Exercise normal, failure, cancellation, and recovery paths in read-only mode.",
      scope: "project",
      icon: "amber",
      sandboxMode: "read-only",
    }, project);
    expect(agents.find((agent) => agent.id === created!.id)?.description).toContain("recovery");
    expect(agents.find((agent) => agent.id === created!.id)?.icon).toBe("amber");
    expect(await service.selected([created!.id], project)).toMatchObject([{ name: "qa_scout" }]);

    agents = await service.delete(created!.id, project);
    expect(agents.some((agent) => agent.id === created!.id)).toBe(false);
  });
});
