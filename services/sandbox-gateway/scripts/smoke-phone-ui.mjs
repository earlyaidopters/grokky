import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// Browser interactions use a deterministic relay fixture; smoke:companion tests real auth and DO state.
const directory = await mkdtemp(join(tmpdir(), "grokky-phone-ui-"));
await build({ entryPoints: [resolve("src/companion-ui.ts")], outfile: join(directory, "ui.mjs"), format: "esm" });
const { companionHtml } = await import(pathToFileURL(join(directory, "ui.mjs")).href);
const browser = await chromium.launch({ ...(process.env.GROKKY_CHROME_EXECUTABLE ? { executablePath: process.env.GROKKY_CHROME_EXECUTABLE } : {}), headless: true });
const fixture = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await fixture.setContent('<body style="font:24px Arial;padding:48px;background:#f6f7f2"><h1>Your booking</h1><p>Choose the option you want to keep.</p><label>Name <input style="font:24px Arial;padding:12px" value="Alex"></label><hr><p>Montreal → Istanbul</p><button style="padding:20px;font:24px Arial;background:#d1eba5">Keep this flight</button></body>');
const data = `data:image/png;base64,${(await fixture.screenshot()).toString("base64")}`;
await fixture.close();
let confirmed = false, online = true, rejectType = false;
let snapshot = { title: "Choose your flight", detail: "Grokky is working. Your Mac must stay awake.", owner: "agent", epoch: 0, frame: { id: "frame-1", data, width: 1280, height: 800 } };
const receipts = new Map(), commands = [];
const server = createServer(async (request, response) => {
  if (request.method === "GET") { response.setHeader("Content-Type", "text/html"); response.end(companionHtml); return; }
  let body = ""; for await (const part of request) body += part;
  const input = JSON.parse(body);
  let result = {};
  if (request.url.endsWith("claim")) result = { token: "c".repeat(64) };
  else if (request.url.endsWith("poll")) result = { confirmed, online, snapshot: confirmed && online ? { ...snapshot, ...(input.frameId === snapshot.frame.id ? { frame: undefined } : {}) } : undefined, receipt: receipts.get(input.receiptId) };
  else {
    commands.push(input); assert.equal(input.epoch, snapshot.epoch);
    if (input.kind === "takeover") snapshot = { ...snapshot, owner: "human", epoch: 1, detail: "You control the browser. Return it when you are finished." };
    if (input.kind === "resume") snapshot = { ...snapshot, owner: "agent", epoch: 3 };
    receipts.set(input.id, { ok: !(rejectType && input.kind === "type"), detail: rejectType && input.kind === "type" ? "Field changed. Select the field and retry." : "Done" }); result = { accepted: true };
  }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const errors = []; page.on("pageerror", error => errors.push(error.message));
async function ready(label) { await page.waitForFunction(() => !document.querySelector('#main').disabled); if (label) assert.equal(await page.locator('#main').innerText(), label); }
try {
  await page.goto(`${origin}/phone#${"a".repeat(32)}.${"b".repeat(64)}`);
  await page.waitForFunction(() => document.querySelector('#detail').textContent.includes('Confirm this phone'));
  assert.equal(new URL(page.url()).hash, ""); assert.ok(await page.locator('#main').isDisabled());
  confirmed = true; await ready("Take control");
  await page.locator('#main').click(); await ready("Return to Grokky");
  assert.ok(await page.locator('#controls').isVisible());
  await page.locator('#frame').click({ position: { x: 70, y: 40 } }); await ready();
  assert.ok(commands.at(-1).x > 0 && commands.at(-1).x < 1);
  await page.locator('#inputtext').fill("Example input"); await page.locator('#type').click(); await ready();
  assert.equal(await page.locator('#inputtext').inputValue(), ""); assert.equal(commands.at(-1).text, "Example input");
  rejectType = true;
  await page.locator('#inputtext').fill("Preserve rejected input"); await page.locator('#type').click();
  assert.equal(await page.locator('#type').getAttribute('aria-busy'), 'true'); await ready();
  assert.equal(await page.locator('#inputtext').inputValue(), "Preserve rejected input");
  assert.match(await page.locator('#error').innerText(), /Field changed/);
  rejectType = false; await page.locator('#type').click(); await ready();
  assert.equal(await page.locator('#inputtext').inputValue(), "");
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#main').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.locator('[data-key="Tab"]').click(); await ready();
  await page.locator('[data-scroll="down"]').click(); await ready();
  await page.locator('#zoom').click(); assert.ok(await page.locator('#screen').evaluate(el => el.scrollWidth > el.clientWidth));
  await page.locator('#zoom').click();
  const output = resolve(process.env.GROKKY_PHONE_UI_OUTPUT || "../../output/phone-ui"); await mkdir(output, { recursive: true });
  for (const [width, height] of [[390,844],[320,740],[844,390]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => scrollTo(0,0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}`);
    await page.screenshot({ path: join(output, `phone-${width}x${height}.png`), fullPage: true });
  }
  await page.locator('#note').fill("Keep this flight"); await page.locator('#main').click(); await ready("Take control");
  assert.equal(commands.at(-1).text, "Keep this flight");
  snapshot.approval = { id: "approval-fixture", action: "Open the booking page", target: "example.com" };
  await page.waitForFunction(() => !document.querySelector('#approval').classList.contains('hidden'));
  assert.ok(await page.locator('#main').isDisabled()); await page.locator('#allow').click();
  await page.waitForFunction(() => !document.querySelector('#allow').disabled);
  assert.equal(commands.at(-1).kind, "approve"); delete snapshot.approval;
  online = false; await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('offline'));
  assert.ok(await page.locator('#main').isDisabled()); assert.ok(await page.locator('#frame').isHidden());
  online = true; await ready();
  assert.ok(await page.locator('#frame').isVisible());
  await page.locator('#unpair').click(); assert.equal(await page.evaluate(() => sessionStorage.getItem('grokky-phone')), null);
  assert.deepEqual(errors, []);
  console.log("Phone UI passed: pairing, confirmation, tap, keyboard, scroll, zoom, successful input clearing, rejected input retention, pending feedback, reduced motion, resume note, approval, offline/reconnect, 320/390px portrait and landscape.");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
