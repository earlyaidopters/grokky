import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const output = await mkdtemp(join(tmpdir(), "grokky-companion-test-"));
const entry = join(output, "worker.mjs");
await build({ entryPoints: [resolve("src/index.ts")], bundle: true, outfile: entry, format: "esm", platform: "node", target: "es2023", external: ["cloudflare:*"], plugins: [{ name: "exclude-unused-browser-runtime", setup(build) {
  // This integration exercises the real HTTP auth/relay/DO paths. Browser execution has its own live canary.
  build.onResolve({ filter: /^@cloudflare\/(sandbox|playwright)$/ }, (args) => ({ path: args.path, namespace: "browser-fixture" }));
  build.onLoad({ filter: /.*/, namespace: "browser-fixture" }, (args) => ({ contents: args.path.endsWith("sandbox")
    ? 'import {DurableObject} from "cloudflare:workers"; export class Sandbox extends DurableObject {} export function getSandbox(){throw new Error("Browser runtime is outside this test");}'
    : 'export function acquire(){throw new Error("Unexpected browser call");} export const connect=acquire;' }));
}}] });
const enrollment = `gsk_${randomBytes(32).toString("hex")}`;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: await readFile(entry, "utf8"), compatibilityDate: "2026-08-28", compatibilityFlags: ["nodejs_compat"],
  bindings: { GROKKY_ENROLLMENT_TOKEN: enrollment, GROKKY_TOKEN_SECRET: randomBytes(32).toString("hex") },
  durableObjects: { CONTROL: { className: "GrokkyControl", useSQLite: true }, COMPANION: { className: "GrokkyCompanion", useSQLite: true }, Sandbox: { className: "GrokkySandbox", useSQLite: true } },
}));
const origin = "http://localhost";
async function post(path, body, token, expected = 200, requestOrigin = origin) {
  const response = await mf.dispatchFetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: requestOrigin }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, result.error || path);
  return result;
}
try {
  const device = await post("/pair", { code: enrollment });
  await post("/companion/start", {}, "wrong-token", 401);
  const session = await post("/companion/start", {}, device.token);
  const invite = new URL(session.inviteUrl).hash.split(".")[1];
  const phonePath = `/companion/phone/${session.roomId}`;
  const desktopPath = `/companion/desktop/${session.roomId}`;
  await post(phonePath + "/claim", {}, invite, 403, "https://untrusted.example");
  await post(phonePath + "/claim", {}, "a".repeat(64), 400);
  const phone = await post(phonePath + "/claim", {}, invite);
  await post(phonePath + "/claim", {}, invite, 400);
  await post(phonePath + "/poll", {}, "b".repeat(64), 400);
  const command = { id: randomUUID(), kind: "takeover", epoch: 0 };
  await post(phonePath + "/command", command, phone.token, 400);
  const snapshot = { title: "Fixture", owner: "agent", epoch: 0, expiresAt: session.expiresAt, confirmed: false, detail: "Fixture", frame: { id: "frame-a", data: "data:image/png;base64,AA==", width: 1280, height: 800 } };
  await post(desktopPath, { snapshot, confirm: true }, device.token);
  await post(phonePath + "/command", command, phone.token);
  const exchange = await post(desktopPath, { snapshot }, device.token);
  assert.equal(exchange.command.id, command.id);
  await post(phonePath + "/command", { ...command, id: randomUUID() }, phone.token, 400);
  await post(desktopPath, { snapshot: { ...snapshot, owner: "human", epoch: 1 }, ack: { id: command.id, ok: true, detail: "Paused" } }, device.token);
  const duplicate = await post(phonePath + "/command", command, phone.token);
  assert.equal(duplicate.duplicate, true);
  const tap = { id: randomUUID(), kind: "tap", epoch: 1, x: .5, y: .5, frameId: "frame-a" };
  await post(phonePath + "/command", { ...tap, frameId: "stale" }, phone.token, 400);
  await post(phonePath + "/command", tap, phone.token);
  await post(desktopPath, { snapshot: { ...snapshot, owner: "agent", epoch: 2 }, ack: { id: tap.id, ok: true, detail: "Clicked" } }, device.token);
  await post(phonePath + "/command", { ...tap, id: randomUUID() }, phone.token, 400);
  await post(phonePath + "/command", { ...tap, id: randomUUID(), epoch: 2 }, phone.token, 400);
  await post(desktopPath, { snapshot: { ...snapshot, frame: undefined } }, device.token);
  const polled = await post(phonePath + "/poll", {}, phone.token);
  assert.equal(polled.snapshot.frame.id, "frame-a");
  const unchanged = await post(phonePath + "/poll", { frameId: "frame-a" }, phone.token);
  assert.equal(unchanged.snapshot.frame, undefined);
  await post(desktopPath, { revoke: true }, device.token);
  await post(phonePath + "/poll", {}, phone.token, 400);
  const page = await mf.dispatchFetch(origin + "/phone");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  console.log("Companion integration passed: origin, one-time pairing, confirmation, serialization, replay, stale frame/epoch, ownership, frame reuse, revocation, and page headers.");
} finally { await mf.dispose(); await rm(output, { recursive: true, force: true }); }
