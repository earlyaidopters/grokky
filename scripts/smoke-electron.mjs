import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electronPath = join(process.cwd(), "node_modules", ".bin", "electron");
const requestedView = process.env.GROKKY_SMOKE_VIEW;
const explicitScreenshot = process.env.GROKKY_SMOKE_SCREENSHOT_PATH;
const defaultCases = [
  { view: "crew-tasks", width: "720", height: "720" },
  { view: "crew-meeting", width: "720", height: "720" },
  { view: "agent-watch-auto", width: "860", height: "720" },
  { view: "computer-history", width: "720", height: "720" },
  { view: "computer-approval", width: "720", height: "720" },
  { view: "computer-pair", width: "720", height: "720" },
];
const smokeCases = requestedView || explicitScreenshot
  ? [{
      view: requestedView || "crew-tasks",
      width: process.env.GROKKY_SMOKE_WIDTH || "960",
      height: process.env.GROKKY_SMOKE_HEIGHT || "760",
      screenshotPath: explicitScreenshot,
    }]
  : defaultCases.map((entry) => ({
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
