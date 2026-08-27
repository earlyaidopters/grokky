import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowBrowserOriginsForThread, browserOriginsForRequest } from "../src/main/codex-browser-permissions";
import type { ChatMessage } from "../src/shared/contracts";

function message(role: ChatMessage["role"], content: string, createdAt: number): ChatMessage {
  return { id: `message-${createdAt}`, role, content, createdAt, provider: "codex" };
}

describe("Codex browser permissions", () => {
  it("uses the current target URL for an explicit browser request", () => {
    const origins = browserOriginsForRequest(
      "Open https://www.opentable.ca/r/damas-montreal in a browser",
      [message("assistant", "Earlier link: https://example.com", 1)],
    );
    expect(origins).toEqual(["https://www.opentable.ca"]);
  });

  it("recovers the latest contextual URL when the user asks to retry the browser", () => {
    const origins = browserOriginsForRequest("Try now to open the browser", [
      message("user", "Please check dinner availability", 1),
      message("assistant", "I will check https://www.opentable.ca/r/damas-montreal", 2),
    ]);
    expect(origins).toEqual(["https://www.opentable.ca"]);
  });

  it("does not pre-authorize historical URLs for a non-browser request", () => {
    const origins = browserOriginsForRequest("Summarize the last answer", [
      message("assistant", "Reference: https://example.com", 1),
    ]);
    expect(origins).toEqual([]);
  });

  it("moves an approved origin from denied to allowed without touching other origins", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "grokky-codex-home-"));
    const sessions = join(codexHome, "browser", "sessions");
    const threadId = "01a043e0-2833-75f2-a3d3-fcac85fa0aae";
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${threadId}.toml`), [
      "[origins]",
      'allowed = ["https://example.com"]',
      'denied = ["https://www.opentable.ca", "https://blocked.example"]',
      "",
    ].join("\n"));

    await allowBrowserOriginsForThread(threadId, ["https://www.opentable.ca/r/damas"], codexHome);

    const updated = await readFile(join(sessions, `${threadId}.toml`), "utf8");
    expect(updated).toContain('allowed = ["https://example.com","https://www.opentable.ca"]');
    expect(updated).toContain('denied = ["https://blocked.example"]');
  });

  it("rejects a thread ID that could escape the browser session directory", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "grokky-codex-home-"));
    await expect(allowBrowserOriginsForThread("../../outside", ["https://example.com"], codexHome)).rejects.toThrow(/thread ID/);
  });
});
