import { acquire, connect, type Browser, type Page, type Route, type Request as PlaywrightRequest } from "@cloudflare/playwright";
import { Sandbox } from "@cloudflare/sandbox";
import {
  browserApplicationFromArgs,
  browserPointFromArgs,
  browserTextFromArgs,
  browserUrlFromArgs,
  type GatewayToolName,
} from "./protocol";

const BROWSER_WIDTH = 1280;
const BROWSER_HEIGHT = 800;
const MAX_FRAME_BYTES = 4_000_000;

export interface BrowserVisualArtifact {
  mimeType: "image/png";
  dataBase64: string;
  sha256: string;
  currentUrl: string;
  pageTitle: string;
  width: number;
  height: number;
  /** Short-lived Cloudflare Browser Live View URL. Never persist this signed URL. */
  liveViewUrl?: string;
}

export type StoredBrowserVisualArtifact = Omit<BrowserVisualArtifact, "liveViewUrl">;

export interface StoredActionResult {
  output: string;
  argumentDigest: string;
  visualArtifact?: StoredBrowserVisualArtifact;
}

export interface BrowserActionResult {
  output: string;
  visualArtifact?: BrowserVisualArtifact;
}

export type ActionClaim =
  | { kind: "accepted"; receiptId: string }
  | { kind: "in-flight"; receiptId: string }
  | { kind: "conflict"; receiptId: string }
  | { kind: "replay"; receiptId: string; result: StoredActionResult };

