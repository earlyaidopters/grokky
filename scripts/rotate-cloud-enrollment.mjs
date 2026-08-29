import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDirectory = join(repositoryRoot, "services", "sandbox-gateway");
const enrollment = `gsk_${randomBytes(48).toString("base64url")}`;
const keepTemporaryCopy = process.argv.includes("--temporary-env");

const child = spawn("npx", ["wrangler", "secret", "put", "GROKKY_ENROLLMENT_TOKEN"], {
  cwd: gatewayDirectory,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
child.stdin.end(`${enrollment}\n`);
const status = await new Promise((resolveStatus, reject) => {
  child.on("error", reject);
  child.on("close", resolveStatus);
});
if (status !== 0) throw new Error(`Wrangler could not rotate the enrollment secret:\n${output.slice(-4_000)}`);

if (keepTemporaryCopy) {
  const directory = await mkdtemp(join(tmpdir(), "grokky-production-enrollment-"));
  const pathname = join(directory, "enrollment.env");
  await writeFile(pathname, `GROKKY_ENROLLMENT_TOKEN=${enrollment}\n`, { mode: 0o600 });
  process.stdout.write(`${pathname}\n`);
} else {
  process.stdout.write("grokky-enrollment-rotated-and-discarded\n");
}
