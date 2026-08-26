import { Codex } from "@openai/codex-sdk";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

async function rolloutRecords(threadId) {
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const entries = await readdir(sessions, { recursive: true });
    const match = entries.find((entry) => basename(entry).endsWith(`-${threadId}.jsonl`));
    if (match) {
      const source = await readFile(join(sessions, match), "utf8");
      return source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return [];
}

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
    model: process.env.GROKKY_CODEX_SMOKE_MODEL || "gpt-5.6-sol",
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
  let rootThreadId = "";
  let sawSdkChild = false;
  let sawSdkReport = false;
  for await (const event of events) {
    if (event.type === "thread.started") rootThreadId = event.thread_id;
    if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "collab_tool_call") {
      const receiverIds = Array.isArray(event.item.receiver_thread_ids) ? event.item.receiver_thread_ids : [];
      if (event.item.tool === "spawn_agent" && receiverIds.length > 0) sawSdkChild = true;
      if (event.item.tool === "wait" && receiverIds.length > 0 && /kiwi/i.test(JSON.stringify(event.item.agents_states || {}))) sawSdkReport = true;
      if (process.env.GROKKY_DEBUG_EVENTS === "1") console.log(JSON.stringify(event).slice(0, 8_000));
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") answer = event.item.text.trim();
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  if (answer !== "grokky-multiagent-ok") throw new Error(`Unexpected multi-agent response: ${answer || "<empty>"}`);
  if (!rootThreadId) throw new Error("The run completed without a root thread ID");
  const records = await rolloutRecords(rootThreadId);
  const childStarts = records.filter((record) => record.type === "event_msg" && record.payload?.type === "item_completed" && record.payload?.item?.type === "SubAgentActivity" && record.payload?.item?.kind === "started" && record.payload?.item?.agent_thread_id);
  const childPaths = new Set(childStarts.map((record) => record.payload.item.agent_path));
  const childReports = records.filter((record) => {
    if (record.type !== "response_item" || record.payload?.type !== "agent_message" || !childPaths.has(record.payload?.author)) return false;
    const text = Array.isArray(record.payload?.content)
      ? record.payload.content.filter((item) => item?.type === "input_text" && typeof item.text === "string").map((item) => item.text).join("\n")
      : "";
    return /Message Type: FINAL_ANSWER[\s\S]*Payload:\n[\s\S]*kiwi/i.test(text);
  });
  if (!(sawSdkChild || childStarts.length > 0)) throw new Error("The run completed without a confirmed child thread");
  if (!(sawSdkReport || childReports.length > 0)) throw new Error("The run completed without a confirmed child report containing kiwi");
  console.log("grokky-multiagent-ok");
} finally {
  clearTimeout(timeout);
}
