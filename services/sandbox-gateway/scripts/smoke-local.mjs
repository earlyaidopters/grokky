import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let endpoint = (process.env.GROKKY_GATEWAY_SMOKE_ENDPOINT || "").replace(/\/$/, "");
const skipBrowser = process.env.GROKKY_GATEWAY_SMOKE_SKIP_BROWSER === "1";
const versionOverride = process.env.GROKKY_GATEWAY_SMOKE_VERSION_OVERRIDE || "";
const conversationId = "conversation-local-smoke";
const agentComputerId = "agent-computer-local-smoke";
let actionSequence = 0;
let localDev;
let localStateDirectory;
let localDevOutput = "";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 8790;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopLocalDev() {
  if (localDev && localDev.exitCode === null) {
    const closed = new Promise((resolve) => localDev.once("close", resolve));
    localDev.kill("SIGTERM");
    await Promise.race([closed, delay(5_000)]);
    if (localDev.exitCode === null) {
      localDev.kill("SIGKILL");
      await Promise.race([closed, delay(2_000)]);
    }
  }
  if (localStateDirectory) await rm(localStateDirectory, { recursive: true, force: true });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function jsonFetch(pathname, init = {}) {
  const headers = new Headers(init.headers);
  if (versionOverride) headers.set("Cloudflare-Workers-Version-Overrides", `grokky-sandbox-gateway="${versionOverride}"`);
  const response = await fetch(`${endpoint}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(150_000) });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`${pathname} returned a non-JSON response with status ${response.status}`);
  }
  return { response, payload };
}

function assertReceipt(payload, label) {
  assert.match(payload.receiptId || "", /^runner-[a-zA-Z0-9_-]{8,160}$/, `${label} receipt`);
}

try {
  let enrollment = process.env.GROKKY_GATEWAY_SMOKE_ENROLLMENT || "";
  if (!endpoint) {
    enrollment = `gsk_${randomBytes(48).toString("base64url")}`;
    const signingSecret = randomBytes(64).toString("base64url");
    localStateDirectory = await mkdtemp(join(tmpdir(), "grokky-gateway-smoke-"));
    const envPath = join(localStateDirectory, "smoke.env");
    await writeFile(envPath, `GROKKY_ENROLLMENT_TOKEN=${enrollment}\nGROKKY_TOKEN_SECRET=${signingSecret}\n`, { mode: 0o600 });
    const port = await reservePort();
    endpoint = `http://127.0.0.1:${port}`;
    const require = createRequire(import.meta.url);
    const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
    localDev = spawn(process.execPath, [
      wranglerBin,
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--persist-to", join(localStateDirectory, "state"),
      "--env-file", envPath,
      "--log-level", "warn",
      "--show-interactive-dev-session=false",
    ], {
      cwd: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => { localDevOutput = `${localDevOutput}${chunk.toString("utf8")}`.slice(-30_000); };
    localDev.stdout.on("data", collect);
    localDev.stderr.on("data", collect);
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (localDev.exitCode !== null) throw new Error(`Wrangler exited before the local gateway was ready:\n${localDevOutput}`);
      try {
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2_000) });
        ready = response.ok;
      } catch {
        await delay(250);
      }
    }
    if (!ready) throw new Error(`Wrangler did not expose the local gateway before the readiness deadline:\n${localDevOutput}`);
  }
  assert.match(enrollment, /^gsk_[a-zA-Z0-9_-]{32,180}$/, "local or explicitly provided enrollment key");

const health = await jsonFetch("/health");
assert.equal(health.response.status, 200);
assert.equal(health.payload.ok, true);
assert.deepEqual(health.payload.capabilities, ["files", "commands", "browser", "screen", "automation"]);
assert.equal(health.payload.protocolVersion, 2);
assert.deepEqual(health.payload.browserTools, ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"]);

const pairing = await jsonFetch("/pair", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: enrollment }),
});
assert.equal(pairing.response.status, 200, "local enrollment must succeed in a fresh persistence directory");
assert.match(pairing.payload.device?.id || "", /^sandbox-[a-f0-9]{32}$/);
assert.equal(pairing.payload.device?.platform, "cloudflare-linux");
assert.equal(pairing.payload.device?.root, "/workspace");
assert.equal(typeof pairing.payload.token, "string");
assert.ok(pairing.payload.token.length >= 32);
const token = pairing.payload.token;

