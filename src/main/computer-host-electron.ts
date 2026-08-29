import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  desktopCapturer,
  safeStorage,
  screen as electronScreen,
  shell,
  systemPreferences,
} from "electron";
import type { ComputerCapabilityId, ComputerPermissionStatus } from "../shared/contracts";
import { pointInsideDisplay, type ComputerAccessSecrets, type ComputerHostAdapter, type ComputerToolName } from "./computer-access";

function screenPermission(): ComputerPermissionStatus {
  if (process.platform !== "darwin") return "unavailable";
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return "granted";
  if (status === "not-determined") return "not-determined";
  return "denied";
}

function automationPermission(): ComputerPermissionStatus {
  if (process.platform !== "darwin") return "unavailable";
  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
}

function runExecutable(command: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-20_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `Desktop action exited with status ${code ?? "unknown"}`));
    });
  });
}

function escapedAppleScriptText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\r", "").replaceAll("\n", "\\n");
}

type SystemToolName = Exclude<ComputerToolName, "list_files" | "search_files" | "read_file" | "create_file" | "edit_file" | "run_command" | "browse_url">;

export function createElectronComputerHost(captureDirectory: string): ComputerHostAdapter {
  return {
    permissionStatus(capability: ComputerCapabilityId): ComputerPermissionStatus {
      if (capability === "screen") return screenPermission();
      if (capability === "automation") return automationPermission();
      return "not-required";
    },

    async requestPermission(capability: ComputerCapabilityId): Promise<ComputerPermissionStatus> {
      if (capability === "automation") {
        if (process.platform !== "darwin") return "unavailable";
        const trusted = systemPreferences.isTrustedAccessibilityClient(true);
        if (!trusted) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        return trusted ? "granted" : "not-determined";
      }
      if (capability === "screen") {
        if (process.platform !== "darwin") return "unavailable";
        try {
          await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
        } catch {
          await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        }
        const status = screenPermission();
        if (status !== "granted") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        return status;
      }
      return "not-required";
    },

    async execute(name: SystemToolName, args: Record<string, unknown>): Promise<string> {
      if (process.platform !== "darwin") throw new Error("Desktop control currently requires macOS");
      if (name === "capture_screen") {
        if (screenPermission() !== "granted") throw new Error("Screen Recording permission is required");
        const display = electronScreen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: display.size });
        const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
        if (!source || source.thumbnail.isEmpty()) throw new Error("No display image was available");
        const frame = source.thumbnail.resize({ ...display.size, quality: "best" });
        if (frame.isEmpty()) throw new Error("The primary display capture could not be normalized to logical screen coordinates");
        await mkdir(captureDirectory, { recursive: true });
        const pathname = join(captureDirectory, `screen-${Date.now()}.png`);
        await writeFile(pathname, frame.toPNG(), { mode: 0o600 });
        return [
          `Captured the current display to ${pathname}`,
          `Logical click coordinates: origin ${display.bounds.x},${display.bounds.y}; size ${display.size.width}x${display.size.height}.`,
        ].join("\n");
      }
      if (automationPermission() !== "granted") throw new Error("Accessibility permission is required for application control");
      if (name === "open_application") {
        const appName = String(args.name ?? "").trim();
        if (!/^[a-zA-Z0-9 ._+()-]{1,100}$/.test(appName)) throw new Error("Application name contains unsupported characters");
        await runExecutable("/usr/bin/open", ["-a", appName]);
        return `Opened ${appName}`;
      }
      if (name === "click_screen") {
        const x = Number(args.x);
        const y = Number(args.y);
        const bounds = electronScreen.getPrimaryDisplay().bounds;
        const insidePrimary = pointInsideDisplay(x, y, bounds);
        if (!insidePrimary) throw new Error("Click coordinates must stay inside the primary display reported by the latest capture");
        await runExecutable("/usr/bin/osascript", ["-e", `tell application \"System Events\" to click at {${x}, ${y}}`]);
        return `Clicked screen position ${x}, ${y}`;
      }
      const text = String(args.text ?? "");
      if (!text || text.length > 4_000) throw new Error("Typed text must contain between 1 and 4,000 characters");
      await runExecutable("/usr/bin/osascript", ["-e", `tell application \"System Events\" to keystroke \"${escapedAppleScriptText(text)}\"`]);
      return `Typed ${text.length} characters into the active application`;
    },
  };
}

export function createElectronComputerSecrets(): ComputerAccessSecrets {
  return {
    seal(value: string): string {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable");
      return safeStorage.encryptString(value).toString("base64");
    },
    unseal(value: string): string {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable");
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
  };
}
