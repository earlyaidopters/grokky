import { spawn } from "node:child_process";
import { join } from "node:path";

const [targetPlatform, targetArch, targetKind] = process.argv.slice(2);

const targets = {
  "darwin:arm64:dir": {
    label: "Apple Silicon macOS application",
    hostPlatform: "darwin",
    builderArgs: ["--mac", "dir", "--arm64", "--publish", "never"],
  },
  "darwin:arm64:dmg": {
    label: "Apple Silicon macOS DMG",
    hostPlatform: "darwin",
    builderArgs: ["--mac", "dmg", "--arm64", "--publish", "never"],
  },
  "win32:x64:dir": {
    label: "Windows x64 application",
    hostPlatform: "win32",
    builderArgs: ["--win", "dir", "--x64", "--publish", "never"],
  },
  "win32:x64:nsis": {
    label: "Windows x64 NSIS installer",
    hostPlatform: "win32",
    builderArgs: ["--win", "nsis", "--x64", "--publish", "never"],
  },
};

const key = `${targetPlatform}:${targetArch}:${targetKind}`;
const target = targets[key];

if (!target) {
  throw new Error("Usage: node scripts/package-platform.mjs <darwin arm64 dir|dmg | win32 x64 dir|nsis>");
}

if (process.platform !== target.hostPlatform) {
  const hostName = target.hostPlatform === "darwin" ? "macOS" : "Windows";
  const ciRunner = target.hostPlatform === "darwin" ? "macos-14" : "windows-2022";
  throw new Error(
    `${target.label} must be built on ${hostName}. Electron cross-packaging can omit the target Codex runtime while still producing an app shell. Push to main to build and verify this target on the native ${ciRunner} GitHub runner.`,
  );
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}`));
    });
  });
}

const npmCli = process.env.npm_execpath;
const electronBuilderCli = join(process.cwd(), "node_modules", "electron-builder", "cli.js");
const packageVerifier = join(process.cwd(), "scripts", "check-packaged-codex.mjs");

if (!npmCli) throw new Error("Package this application through its npm scripts so the npm CLI path is available");

await run(process.execPath, [npmCli, "run", "build"]);
await run(process.execPath, [electronBuilderCli, ...target.builderArgs]);
await run(process.execPath, [packageVerifier, targetPlatform, targetArch]);

process.stdout.write(`${target.label} built and verified.\n`);
