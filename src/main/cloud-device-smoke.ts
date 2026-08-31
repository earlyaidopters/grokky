import { createHash, randomUUID } from "node:crypto";
import type { BrowserElementObservation, BrowserObservation, ComputerExecutionResult, ComputerToolName, ComputerAccessService } from "./computer-access";
import type { PersistedComputerAccess } from "./state-store";
import type { Conversation } from "../shared/contracts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digestArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function elementSummary(observation: BrowserObservation | undefined): string {
  return (observation?.elements ?? []).slice(0, 55).map((element) => `${element.role}:${element.name || element.text || element.placeholder || "unnamed"}${element.value ? ` = ${element.value}` : ""}${element.dateHint ? ` [${element.dateHint}]` : ""}`).join(" | ");
}

function requireElement(
  result: ComputerExecutionResult,
  predicate: (element: BrowserElementObservation) => boolean,
  label: string,
): BrowserElementObservation {
  const element = result.browserObservation?.elements.find(predicate);
  requireValue(element, `${label} was not exposed semantically. Observed: ${elementSummary(result.browserObservation)}`);
  return element;
}

export async function runPairedCloudDeviceSmoke(
  state: PersistedComputerAccess,
  conversation: Conversation,
  computerAccess: ComputerAccessService,
): Promise<{ checks: number; gatewayHost: string; liveView: true }> {
  const device = state.remoteDevices.find((candidate) => candidate.id === state.activeDeviceId && !candidate.revoked)
    ?? state.remoteDevices.find((candidate) => !candidate.revoked && candidate.platform === "cloudflare-linux");
  requireValue(device, "No paired Cloudflare computer is available in Grokky state");
  const endpoint = new URL(device.endpoint);
  requireValue(endpoint.protocol === "https:", "The production Cloudflare computer must use HTTPS");
  state.activeDeviceId = device.id;
  console.log("grokky-cloud-device-smoke-step:heartbeat:start");
  requireValue(await computerAccess.heartbeat(state), "The paired Cloudflare computer did not answer its heartbeat");
  console.log("grokky-cloud-device-smoke-step:heartbeat:ok");
  requireValue((device.protocolVersion ?? 0) >= 2, "The paired Cloudflare computer does not advertise semantic browser protocol v2");
  requireValue(device.browserTools?.includes("inspect_page") && device.browserTools.includes("fill_field"), "The paired Cloudflare computer is missing semantic browser tools");

  console.log("grokky-cloud-device-smoke-step:health:start");
  const healthResponse = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(15_000) });
  const health = await healthResponse.json() as { ok?: unknown };
  requireValue(healthResponse.ok && health.ok === true, "The Cloudflare computer health endpoint failed");
  console.log("grokky-cloud-device-smoke-step:health:ok");

  const runId = randomUUID().replaceAll("-", "");
  const conversationId = `conversation-production-${runId}`;
  const agentComputerId = `agent-computer-production-${runId}`;
  const executionConversation: Conversation = {
    ...structuredClone(conversation),
    id: conversationId,
    provider: "openrouter",
    sandboxMode: "workspace-write",
    allowCommands: true,
  };
  let actionIndex = 0;
  let disposed = false;

  const execute = async (name: ComputerToolName, args: Record<string, unknown>) => {
    actionIndex += 1;
    console.log(`grokky-cloud-device-smoke-step:${actionIndex}:${name}:start`);
    const result = await computerAccess.execute({
      state,
      conversation: executionConversation,
      name,
      args,
      approvedTarget: true,
      deviceId: device.id,
      auditContext: {
        actionId: `computer-production-${runId}-${actionIndex}`,
        conversationId,
        agentComputerId,
        agentName: "production smoke",
        argumentDigest: digestArguments(args),
      },
    });
    console.log(`grokky-cloud-device-smoke-step:${actionIndex}:${name}:ok`);
    return result;
  };

  try {
    const relativePath = `smoke/${runId}.txt`;
    await execute("create_file", { path: relativePath, content: "production-alpha\nproduction-beta\n" });
    requireValue((await execute("read_file", { path: relativePath })).output.includes("production-beta"), "Production read_file verification failed");
    await execute("edit_file", { path: relativePath, old_text: "production-beta", new_text: "production-gamma" });
    requireValue((await execute("list_files", {})).output.includes(runId), "Production list_files verification failed");
    requireValue((await execute("search_files", { query: "production-gamma" })).output.includes(runId), "Production search_files verification failed");
    requireValue((await execute("run_command", { command: "id -u && printf 'production-command-ok\\n'" })).output.includes("STDOUT\n1000\nproduction-command-ok"), "Production non-root command verification failed");

    const browserTarget = process.env.GROKKY_CLOUD_DEVICE_SMOKE_URL || "https://httpbin.org/forms/post";
    const browserTargetHost = new URL(browserTarget).hostname;
    const browse = await execute("browse_url", { url: browserTarget });
    requireValue(browse.output.includes("Title:") && browse.output.includes(browserTargetHost), "Production Browser Run page verification failed");
    const artifact = browse.visualArtifact;
    requireValue(artifact?.mimeType === "image/png" && artifact.width === 1280 && artifact.height === 800, "Production Browser Run frame metadata is invalid");
    const frame = Buffer.from(artifact.dataBase64, "base64");
    requireValue(frame.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Production Browser Run frame is not PNG");
    requireValue(createHash("sha256").update(frame).digest("hex") === artifact.sha256, "Production Browser Run frame digest failed");
    const liveView = new URL(artifact.liveViewUrl ?? "");
    requireValue(liveView.protocol === "https:" && liveView.hostname === "live.browser.run" && liveView.pathname.startsWith("/ui/"), "Production Browser Run did not return a valid Live View");
    requireValue(browse.browserObservation?.snapshotId.startsWith("page-") && browse.browserOutcome?.effect === "navigated", "Production browse did not return a structured semantic observation and outcome");

    const inspected = await execute("inspect_page", { mode: "both", limit: 100 });
    const customerName = inspected.browserObservation?.elements.find((element) => element.role === "textbox" && /customer name/i.test(`${element.name} ${element.placeholder ?? ""}`));
    requireValue(customerName, "Production semantic inspection did not expose the Customer name field");
    const proofValue = `grokky-semantic-${runId.slice(0, 12)}`;
    const filled = await execute("fill_field", { ref: customerName.ref, value: proofValue });
    requireValue(filled.browserOutcome?.effect === "changed" || filled.browserOutcome?.effect === "already_satisfied", "Production semantic fill did not report a verified state transition");
    requireValue(filled.browserObservation?.elements.some((element) => element.value === proofValue), "Production semantic fill value was not present in the returned observation");

    const refreshed = await execute("inspect_page", { mode: "interactive", limit: 100 });
    requireValue(refreshed.browserObservation?.elements.some((element) => element.value === proofValue), "Production semantic re-inspection lost the filled value");
    const stale = await execute("click_element", { ref: customerName.ref });
    requireValue(stale.browserOutcome?.effect === "stale_reference", "Production semantic reference expiry was not enforced");
    const capture = await execute("capture_screen", {});
    requireValue(capture.visualArtifact?.width === 1280 && capture.visualArtifact.height === 800, "Production capture_screen frame verification failed");

    if (process.env.GROKKY_CLOUD_DEVICE_SMOKE_TRAVEL === "1") {
      console.log("grokky-cloud-device-smoke-step:travel:start");
      let travel = await execute("browse_url", { url: "https://www.google.com/travel/flights?hl=en&curr=CAD" });
      const consent = travel.browserObservation?.elements.find((element) => element.role === "button" && /accept all|agree|accept/i.test(element.name));
      if (consent) travel = await execute("click_element", { ref: consent.ref });

      const origin = requireElement(travel, (element) => ["textbox", "combobox"].includes(element.role) && /where from|from/i.test(`${element.name} ${element.placeholder ?? ""}`), "Google Flights origin field");
      const chooseAutocomplete = async (current: ComputerExecutionResult, pattern: RegExp, waitText: string): Promise<ComputerExecutionResult> => {
        let latest = current;
        let option = latest.browserObservation?.elements.find((element) => ["option", "listitem", "button"].includes(element.role) && pattern.test(`${element.name} ${element.text ?? ""}`));
        if (!option) {
          try {
            latest = await execute("wait_for", { condition: "text_visible", value: waitText, timeout_ms: 4_000 });
          } catch {
            // Some Google autocomplete variants expose the selected input value but not dropdown text.
          }
          option = latest.browserObservation?.elements.find((element) => ["option", "listitem", "button"].includes(element.role) && pattern.test(`${element.name} ${element.text ?? ""}`));
        }
        if (option) return execute("click_element", { ref: option.ref });
        await execute("press_key", { key: "ArrowDown" });
        return execute("press_key", { key: "Enter" });
      };
      travel = await execute("click_element", { ref: origin.ref });
      await execute("press_key", { key: "Meta+A" });
      travel = await execute("type_text", { text: "YUL" });
      travel = await chooseAutocomplete(travel, /montreal|yul/i, "Montreal");
      requireValue(travel.browserObservation?.elements.some((element) => ["textbox", "combobox"].includes(element.role) && /where from|from/i.test(`${element.name} ${element.placeholder ?? ""}`) && /montreal|yul/i.test(element.value ?? "")), `Google Flights did not retain Montreal. Observed: ${elementSummary(travel.browserObservation)}`);

      const destination = requireElement(travel, (element) => ["textbox", "combobox"].includes(element.role) && /where to|to/i.test(`${element.name} ${element.placeholder ?? ""}`), "Google Flights destination field");
      travel = await execute("click_element", { ref: destination.ref });
      await execute("press_key", { key: "Meta+A" });
      travel = await execute("type_text", { text: "IST" });
      travel = await chooseAutocomplete(travel, /istanbul|\bist\b|\bsaw\b/i, "Istanbul");
      requireValue(travel.browserObservation?.elements.some((element) => ["textbox", "combobox"].includes(element.role) && /where to|to/i.test(`${element.name} ${element.placeholder ?? ""}`) && /istanbul|ist|saw/i.test(element.value ?? "")), `Google Flights did not retain Istanbul. Observed: ${elementSummary(travel.browserObservation)}`);

      const departure = requireElement(travel, (element) => ["button", "textbox", "combobox"].includes(element.role) && /departure|depart/i.test(`${element.name} ${element.placeholder ?? ""}`), "Google Flights departure date control");
      travel = await execute("click_element", { ref: departure.ref });
      const departureInputs = travel.browserObservation?.elements.filter((element) => element.role === "textbox" && /^departure$/i.test(element.name)) ?? [];
      const pickerDeparture = departureInputs.at(-1);
      requireValue(pickerDeparture, `Google Flights picker departure field was not exposed. Observed: ${elementSummary(travel.browserObservation)}`);
      travel = await execute("fill_field", { ref: pickerDeparture.ref, value: "12/13/2026" });
      travel = await execute("press_key", { key: "Enter" });
      const returnInputs = travel.browserObservation?.elements.filter((element) => element.role === "textbox" && /^return$/i.test(element.name)) ?? [];
      const pickerReturn = returnInputs.at(-1);
      requireValue(pickerReturn, `Google Flights picker return field was not exposed. Observed: ${elementSummary(travel.browserObservation)}`);
      travel = await execute("fill_field", { ref: pickerReturn.ref, value: "12/20/2026" });
      travel = await execute("press_key", { key: "Enter" });
      requireValue(/12\/13\/2026|Dec(?:ember)? 13/i.test(travel.browserObservation?.visibleText ?? "") || travel.browserObservation?.elements.some((element) => /12\/13\/2026|Dec(?:ember)? 13/i.test(element.value ?? "")), "Google Flights did not retain the departure date");
      requireValue(/12\/20\/2026|Dec(?:ember)? 20/i.test(travel.browserObservation?.visibleText ?? "") || travel.browserObservation?.elements.some((element) => /12\/20\/2026|Dec(?:ember)? 20/i.test(element.value ?? "")), "Google Flights did not retain the return date");
      const done = travel.browserObservation?.elements.find((element) => element.role === "button" && /^done$/i.test(element.name));
      if (done) travel = await execute("click_element", { ref: done.ref });

      const search = travel.browserObservation?.elements.find((element) => element.role === "button" && /^search$/i.test(`${element.name} ${element.text ?? ""}`));
      if (search) travel = await execute("click_element", { ref: search.ref });
      else {
        travel = await execute("press_key", { key: "Tab" });
        travel = await execute("press_key", { key: "Enter" });
      }
      await execute("wait_for", { condition: "text_visible", value: "Best", timeout_ms: 15_000 });
      travel = await execute("inspect_page", { mode: "both", limit: 120 });
      requireValue(/best|cheapest|flight results|round trip|ca\$/i.test(travel.browserObservation?.visibleText ?? ""), `Google Flights results were not evidenced. Observed: ${elementSummary(travel.browserObservation)}`);
      requireValue(/google\.com\/travel\/flights/.test(travel.browserObservation?.url ?? ""), "Google Flights left the expected results surface");
      console.log("grokky-cloud-device-smoke-step:travel:ok");
    }

    console.log("grokky-cloud-device-smoke-step:dispose:start");
    await computerAccess.disposeSeat(state, device.id, conversationId, agentComputerId);
    console.log("grokky-cloud-device-smoke-step:dispose:ok");
    disposed = true;
    return { checks: process.env.GROKKY_CLOUD_DEVICE_SMOKE_TRAVEL === "1" ? 31 : 21, gatewayHost: endpoint.hostname, liveView: true };
  } finally {
    if (!disposed) await computerAccess.disposeSeat(state, device.id, conversationId, agentComputerId).catch(() => undefined);
  }
}
