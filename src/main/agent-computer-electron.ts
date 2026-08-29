import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { BrowserWindow, session } from "electron";
import { assertPublicUrl, domainAllowed } from "./computer-access";
import type { AgentBrowserHost, AgentBrowserRequest, AgentBrowserResult } from "./agent-computer";

interface BrowserSeat {
  window: BrowserWindow;
  allowedNavigationHosts: Set<string>;
}

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

function partitionFor(sessionId: string): string {
  return `grokky-agent-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

function evidenceName(sessionId: string, suffix = ""): string {
  return `${partitionFor(sessionId)}-${Date.now()}-${randomUUID().replaceAll("-", "")}${suffix}.png`;
}

function readableTextScript(): string {
  return `(() => {
    const title = document.title || location.hostname;
    const body = document.body?.innerText?.replace(/\\s+/g, ' ').trim() || '';
    return { title, text: body.slice(0, 40000), url: location.href };
  })()`;
}

export function createElectronAgentBrowserHost(evidenceDirectory: string): AgentBrowserHost {
  const seats = new Map<string, BrowserSeat>();
  const evidenceRoot = resolve(evidenceDirectory);

  function ensureSeat(sessionId: string): BrowserSeat {
    const existing = seats.get(sessionId);
    if (existing && !existing.window.isDestroyed()) return existing;

    const partition = partitionFor(sessionId);
    const browserSession = session.fromPartition(partition, { cache: false });
    const publicHostCache = new Map<string, { allowed: boolean; checkedAt: number }>();
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      if (requestUrl.protocol === "data:" || requestUrl.protocol === "blob:" || requestUrl.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
        callback({ cancel: true });
        return;
      }
      const hostname = requestUrl.hostname.toLowerCase();
      const cached = publicHostCache.get(hostname);
      if (cached && Date.now() - cached.checkedAt < 30_000) {
        callback({ cancel: !cached.allowed });
        return;
      }
      void assertPublicUrl(requestUrl).then(() => {
        publicHostCache.set(hostname, { allowed: true, checkedAt: Date.now() });
        callback({ cancel: false });
      }).catch(() => {
        publicHostCache.set(hostname, { allowed: false, checkedAt: Date.now() });
        callback({ cancel: true });
      });
    });

    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      backgroundColor: "#0b0d0b",
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const seat: BrowserSeat = { window, allowedNavigationHosts: new Set() };
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const keepNavigationInsideBoundary = (event: Electron.Event, target: string) => {
      try {
        const url = new URL(target);
        if (!seat.allowedNavigationHosts.has(url.hostname.toLowerCase())) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    window.webContents.on("will-navigate", keepNavigationInsideBoundary);
    window.webContents.on("will-redirect", keepNavigationInsideBoundary);
    window.on("closed", () => seats.delete(sessionId));
    seats.set(sessionId, seat);
    return seat;
  }

  return {
    available: true,

    async browse(request: AgentBrowserRequest): Promise<AgentBrowserResult> {
      const target = new URL(request.url);
      await assertPublicUrl(target);
      if (!request.approvedTarget && !domainAllowed(target.hostname, request.networkAllowlist)) {
        throw new Error(`Add ${target.hostname} to the computer network allowlist or approve this page once`);
      }
      const seat = ensureSeat(request.sessionId);
      seat.allowedNavigationHosts = new Set([
        target.hostname.toLowerCase(),
        ...request.networkAllowlist.map((entry) => entry.replace(/^https?:\/\//, "").replace(/^\*\./, "").split("/")[0]!.toLowerCase()),
      ]);
      const abort = () => seat.window.webContents.stop();
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (request.signal?.aborted) throw new Error("Run cancelled");
        await seat.window.loadURL(target.toString());
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
      if (request.signal?.aborted) throw new Error("Run cancelled");
      const page = await seat.window.webContents.executeJavaScript(readableTextScript(), true) as { title?: unknown; text?: unknown; url?: unknown };
      const currentUrl = typeof page.url === "string" ? page.url : seat.window.webContents.getURL();
      const finalUrl = new URL(currentUrl);
      await assertPublicUrl(finalUrl);
      if (!seat.allowedNavigationHosts.has(finalUrl.hostname.toLowerCase())) throw new Error("The page redirected outside the approved browser boundary");
      const pageTitle = typeof page.title === "string" && page.title.trim() ? page.title.trim().slice(0, 240) : finalUrl.hostname;
      const text = typeof page.text === "string" ? page.text.slice(0, 40_000) : "";
      const image = await seat.window.webContents.capturePage();
      if (image.isEmpty()) throw new Error("The agent browser returned an empty evidence frame");
      const imageBytes = image.toPNG();
      await mkdir(evidenceDirectory, { recursive: true });
      const evidencePath = join(evidenceDirectory, evidenceName(request.sessionId));
      await writeFile(evidencePath, imageBytes, { mode: 0o600 });
      return {
        output: `Title: ${pageTitle}\nURL: ${finalUrl.toString()}\n\n${text || "No readable text was found."}`,
        currentUrl: finalUrl.toString(),
        pageTitle,
        evidencePath,
        evidenceSha256: createHash("sha256").update(imageBytes).digest("hex"),
      };
    },

    async importEvidence(pathname: string, sessionId: string): Promise<{ evidencePath: string; evidenceSha256: string }> {
      const info = await lstat(pathname);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 15_000_000) throw new Error("Screen evidence is not a safe regular image file");
      const bytes = await readFile(pathname);
      if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error("Screen evidence is not a safe PNG frame");
      await mkdir(evidenceDirectory, { recursive: true });
      const evidencePath = join(evidenceDirectory, evidenceName(sessionId, "-screen"));
      await writeFile(evidencePath, bytes, { mode: 0o600 });
      await unlink(pathname).catch(() => undefined);
      return { evidencePath, evidenceSha256: createHash("sha256").update(bytes).digest("hex") };
    },

    async storeEvidence(value: Uint8Array, sessionId: string): Promise<{ evidencePath: string; evidenceSha256: string }> {
      const bytes = Buffer.from(value);
      if (bytes.length < PNG_MAGIC.length || bytes.length > 4_000_000 || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        throw new Error("Cloud browser evidence is not a safe PNG frame");
      }
      await mkdir(evidenceDirectory, { recursive: true });
      const evidencePath = join(evidenceDirectory, evidenceName(sessionId, "-cloud"));
      await writeFile(evidencePath, bytes, { mode: 0o600 });
      return { evidencePath, evidenceSha256: createHash("sha256").update(bytes).digest("hex") };
    },

    async removeEvidence(pathname: string): Promise<void> {
      const target = resolve(pathname);
      if (!target.startsWith(`${evidenceRoot}${sep}`)) return;
      await unlink(target).catch(() => undefined);
    },

    disposeSession(sessionId: string): void {
      const seat = seats.get(sessionId);
      if (seat && !seat.window.isDestroyed()) seat.window.destroy();
      seats.delete(sessionId);
    },

    disposeAll(): void {
      for (const seat of seats.values()) {
        if (!seat.window.isDestroyed()) seat.window.destroy();
      }
      seats.clear();
    },
  };
}
