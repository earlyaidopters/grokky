import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const requestedView = process.env.GROKKY_SMOKE_VIEW;
const explicitScreenshot = process.env.GROKKY_SMOKE_SCREENSHOT_PATH;
const runFullSuite = process.argv.includes("--full") || process.env.GROKKY_SMOKE_SUITE === "full";
const defaultCases = [
  { view: "crew-tasks", width: "720", height: "720" },
  { view: "crew-meeting", width: "720", height: "720" },
  { view: "agent-watch-auto", width: "1440", height: "820" },
  { view: "computer-history", width: "720", height: "720" },
  { view: "computer-approval", width: "720", height: "720" },
  { view: "computer-pair", width: "720", height: "720" },
];
const fullCases = [
  { view: "accent-palette", width: "960", height: "760" },
  { view: "access-menu", width: "960", height: "760" },
  { view: "activity-compact", width: "720", height: "720" },
  { view: "activity-live", width: "960", height: "760" },
  { view: "agent-editor", width: "960", height: "760" },
  { view: "agent-select", width: "960", height: "760" },
  { view: "agent-watch", width: "1440", height: "820" },
  { view: "agent-watch-auto", width: "1024", height: "720" },
  { view: "agent-watch-auto", width: "1440", height: "820" },
  { view: "agent-watch-auto", width: "1920", height: "900" },
  { view: "agents", width: "960", height: "760" },
  { view: "computer", width: "640", height: "700" },
  { view: "computer", width: "1100", height: "820" },
  { view: "computer-approval", width: "640", height: "700" },
  { view: "computer-approval", width: "1000", height: "760" },
  { view: "computer-history", width: "720", height: "720" },
  { view: "computer-history", width: "1280", height: "820" },
  { view: "computer-pair", width: "720", height: "720" },
  { view: "connectors", width: "960", height: "760" },
  { view: "crew", width: "960", height: "760" },
  { view: "crew-dismiss", width: "960", height: "760" },
  { view: "crew-escape", width: "960", height: "760" },
  { view: "crew-inside", width: "960", height: "760" },
  { view: "crew-live", width: "720", height: "720" },
  { view: "crew-meeting", width: "720", height: "720" },
  { view: "crew-parallel", width: "720", height: "720" },
  { view: "crew-select-one", width: "960", height: "760" },
  { view: "crew-synthesis", width: "720", height: "720" },
  { view: "crew-tasks", width: "720", height: "720" },
  { view: "delete-cancel", width: "960", height: "760" },
  { view: "delete-complete", width: "960", height: "760" },
  { view: "delete-dialog", width: "960", height: "760" },
  { view: "feature-attention", width: "960", height: "760" },
  { view: "feature-routines", width: "960", height: "760" },
  { view: "feature-setup", width: "960", height: "760" },
  { view: "generated-artifact", width: "960", height: "760" },
  { view: "image-input", width: "640", height: "700" },
  { view: "image-input", width: "1280", height: "820" },
  { view: "light-theme", width: "960", height: "760" },
  { view: "mcp", width: "960", height: "760" },
  { view: "model-menu", width: "960", height: "760" },
  { view: "openrouter-model-menu", width: "960", height: "760" },
  { view: "preflight-access", width: "960", height: "760" },
  { view: "project-menu", width: "960", height: "760" },
  { view: "reasoning-menu", width: "1100", height: "760" },
  { view: "session-delete", width: "960", height: "760" },
  { view: "session-delete-click", width: "960", height: "760" },
  { view: "settings-select", width: "960", height: "760" },
  { view: "skills", width: "960", height: "760" },
  { view: "typography", width: "960", height: "760" },
  { view: "web-settings", width: "960", height: "760" },
];
const smokeCases = requestedView || explicitScreenshot
  ? [{
      view: requestedView || "crew-tasks",
      width: process.env.GROKKY_SMOKE_WIDTH || "960",
      height: process.env.GROKKY_SMOKE_HEIGHT || "760",
      screenshotPath: explicitScreenshot,
    }]
  : (runFullSuite ? fullCases : defaultCases).map((entry) => ({
      ...entry,
      width: process.env.GROKKY_SMOKE_WIDTH || entry.width,
      height: process.env.GROKKY_SMOKE_HEIGHT || entry.height,
    }));

for (const smokeCase of smokeCases) {
  const userData = smokeCases.length === 1 && process.env.GROKKY_SMOKE_USER_DATA_PATH
    ? process.env.GROKKY_SMOKE_USER_DATA_PATH
    : await mkdtemp(join(tmpdir(), `grokky-electron-smoke-${smokeCase.view}-`));
  const screenshotPath = smokeCase.screenshotPath || join(userData, `smoke-${smokeCase.view}.png`);
  const child = spawn(electronPath, ["."], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GROKKY_SMOKE_EXIT_MS: "400",
      GROKKY_USER_DATA_PATH: userData,
      GROKKY_SMOKE_SCREENSHOT_PATH: screenshotPath,
      GROKKY_SMOKE_VIEW: smokeCase.view,
      GROKKY_SMOKE_WIDTH: smokeCase.width,
      GROKKY_SMOKE_HEIGHT: smokeCase.height,
      GROKKY_SMOKE_LAYOUT_ASSERT: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Electron smoke ${smokeCase.view} failed with status ${code}:\n${output.slice(-6_000)}`);
  if (/uncaught|unhandled|failed to load|preload.*error/i.test(output)) throw new Error(`Electron smoke ${smokeCase.view} logged a runtime failure:\n${output.slice(-6_000)}`);
  if (!output.includes(`grokky-layout-ok:${smokeCase.width}x${smokeCase.height}`)) throw new Error(`Electron smoke ${smokeCase.view} did not verify its requested viewport:\n${output.slice(-6_000)}`);
  console.log(`grokky-electron-case-ok:${smokeCase.view}:${smokeCase.width}x${smokeCase.height}`);
}

console.log("grokky-electron-ok");
