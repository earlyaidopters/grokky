import { Codex } from "@openai/codex-sdk";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = await mkdtemp(join(tmpdir(), "grokky-codex-smoke-"));
await writeFile(join(workspace, "README.md"), "# Grokky smoke workspace\n");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);

try {
  const codex = new Codex({
    config: {
      features: {
        apps: true,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        multi_agent: true,
        plugins: true,
        skill_search: true,
        workspace_dependencies: true,
      },
      agents: {
        enabled: true,
        max_concurrent_threads_per_session: 4,
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
  const { events } = await thread.runStreamed("Reply with exactly: grokky-codex-ok", { signal: controller.signal });
  let answer = "";
  for await (const event of events) {
    if (event.type === "item.completed" && event.item.type === "agent_message") answer = event.item.text.trim();
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  if (answer !== "grokky-codex-ok") throw new Error(`Unexpected Codex smoke response: ${answer || "<empty>"}`);
  console.log("grokky-codex-ok");
} finally {
  clearTimeout(timeout);
}
