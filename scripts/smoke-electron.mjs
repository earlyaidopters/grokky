import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const userData = process.env.GROKKY_SMOKE_USER_DATA_PATH || await mkdtemp(join(tmpdir(), "grokky-electron-smoke-"));
const screenshotPath = process.env.GROKKY_SMOKE_SCREENSHOT_PATH;
const screenshotView = process.env.GROKKY_SMOKE_VIEW;
const screenshotWidth = process.env.GROKKY_SMOKE_WIDTH;
const screenshotHeight = process.env.GROKKY_SMOKE_HEIGHT;
const layoutAssert = process.env.GROKKY_SMOKE_LAYOUT_ASSERT;
const electronPath = join(process.cwd(), "node_modules", ".bin", "electron");
const child = spawn(electronPath, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    GROKKY_SMOKE_EXIT_MS: "4500",
    GROKKY_USER_DATA_PATH: userData,
    ...(screenshotPath ? { GROKKY_SMOKE_SCREENSHOT_PATH: screenshotPath } : {}),
    ...(screenshotView ? { GROKKY_SMOKE_VIEW: screenshotView } : {}),
    ...(screenshotWidth ? { GROKKY_SMOKE_WIDTH: screenshotWidth } : {}),
    ...(screenshotHeight ? { GROKKY_SMOKE_HEIGHT: screenshotHeight } : {}),
    ...(layoutAssert ? { GROKKY_SMOKE_LAYOUT_ASSERT: layoutAssert } : {}),
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
if (code !== 0) throw new Error(`Electron smoke failed with status ${code}:\n${output.slice(-6_000)}`);
if (/uncaught|unhandled|failed to load|preload.*error/i.test(output)) throw new Error(`Electron smoke logged a runtime failure:\n${output.slice(-6_000)}`);
console.log("grokky-electron-ok");
