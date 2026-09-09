import { expect, test } from "vitest";
import type { Page } from "@cloudflare/playwright";
import { pageLiveView } from "../src/live-view";

test("Live View follows target identity even when two tabs share a URL", async () => {
  let target = "tab-a"; let mints = 0; let detached = 0;
  const page = { context: () => ({ newCDPSession: async () => ({
    send: async (method: string) => method === "Target.getTargetInfo" ? { targetInfo: { targetId: target } } : (mints++, { devtoolsFrontendUrl: `https://live.browser.run/ui/view?target=${target}` }),
    detach: async () => { detached += 1; },
  }) }) } as unknown as Page;
  const first = await pageLiveView(page, "session");
  expect((await pageLiveView(page, "session", first))?.targetId).toBe("tab-a");
  expect(mints).toBe(1);
  target = "tab-b";
  expect((await pageLiveView(page, "session", first))?.targetId).toBe("tab-b");
  expect(mints).toBe(2); expect(detached).toBe(3);
});
