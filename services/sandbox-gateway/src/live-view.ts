import type { Page } from "@cloudflare/playwright";
export interface LiveViewCache { sessionId: string; targetId: string; url: string; expiresAt: number }

export async function pageLiveView(page: Page, sessionId: string, cached?: LiveViewCache): Promise<LiveViewCache | undefined> {
  const now = Date.now();
  const cdp = await page.context().newCDPSession(page);
  try {
    // Query the attached page itself. URLs are not unique identities for browser tabs.
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    if (cached?.sessionId === sessionId && cached.targetId === targetInfo.targetId && cached.expiresAt > now + 60_000) return cached;
    const send = cdp.send.bind(cdp) as (method: "Cloudflare.getLiveView", params: { targetId: string; mode: "tab"; expiresInMs: number }) => Promise<{ devtoolsFrontendUrl: string }>;
    const result = await send("Cloudflare.getLiveView", { targetId: targetInfo.targetId, mode: "tab", expiresInMs: 300_000 });
    const url = new URL(result.devtoolsFrontendUrl);
    if (url.protocol !== "https:" || url.hostname !== "live.browser.run" || !url.pathname.startsWith("/ui/")) return undefined;
    return { sessionId, targetId: targetInfo.targetId, url: url.toString(), expiresAt: now + 300_000 };
  } catch { return undefined; } finally { await cdp.detach().catch(() => undefined); }
}