async function post(pathname, body, bearer = token) {
  return jsonFetch(pathname, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function execute(name, args, options = {}) {
  actionSequence += 1;
  const argumentDigest = digest(args);
  const actionId = options.actionId || `computer-local-smoke-${String(actionSequence).padStart(3, "0")}`;
  const result = await post("/execute", {
    name,
    args,
    mode: options.mode || "workspace-write",
    allowCommands: options.allowCommands ?? true,
    approvedTarget: options.approvedTarget ?? true,
    networkAllowlist: options.networkAllowlist || ["example.com"],
    auditContext: {
      actionId,
      conversationId,
      agentComputerId,
      agentName: "local smoke",
      argumentDigest,
      expiresAt: options.expiresAt || Date.now() + 120_000,
    },
  });
  return { ...result, actionId, argumentDigest };
}

const heartbeat = await post("/heartbeat", {});
assert.equal(heartbeat.response.status, 200);
assert.equal(heartbeat.payload.deviceId, pairing.payload.device.id);

for (const capability of ["files", "commands"]) {
  const probe = await post("/test", { capability });
  assert.equal(probe.response.status, 200, `${capability} capability probe`);
  assert.equal(probe.payload.ok, true);
}

const created = await execute("create_file", { path: "smoke/proof.txt", content: "alpha\nbeta\n" });
assert.equal(created.response.status, 200);
assert.match(created.payload.output, /Created smoke\/proof\.txt/);
assertReceipt(created.payload, "create_file");

const read = await execute("read_file", { path: "smoke/proof.txt" });
assert.equal(read.response.status, 200);
assert.equal(read.payload.output, "alpha\nbeta\n");

const edited = await execute("edit_file", { path: "smoke/proof.txt", old_text: "beta", new_text: "gamma" });
assert.equal(edited.response.status, 200);
assert.match(edited.payload.output, /Updated smoke\/proof\.txt/);

const listed = await execute("list_files", {});
assert.equal(listed.response.status, 200);
assert.match(listed.payload.output, /smoke\/proof\.txt/);

const searched = await execute("search_files", { query: "gamma" });
assert.equal(searched.response.status, 200);
assert.match(searched.payload.output, /smoke\/proof\.txt/);

const command = await execute("run_command", { command: "id -u && printf 'command-ok\\n'" });
assert.equal(command.response.status, 200);
assert.match(command.payload.output, /STDOUT\n1000\ncommand-ok/);

const link = await execute("run_command", { command: "ln -s /etc/passwd outside-link" });
assert.equal(link.response.status, 200);
const escapedRead = await execute("read_file", { path: "outside-link" });
assert.equal(escapedRead.response.status, 200);
assert.match(escapedRead.payload.output, /^Sandbox action failed: Symlinked paths outside/);
const directoryLink = await execute("run_command", { command: "ln -s /tmp outside-directory" });
assert.equal(directoryLink.response.status, 200);
const escapedCreate = await execute("create_file", { path: "outside-directory/grokky-escape.txt", content: "blocked\n" });
assert.equal(escapedCreate.response.status, 200);
assert.match(escapedCreate.payload.output, /^Sandbox action failed: Symlinked paths outside/);
const escapedCreateProof = await execute("run_command", { command: "test ! -e /tmp/grokky-escape.txt && printf 'escape-blocked\\n'" });
assert.equal(escapedCreateProof.response.status, 200);
assert.match(escapedCreateProof.payload.output, /escape-blocked/);

const oversizedFile = await execute("run_command", { command: "head -c 600000 /dev/zero | tr '\\0' a > too-large.txt" });
assert.equal(oversizedFile.response.status, 200);
const oversizedRead = await execute("read_file", { path: "too-large.txt" });
assert.equal(oversizedRead.response.status, 200);
assert.match(oversizedRead.payload.output, /^Sandbox action failed: File is too large/);

const replayArgs = { path: "smoke/proof.txt" };
const replayActionId = "computer-local-smoke-replay";
const replayFirst = await execute("read_file", replayArgs, { actionId: replayActionId });
const replaySecond = await execute("read_file", replayArgs, { actionId: replayActionId });
assert.equal(replayFirst.response.status, 200);
assert.equal(replaySecond.response.status, 200);
assert.equal(replaySecond.payload.replayed, true);
assert.equal(replaySecond.payload.receiptId, replayFirst.payload.receiptId);

const collision = await execute("read_file", { path: "smoke/another.txt" }, { actionId: replayActionId });
assert.equal(collision.response.status, 409);
assert.match(collision.payload.error || "", /already claimed for different arguments/);

const expired = await execute("read_file", replayArgs, { expiresAt: Date.now() - 10_000 });
assert.equal(expired.response.status, 400);
assert.match(expired.payload.error || "", /expired or invalid/);

const unauthorized = await post("/heartbeat", {}, "not-a-valid-device-token");
assert.equal(unauthorized.response.status, 401);

let browserLiveViewReturned = false;
if (!skipBrowser) {
  const browserTarget = process.env.GROKKY_GATEWAY_SMOKE_URL || "https://httpbin.org/forms/post";
  const browser = await execute("browse_url", { url: browserTarget }, { networkAllowlist: [new URL(browserTarget).hostname] });
  assert.equal(browser.response.status, 200);
  assert.match(browser.payload.output, /Title:/);
  assert.equal(browser.payload.visualArtifact?.mimeType, "image/png");
  assert.equal(new URL(browser.payload.visualArtifact?.currentUrl).hostname, new URL(browserTarget).hostname);
  assert.match(browser.payload.browserObservation?.snapshotId || "", /^page-[a-f0-9]{16}$/);
  assert.equal(browser.payload.browserOutcome?.effect, "navigated");
  const frame = Buffer.from(browser.payload.visualArtifact.dataBase64, "base64");
  assert.equal(frame.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(createHash("sha256").update(frame).digest("hex"), browser.payload.visualArtifact.sha256);
  browserLiveViewReturned = typeof browser.payload.visualArtifact?.liveViewUrl === "string";

  const inspected = await execute("inspect_page", { mode: "both", limit: 100 });
  const customerName = inspected.payload.browserObservation?.elements?.find((element) => element.role === "textbox" && /customer name/i.test(`${element.name || ""} ${element.placeholder || ""}`));
  assert.ok(customerName, "semantic inspection must expose the Customer name field");
  const proofValue = `semantic-smoke-${randomBytes(8).toString("hex")}`;
  const filled = await execute("fill_field", { ref: customerName.ref, value: proofValue });
  assert.equal(filled.response.status, 200);
  assert.ok(["changed", "already_satisfied"].includes(filled.payload.browserOutcome?.effect));
  assert.ok(filled.payload.browserObservation?.elements?.some((element) => element.value === proofValue), "semantic fill must be verified in the next observation");
  const refreshed = await execute("inspect_page", { mode: "interactive", limit: 100 });
  assert.ok(refreshed.payload.browserObservation?.elements?.some((element) => element.value === proofValue));
  const stale = await execute("click_element", { ref: customerName.ref });
  assert.equal(stale.payload.browserOutcome?.effect, "stale_reference");
  const captured = await execute("capture_screen", {});
  assert.equal(captured.payload.visualArtifact?.width, 1280);
  assert.equal(captured.payload.visualArtifact?.height, 800);
}

const disposal = await post("/dispose", { conversationId, agentComputerId });
assert.equal(disposal.response.status, 200);
assert.equal(disposal.payload.ok, true);
assertReceipt(disposal.payload, "dispose");

const revoke = await post("/revoke", {});
assert.equal(revoke.response.status, 200);
assert.equal(revoke.payload.ok, true);
assert.equal(revoke.payload.tokenEpoch, pairing.payload.tokenEpoch + 1);
assertReceipt(revoke.payload, "revoke");

const staleHeartbeat = await post("/heartbeat", {});
assert.equal(staleHeartbeat.response.status, 401);

const reusedEnrollment = await jsonFetch("/pair", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: enrollment }),
});
assert.equal(reusedEnrollment.response.status, 403);

console.log(JSON.stringify({
  ok: true,
  gateway: "local Wrangler + Durable Objects + Sandbox container",
  checks: skipBrowser ? 27 : 35,
  browser: skipBrowser ? "explicitly skipped (use production Browser Run smoke separately)" : "passed",
  liveViewReturned: browserLiveViewReturned,
}));
} finally {
  await stopLocalDev();
}
