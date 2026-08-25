import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const [platform, arch] = process.argv.slice(2);
const platformConfig = platform === "darwin" && arch === "arm64"
  ? {
      resources: join(process.cwd(), "release", "mac-arm64", "Grokky.app", "Contents", "Resources"),
      packageName: "codex-darwin-arm64",
      vendorPlatform: "aarch64-apple-darwin",
      executable: "codex",
    }
  : platform === "win32" && arch === "x64"
    ? {
        resources: join(process.cwd(), "release", "win-unpacked", "resources"),
        packageName: "codex-win32-x64",
        vendorPlatform: "x86_64-pc-windows-msvc",
        executable: "codex.exe",
      }
    : undefined;

if (!platformConfig) {
  throw new Error("Usage: node scripts/check-packaged-codex.mjs <darwin arm64|win32 x64>");
}

const executablePath = join(
  platformConfig.resources,
  "app.asar.unpacked",
  "node_modules",
  "@openai",
  platformConfig.packageName,
  "vendor",
  platformConfig.vendorPlatform,
  "bin",
  platformConfig.executable,
);

await access(executablePath, constants.R_OK);
const info = await stat(executablePath);
if (!info.isFile() || info.size < 1_000_000) throw new Error(`Bundled Codex executable is invalid: ${executablePath}`);

process.stdout.write(`Packaged Codex runtime verified (${info.size.toLocaleString()} bytes).\n`);
