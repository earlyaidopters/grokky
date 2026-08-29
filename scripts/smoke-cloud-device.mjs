import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const override = process.env.GROKKY_INSTALLED_EXECUTABLE;
const candidates = override ? [override] : process.platform === "darwin"
  ? [
      "/Applications/Grokky.app/Contents/MacOS/Grokky",
      join(process.cwd(), "release", "mac-arm64", "Grokky.app", "Contents", "MacOS", "Grokky"),
  ]
  : process.platform === "win32"
    ? [
        join(process.env.LOCALAPPDATA || "", "Programs", "Grokky", "Grokky.exe"),
        join(process.cwd(), "release", "win-unpacked", "Grokky.exe"),
      ]
    : [];
const executable = candidates.find((candidate) => candidate && existsSync(candidate));
if (!executable) throw new Error("Install Grokky first or set GROKKY_INSTALLED_EXECUTABLE to the packaged app executable");

const child = spawn(executable, [], {
  env: { ...process.env, GROKKY_CLOUD_DEVICE_SMOKE: "1" },
  stdio: "inherit",
});
let timedOut = false;
let hardKill;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
}, 5 * 60_000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
clearTimeout(timeout);
if (hardKill) clearTimeout(hardKill);
if (timedOut) throw new Error("Installed Grokky cloud-device smoke exceeded its five-minute deadline");
if (code !== 0) throw new Error(`Installed Grokky cloud-device smoke failed with status ${code}`);
