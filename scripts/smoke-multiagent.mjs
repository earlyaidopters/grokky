import { Codex } from "@openai/codex-sdk";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "grokky-agents-smoke-"));
await writeFile(join(workspace, "README.md"), "# Grokky agents smoke workspace\n");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);

try {
  const codex = new Codex({
    config: {
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        multi_agent: true,
        plugins: false,
        skill_search: false,
        workspace_dependencies: false,
      },
      agents: {
        enabled: true,
        max_concurrent_threads_per_session: 2,
      },
    },
  });
  const thread = codex.startThread({
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    model: process.env.GROKKY_CODEX_SMOKE_MODEL || "gpt-5.6-luna",
    modelReasoningEffort: "low",
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    webSearchEnabled: false,
    approvalPolicy: "never",
  });
  const { events } = await thread.runStreamed(
    "You must use a subagent for this check. Spawn one subagent, ask it to return the word kiwi, wait for it, and then reply with exactly: grokky-multiagent-ok",
    { signal: controller.signal },
  );
  let answer = "";
  let sawCollaboration = false;
  for await (const event of events) {
    const serialized = JSON.stringify(event);
    if (/spawn_agent|send_message|wait_agent|collab/i.test(serialized)) {
      sawCollaboration = true;
      if (process.env.GROKKY_DEBUG_EVENTS === "1") console.log(serialized.slice(0, 8_000));
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") answer = event.item.text.trim();
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  if (answer !== "grokky-multiagent-ok") throw new Error(`Unexpected multi-agent response: ${answer || "<empty>"}`);
  if (!sawCollaboration) throw new Error("The run completed but emitted no collaboration event");
  console.log("grokky-multiagent-ok");
} finally {
  clearTimeout(timeout);
}