export class GrokkySandbox extends Sandbox<Env> {
  private readonly grokkyEnv: Env;
  private liveView?: { sessionId: string; url: string; expiresAt: number };

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.grokkyEnv = env;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS action_receipts (
          action_id TEXT PRIMARY KEY,
          argument_digest TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('accepted', 'completed')),
          output TEXT,
          visual_artifact_json TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS browser_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          session_id TEXT,
          allowed_hosts_json TEXT NOT NULL DEFAULT '[]',
          current_url TEXT,
          page_title TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      const columns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(action_receipts)").toArray();
      if (!columns.some((column) => column.name === "visual_artifact_json")) {
        this.ctx.storage.sql.exec("ALTER TABLE action_receipts ADD COLUMN visual_artifact_json TEXT");
      }
    });
  }

  async claimAction(actionId: string, argumentDigest: string, now: number): Promise<ActionClaim> {
    const prior = this.ctx.storage.sql.exec<{
      argument_digest: string;
      receipt_id: string;
      status: string;
      output: string | null;
      visual_artifact_json: string | null;
    }>("SELECT argument_digest, receipt_id, status, output, visual_artifact_json FROM action_receipts WHERE action_id = ?", actionId).toArray()[0];
    if (prior) {
      if (prior.argument_digest !== argumentDigest) return { kind: "conflict", receiptId: prior.receipt_id };
      if (prior.status === "completed" && prior.output !== null) {
        const visualArtifact = prior.visual_artifact_json
          ? JSON.parse(prior.visual_artifact_json) as StoredBrowserVisualArtifact
          : undefined;
        return { kind: "replay", receiptId: prior.receipt_id, result: { output: prior.output, argumentDigest, ...(visualArtifact ? { visualArtifact } : {}) } };
      }
      return { kind: "in-flight", receiptId: prior.receipt_id };
    }
    const receiptId = `runner-${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      "INSERT INTO action_receipts (action_id, argument_digest, receipt_id, status, created_at) VALUES (?, ?, ?, 'accepted', ?)",
      actionId,
      argumentDigest,
      receiptId,
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM action_receipts WHERE created_at < ?", now - 24 * 60 * 60_000);
    return { kind: "accepted", receiptId };
  }

  async completeAction(actionId: string, result: StoredActionResult, now: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE action_receipts SET status = 'completed', output = ?, visual_artifact_json = ?, completed_at = ? WHERE action_id = ? AND argument_digest = ? AND status = 'accepted'",
      result.output,
      result.visualArtifact ? JSON.stringify(result.visualArtifact) : null,
      now,
      actionId,
      result.argumentDigest,
    );
  }

  async executeBrowserAction(
    name: Extract<GatewayToolName, "browse_url" | "capture_screen" | "open_application" | "click_screen" | "type_text">,
    args: Record<string, unknown>,
    networkAllowlist: string[],
  ): Promise<BrowserActionResult> {
    const target = name === "browse_url" ? browserUrlFromArgs(args) : undefined;
    const stored = this.browserState();
    const allowedHosts = new Set([
      ...stored.allowedHosts,
      ...networkAllowlist.flatMap((entry) => {
        try {
          const normalized = entry.trim().replace(/^https?:\/\//i, "").replace(/^\*\./, "").split("/")[0];
          return [new URL(`https://${normalized}`).hostname.toLowerCase()];
        } catch {
          return [];
        }
      }),
      ...(target ? [target.hostname.toLowerCase()] : []),
    ]);
    const browser = await this.connectBrowser(stored.sessionId);
    try {
      const context = browser.contexts()[0] ?? await browser.newContext({ viewport: { width: BROWSER_WIDTH, height: BROWSER_HEIGHT } });
      const page = context.pages()[0] ?? await context.newPage();
      await page.setViewportSize({ width: BROWSER_WIDTH, height: BROWSER_HEIGHT });
      await this.installNetworkBoundary(page, allowedHosts);
      const liveViewUrl = await this.browserLiveViewUrl(page, browser.sessionId());

      let actionDetail = "Captured the cloud browser.";
      if (name === "browse_url" && target) {
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 35_000 });
        actionDetail = `Opened ${target.hostname} in the cloud browser.`;
      } else if (name === "click_screen") {
        const point = browserPointFromArgs(args);
        await page.mouse.click(point.x, point.y);
        await page.waitForTimeout(450);
        actionDetail = `Clicked ${point.x}, ${point.y} inside the cloud browser.`;
      } else if (name === "type_text") {
        const text = browserTextFromArgs(args);
        await page.keyboard.type(text, { delay: 8 });
        await page.waitForTimeout(150);
        actionDetail = `Typed ${text.length} characters into the active cloud browser control.`;
      } else if (name === "open_application") {
        const application = browserApplicationFromArgs(args);
        actionDetail = application === "browser"
          ? "The Cloudflare browser is open."
          : application === "terminal"
            ? "The cloud terminal is available through run_command; the browser remains visible on the desktop."
            : "The seat's /workspace files are available through the file tools; the browser remains visible on the desktop.";
      }

      const currentUrl = page.url();
      const pageTitle = (await page.title().catch(() => "")).trim().slice(0, 240) || this.fallbackTitle(currentUrl);
      const readableText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const screenshot = new Uint8Array(await page.screenshot({ type: "png", animations: "disabled", fullPage: false }));
      if (!screenshot.length || screenshot.length > MAX_FRAME_BYTES) throw new Error("The cloud browser returned an invalid or oversized frame");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", screenshot));
      const visualArtifact: BrowserVisualArtifact = {
        mimeType: "image/png",
        dataBase64: this.base64(screenshot),
        sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        currentUrl,
        pageTitle,
        width: BROWSER_WIDTH,
        height: BROWSER_HEIGHT,
        ...(liveViewUrl ? { liveViewUrl } : {}),
      };
      this.saveBrowserState(browser.sessionId(), allowedHosts, currentUrl, pageTitle);
      const output = [
        actionDetail,
        `Frame: ${BROWSER_WIDTH} x ${BROWSER_HEIGHT}`,
        `Title: ${pageTitle}`,
        `URL: ${currentUrl}`,
        readableText.trim() ? `\n${readableText.replace(/\s+/g, " ").trim().slice(0, 40_000)}` : "\nNo readable page text was found.",
      ].join("\n");
      return { output, visualArtifact };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async disposeBrowser(): Promise<void> {
    this.liveView = undefined;
    const { sessionId } = this.browserState();
    if (sessionId) {
      let browser: Browser | undefined;
      try {
        browser = await connect(this.grokkyEnv.BROWSER, sessionId);
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      } catch {
        // Expired and already-closed sessions require no further cleanup.
      } finally {
        await browser?.close().catch(() => undefined);
      }
    }
    this.ctx.storage.sql.exec("DELETE FROM browser_state WHERE singleton = 1");
  }

  private browserState(): { sessionId?: string; allowedHosts: string[] } {
    const row = this.ctx.storage.sql.exec<{ session_id: string | null; allowed_hosts_json: string }>(
      "SELECT session_id, allowed_hosts_json FROM browser_state WHERE singleton = 1",
    ).toArray()[0];
    if (!row) return { allowedHosts: [] };
    let allowedHosts: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_hosts_json) as unknown;
      if (Array.isArray(parsed)) allowedHosts = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 100);
    } catch {
      // Corrupt browser metadata is discarded without affecting the sandbox receipt ledger.
    }
    return { ...(row.session_id ? { sessionId: row.session_id } : {}), allowedHosts };
  }

  private saveBrowserState(sessionId: string, allowedHosts: Set<string>, currentUrl: string, pageTitle: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO browser_state (singleton, session_id, allowed_hosts_json, current_url, page_title, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET session_id = excluded.session_id, allowed_hosts_json = excluded.allowed_hosts_json,
         current_url = excluded.current_url, page_title = excluded.page_title, updated_at = excluded.updated_at`,
      sessionId,
      JSON.stringify([...allowedHosts].slice(-100)),
      currentUrl.slice(0, 4_000),
      pageTitle.slice(0, 240),
      Date.now(),
    );
  }

  private async connectBrowser(sessionId?: string): Promise<Browser> {
    if (sessionId) {
      try {
        return await connect(this.grokkyEnv.BROWSER, sessionId);
      } catch {
        this.ctx.storage.sql.exec("UPDATE browser_state SET session_id = NULL WHERE singleton = 1");
      }
    }
    const acquired = await acquire(this.grokkyEnv.BROWSER, { keep_alive: 600_000 });
    return connect(this.grokkyEnv.BROWSER, acquired.sessionId);
  }

  private async browserLiveViewUrl(page: Page, sessionId: string): Promise<string | undefined> {
    const now = Date.now();
    if (this.liveView?.sessionId === sessionId && this.liveView.expiresAt > now + 60_000) return this.liveView.url;
    const cdp = await page.context().newCDPSession(page);
    try {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const target = targetInfos.find((candidate) => candidate.type === "page" && candidate.url === page.url())
        ?? targetInfos.find((candidate) => candidate.type === "page");
      if (!target?.targetId) return undefined;
      const sendLiveView = cdp.send.bind(cdp) as (
        method: "Cloudflare.getLiveView",
        params: { targetId: string; mode: "tab"; expiresInMs: number },
      ) => Promise<{ devtoolsFrontendUrl?: unknown }>;
      const result = await sendLiveView("Cloudflare.getLiveView", {
        targetId: target.targetId,
        mode: "tab",
        expiresInMs: 3_600_000,
      });
      if (typeof result.devtoolsFrontendUrl !== "string") return undefined;
      const url = new URL(result.devtoolsFrontendUrl);
      if (url.protocol !== "https:" || url.hostname !== "live.browser.run" || !url.pathname.startsWith("/ui/")) return undefined;
      this.liveView = { sessionId, url: url.toString(), expiresAt: now + 3_600_000 };
      return this.liveView.url;
    } catch {
      // A screenshot remains available if Live View is temporarily unavailable.
      return undefined;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private async installNetworkBoundary(page: Page, allowedHosts: Set<string>): Promise<void> {
    await page.unroute("**/*").catch(() => undefined);
    await page.route("**/*", async (route: Route, request: PlaywrightRequest) => {
      const value = request.url();
      if (/^(?:data|blob|about):/i.test(value)) {
        await route.continue();
        return;
      }
      let url: URL;
      try {
        url = browserUrlFromArgs({ url: value });
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (mainNavigation && !this.hostAllowed(url.hostname, allowedHosts)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

  private hostAllowed(hostname: string, allowedHosts: Set<string>): boolean {
    const target = hostname.toLowerCase();
    return [...allowedHosts].some((host) => target === host || target.endsWith(`.${host}`));
  }

  private fallbackTitle(value: string): string {
    try {
      return new URL(value).hostname || "Cloud browser";
    } catch {
      return "Cloud browser";
    }
  }

  private base64(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + 0x8000)));
    }
    return btoa(binary);
  }
}
