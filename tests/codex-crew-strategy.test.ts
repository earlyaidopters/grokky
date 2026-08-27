import { describe, expect, it } from "vitest";
import { codexComputerPluginOverrides, codexCrewMode, crewPrompt } from "../src/main/providers/codex-provider";
import type { AgentDefinition } from "../src/shared/contracts";

const agents: AgentDefinition[] = [
  { id: "builtin:explorer", name: "explorer", description: "Inspect the workspace", developerInstructions: "Read only", scope: "built-in", builtIn: true },
  { id: "builtin:worker", name: "worker", description: "Implement the request", developerInstructions: "Own file changes", scope: "built-in", builtIn: true },
  { id: "builtin:tester", name: "tester", description: "Verify the result", developerInstructions: "Test the completed work", scope: "built-in", builtIn: true },
];

describe("Codex crew strategy", () => {
  it("enforces Grokky's browser and computer grants at the plugin boundary", () => {
    expect(codexComputerPluginOverrides(true, false)).toEqual([
      'plugins."browser@openai-bundled".enabled=true',
      'plugins."chrome@openai-bundled".enabled=true',
      'plugins."computer-use@openai-bundled".enabled=false',
    ]);
  });

  it("stages implementation and testing instead of starting dependent roles together", () => {
    const prompt = "Build a beautiful website and verify it locally";
    expect(codexCrewMode(prompt, agents)).toBe("staged");

    const instructions = crewPrompt(prompt, agents, false, true);
    expect(instructions).toContain("Execution mode: staged implementation pipeline");
    expect(instructions).toContain("IMPLEMENTATION_READY");
    expect(instructions).toContain("Spawn the tester immediately on that handoff while the worker finishes its short smoke checks");
    expect(instructions).toContain("leave exhaustive browser, interaction, and accessibility QA to the testing role");
    expect(instructions).toContain("fork_turns=none");
    expect(instructions).toContain("one event-driven wait of at least 120 seconds");
    expect(instructions).toContain("Never declare the crew delivered until required stages have reported");
  });

  it("keeps genuinely independent evidence gathering parallel", () => {
    const prompt = "Have every selected role independently inspect README.md and report the verification phrase";
    expect(codexCrewMode(prompt, agents)).toBe("parallel");

    const instructions = crewPrompt(prompt, agents, false, false);
    expect(instructions).toContain("Execution mode: parallel independent crew");
    expect(instructions).toContain("spawn all roles before the first wait");
  });
});
