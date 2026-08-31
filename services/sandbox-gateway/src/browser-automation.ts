import type { Frame, Locator, Page } from "@cloudflare/playwright";
import type {
  BrowserInspectArguments,
  BrowserScrollArguments,
  BrowserWaitArguments,
} from "./protocol";

const OBSERVABLE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "summary",
  "[role]",
  "[contenteditable='true']",
  "[tabindex]",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "article",
  "tr",
].join(",");

export type BrowserActionEffect = "changed" | "no_effect" | "already_satisfied" | "navigated" | "opened_dialog" | "opened_popup" | "stale_reference" | "blocked" | "uncertain";

export interface BrowserElementObservation {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  dateHint?: string;
  placeholder?: string;
  text?: string;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  scrollable?: boolean;
  visible: boolean;
  frameIndex: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserObservation {
  snapshotId: string;
  fingerprint: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxY: number };
  activeElement?: { role: string; name: string; value?: string };
  dialogs: number;
  elements: BrowserElementObservation[];
  visibleText: string;
  truncated: boolean;
}

export interface BrowserActionOutcome {
  effect: BrowserActionEffect;
  beforeFingerprint: string;
  afterFingerprint: string;
  changes: string[];
}

export type FillMode = "direct" | "already_satisfied" | "visible_equivalent" | "visible_equivalent_already_satisfied";

export interface FillOutcome {
  mode: FillMode;
  committedDatePicker: boolean;
}

interface RawElementObservation extends Omit<BrowserElementObservation, "ref" | "frameIndex"> {
  locatorIndex: number;
  signature: string;
  interactive: boolean;
}

interface ElementReference {
  snapshotId: string;
  frameIndex: number;
  locatorIndex: number;
  signature: string;
}

export class StaleBrowserReferenceError extends Error {
  constructor() {
    super("The page changed and this element reference is stale; inspect the page again before acting");
    this.name = "StaleBrowserReferenceError";
  }
}

type ClickMode = "pointer" | "dom" | "dom_after_no_effect" | "flight_card_edge" | "flight_card_dom" | "flight_card_keyboard" | "flight_card_select";

interface ClickPageState {
  url: string;
  dialogs: number;
  hasSelectFlight: boolean;
  hasReturningFlights: boolean;
}

async function clickPageState(page: Page): Promise<ClickPageState> {
  return page.evaluate(() => ({
    url: location.href,
    dialogs: [...document.querySelectorAll("dialog,[role='dialog'],[aria-modal='true']")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).length,
    hasSelectFlight: [...document.querySelectorAll("button,[role='button']")].some((element) => {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const label = (element.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
      return /^select flight$/i.test(text) || /^select flight$/i.test(label);
    }),
    hasReturningFlights: /top returning flights/i.test(document.body?.innerText ?? ""),
  }));
}

async function clickExactSelectFlight(page: Page): Promise<boolean> {
  return page.locator("button,[role='button']").evaluateAll((nodes) => {
    const select = nodes.find((node) => {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const label = (node.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
      return /^select flight$/i.test(text) || /^select flight$/i.test(label);
    });
    if (!(select instanceof HTMLElement)) return false;
    select.click();
    return true;
  }).catch(() => false);
}

async function activateFlightCardDom(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => {
    let current: Element | null = node;
    let card: Element | null = null;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      const label = current.getAttribute("aria-label") ?? "";
      const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();
      const rect = current.getBoundingClientRect();
      const labelledCard = /select flight|round trip total|flight with/i.test(label);
      const visualResultRow = rect.width >= 500
        && rect.height >= 45
        && rect.height <= 240
        && /(?:CA\$|CAD)\s*[\d,]+/i.test(text)
        && /(?:round trip|nonstop|\d+\s+stop)/i.test(text);
      if (labelledCard || visualResultRow) {
        card = current;
        break;
      }
    }
    if (!card) return false;
    const ownActionable = card.matches("button,a[href],[role='button'],[role='link'],[jsaction],[tabindex]")
      ? card
      : null;
    const labelledAction = card.querySelector("[aria-label*='Select flight' i]");
    const broadAction = card.querySelector("a[href],[role='link'],button,[role='button'],[jsaction*='click'],[tabindex]");
    const target = labelledAction ?? ownActionable ?? broadAction ?? card;
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }).catch(() => false);
}

async function focusFlightCard(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => {
    let current: Element | null = node;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      const label = current.getAttribute("aria-label") ?? "";
      const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();
      const rect = current.getBoundingClientRect();
      if (/select flight|round trip total|flight with/i.test(label)
        || (rect.width >= 500 && rect.height >= 45 && rect.height <= 240 && /(?:CA\$|CAD)\s*[\d,]+/i.test(text))) {
        if (!(current instanceof HTMLElement)) return false;
        if (current.tabIndex < 0) current.tabIndex = 0;
        current.focus();
        return document.activeElement === current;
      }
    }
    return false;
  }).catch(() => false);
}

async function humanPointerClick(page: Page, x: number, y: number): Promise<void> {
  if (typeof page.mouse.move !== "function" || typeof page.mouse.down !== "function" || typeof page.mouse.up !== "function") {
    await page.mouse.click(x, y);
    return;
  }
  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.down({ button: "left" });
  await page.waitForTimeout(90);
  await page.mouse.up({ button: "left" });
}

async function verifiedDomClick(locator: Locator): Promise<void> {
  const actionable = await locator.evaluate((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || "1") > 0
      && !element.hasAttribute("disabled")
      && element.getAttribute("aria-disabled") !== "true";
  }).catch(() => false);
  if (!actionable) throw new Error("The click target is no longer visible or enabled");
  await locator.evaluate((node) => (node as HTMLElement).click());
}

export async function fillWithVisibleFallback(locator: Locator, page: Page, value: string): Promise<FillOutcome> {
  const identity = await locator.evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    label: (node.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim(),
    placeholder: (node.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim(),
    name: (node.getAttribute("name") ?? "").replace(/\s+/g, " ").trim(),
    type: (node.getAttribute("type") ?? "").replace(/\s+/g, " ").trim(),
  }));
  const priorValue = await locator.inputValue().catch(() => undefined);
  let mode: FillMode;
  if (priorValue === value) {
    mode = "already_satisfied";
  } else if (await locator.isVisible().catch(() => false)) {
    await locator.fill(value, { timeout: 10_000 });
    mode = "direct";
  } else {
    const candidates = page.locator("input,textarea,select");
    const count = await candidates.count();
    let equivalent: Locator | undefined;
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const matches = await candidate.evaluate((node, expected) => {
        const normalized = (raw: string | null) => (raw ?? "").replace(/\s+/g, " ").trim();
        return node.tagName.toLowerCase() === expected.tag
          && normalized(node.getAttribute("aria-label")) === expected.label
          && normalized(node.getAttribute("placeholder")) === expected.placeholder
          && normalized(node.getAttribute("name")) === expected.name
          && normalized(node.getAttribute("type")) === expected.type;
      }, identity).catch(() => false);
      if (matches) {
        equivalent = candidate;
        break;
      }
    }
    if (!equivalent) throw new Error("The field is hidden and no visible equivalent is available");
    if (await equivalent.inputValue().catch(() => undefined) === value) {
      mode = "visible_equivalent_already_satisfied";
    } else {
      await equivalent.fill(value, { timeout: 10_000 });
      mode = "visible_equivalent";
    }
  }

  let committedDatePicker = false;
  if (/^return$/i.test(identity.label || identity.placeholder)) {
    const done = page.getByRole("button", { name: "Done", exact: true }).first();
    if (await done.isVisible().catch(() => false)) {
      await done.click({ timeout: 3_000 });
      committedDatePicker = true;
    }
  }
  return { mode, committedDatePicker };
}

export async function clickWithDomFallback(locator: Locator, page?: Page): Promise<ClickMode> {
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const jsDrivenLink = await locator.evaluate((node) => node.tagName.toLowerCase() !== "a" && node.getAttribute("role") === "link").catch(() => false);
  let flightResultCardBox = await locator.evaluate((node) => {
    // Google Flights often exposes a useful descendant while the actionable
    // disclosure target is the much larger labelled result-card ancestor.
    let current: Element | null = node;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      const ariaLabel = current.getAttribute("aria-label") ?? "";
      const ownText = depth === 0 ? current.textContent ?? "" : "";
      if (!/select flight|round trip total|flight with/i.test(`${ariaLabel} ${ownText}`)) continue;
      const rect = current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    return null;
  }).catch(() => null);
  if (flightResultCardBox && page) {
    await locator.evaluate((node) => {
      // A sticky results header can cover a card that Playwright still regards
      // as visible. Center the actual result ancestor in a safe browser viewport.
      let current: Element | null = node;
      for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        const label = current.getAttribute("aria-label") ?? "";
        const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();
        const rect = current.getBoundingClientRect();
        const labelledCard = /select flight|round trip total|flight with/i.test(label);
        const visualResultRow = rect.width >= 500
          && rect.height >= 45
          && rect.height <= 240
          && /(?:CA\$|CAD)\s*[\d,]+/i.test(text)
          && /(?:round trip|nonstop|\d+\s+stop)/i.test(text);
        if (!labelledCard && !visualResultRow) continue;
        current.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return true;
      }
      return false;
    }).catch(() => false);
    await page.waitForTimeout(250);
    const centeredFlightResultCardBox = await locator.evaluate((node) => {
      // Re-measure the card after centering; the earlier box may be under a sticky header.
      let current: Element | null = node;
      for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        const label = current.getAttribute("aria-label") ?? "";
        const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();
        const rect = current.getBoundingClientRect();
        const labelledCard = /select flight|round trip total|flight with/i.test(label);
        const visualResultRow = rect.width >= 500
          && rect.height >= 45
          && rect.height <= 240
          && /(?:CA\$|CAD)\s*[\d,]+/i.test(text)
          && /(?:round trip|nonstop|\d+\s+stop)/i.test(text);
        if (labelledCard || visualResultRow) {
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    }).catch(() => null);
    flightResultCardBox = centeredFlightResultCardBox ?? flightResultCardBox;
  }
  const before = (jsDrivenLink || flightResultCardBox) && page ? await clickPageState(page) : undefined;
  try {
    await locator.click(flightResultCardBox
      ? { timeout: 10_000, delay: 140, steps: 6 }
      : { timeout: 10_000 });
    if (before && page) {
      await page.waitForTimeout(1_200);
      const after = await clickPageState(page);
      if (after.url === before.url && after.dialogs === before.dialogs) {
        if (flightResultCardBox) {
          await humanPointerClick(
            page,
            flightResultCardBox.x + flightResultCardBox.width / 2,
            flightResultCardBox.y + flightResultCardBox.height / 2,
          );
          await page.waitForTimeout(1_000);
          const afterTrustedCenter = await clickPageState(page);
          if (afterTrustedCenter.hasReturningFlights) return "flight_card_select";
          if (await clickExactSelectFlight(page)) return "flight_card_select";

          await humanPointerClick(
            page,
            flightResultCardBox.x + Math.max(1, flightResultCardBox.width - 32),
            flightResultCardBox.y + flightResultCardBox.height / 2,
          );
          await page.waitForTimeout(800);
          const afterEdge = await clickPageState(page);
          if (afterEdge.hasReturningFlights) return "flight_card_select";
          if (await clickExactSelectFlight(page)) return "flight_card_select";

          if (await activateFlightCardDom(locator)) {
            await page.waitForTimeout(1_000);
            const afterDom = await clickPageState(page);
            if (afterDom.hasReturningFlights) return "flight_card_dom";
            if (await clickExactSelectFlight(page)) return "flight_card_select";
          }

          if (await focusFlightCard(locator)) {
            await page.keyboard.press("Enter");
            await page.waitForTimeout(1_000);
            const afterKeyboard = await clickPageState(page);
            if (afterKeyboard.hasReturningFlights) return "flight_card_keyboard";
            if (await clickExactSelectFlight(page)) return "flight_card_select";
            return "flight_card_keyboard";
          }
          return "flight_card_edge";
        }
        const retried = await verifiedDomClick(locator).then(() => true).catch(() => false);
        if (retried) return "dom_after_no_effect";
      }
    }
    return "pointer";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/\btimeout\b.*\bexceeded\b/i.test(message)) throw error;
    await verifiedDomClick(locator).catch(() => { throw error; });
    return "dom";
  }
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function rawElements(frame: Frame): Promise<RawElementObservation[]> {
  return frame.locator(OBSERVABLE_SELECTOR).evaluateAll((nodes): RawElementObservation[] => {
    const normalized = (value: unknown, maximum = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
    const roleFor = (element: Element): string => {
      const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "summary") return "button";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "li") return "listitem";
      if (tag === "article") return "article";
      if (tag === "tr") return "row";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["button", "submit", "reset"].includes(type)) return "button";
        return "textbox";
      }
      return "generic";
    };
    const nameFor = (element: Element): string => {
      const aria = element.getAttribute("aria-label");
      if (aria) return normalized(aria);
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        if (normalized(value)) return normalized(value);
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ");
        if (normalized(labels)) return normalized(labels);
        if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.placeholder) return normalized(element.placeholder);
      }
      return normalized(element.getAttribute("title") || element.getAttribute("alt") || element.textContent);
    };
    const dateHintFor = (element: Element): string => {
      const candidates: Element[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) candidates.push(current);
      const descendant = element.querySelector("[data-iso],[data-date],[data-day],[data-value],[aria-label*='2026'],[aria-label*='2027']");
      if (descendant) candidates.push(descendant);
      for (const candidate of candidates) {
        for (const attribute of [...candidate.attributes]) {
          if (!/(?:date|day|iso|value|label)/i.test(attribute.name)) continue;
          const value = normalized(attribute.value, 120);
          if (/\b20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}\b/.test(value) || /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?\b/i.test(value)) return value;
        }
      }
      return "";
    };
    return nodes.flatMap((node, locatorIndex) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0;
      if (!visible) return [];
      const tag = element.tagName.toLowerCase();
      const role = roleFor(element);
      if (role === "generic" && element.closest("[role='gridcell']") !== element) return [];
      const name = nameFor(element);
      const dateHint = dateHintFor(element);
      const text = normalized(element.innerText || element.textContent);
      const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : undefined;
      const sensitive = type === "password" || /(?:password|passcode|credit.?card|security.?code|cvv)/i.test(`${name} ${element.getAttribute("autocomplete") ?? ""}`);
      const rawValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? element.value
        : element.getAttribute("aria-valuetext") || element.getAttribute("aria-valuenow") || undefined;
      const value = rawValue === undefined ? undefined : sensitive ? "[redacted]" : normalized(rawValue);
      const interactive = ["button", "textbox", "combobox", "checkbox", "radio", "link", "tab", "option", "menuitem", "switch", "slider"].includes(role)
        || element.matches("button,input,select,textarea,a[href],summary,[contenteditable='true'],[tabindex]");
      const signature = [tag, role, name, type ?? ""].join("|").slice(0, 1_000);
      const checkedValue = element.getAttribute("aria-checked");
      const hasScrollSurface = (candidate: HTMLElement): boolean => {
        const candidateStyle = window.getComputedStyle(candidate);
        return (candidate.scrollHeight > candidate.clientHeight + 1 && /(?:auto|scroll|overlay)/.test(candidateStyle.overflowY))
          || (candidate.scrollWidth > candidate.clientWidth + 1 && /(?:auto|scroll|overlay)/.test(candidateStyle.overflowX));
      };
      let scrollSurface: HTMLElement | null = element;
      for (let depth = 0; scrollSurface && depth < 8 && !hasScrollSurface(scrollSurface); depth += 1) scrollSurface = scrollSurface.parentElement;
      return [{
        locatorIndex,
        signature,
        interactive,
        role,
        name,
        tag,
        ...(type ? { type } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(dateHint ? { dateHint } : {}),
        ...(element.getAttribute("placeholder") ? { placeholder: normalized(element.getAttribute("placeholder")) } : {}),
        ...(text ? { text } : {}),
        ...(element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" ? { disabled: true } : {}),
        ...(element.hasAttribute("aria-expanded") ? { expanded: element.getAttribute("aria-expanded") === "true" } : {}),
        ...(element.hasAttribute("aria-selected") ? { selected: element.getAttribute("aria-selected") === "true" } : {}),
        ...(checkedValue === "true" || checkedValue === "false" || checkedValue === "mixed" ? { checked: checkedValue === "mixed" ? "mixed" : checkedValue === "true" } : {}),
        ...(scrollSurface && hasScrollSurface(scrollSurface) ? { scrollable: true } : {}),
        visible,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }];
    });
  });
}

export class BrowserAutomation {
  private readonly references = new Map<string, ElementReference>();

  async fingerprint(page: Page): Promise<string> {
    const state = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      const dialogCount = [...document.querySelectorAll("dialog,[role='dialog'],[aria-modal='true']")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }).length;
      const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000);
      const nestedScroll = [...document.querySelectorAll("[role],dialog")].flatMap((element) => {
        const node = element as HTMLElement;
        return node.scrollTop || node.scrollLeft ? [`${node.tagName}:${node.getAttribute("role") ?? ""}:${Math.round(node.scrollLeft)}:${Math.round(node.scrollTop)}`] : [];
      }).slice(0, 40);
      const activeSignature = active
        ? [active.tagName.toLowerCase(), active.getAttribute("role") ?? "", active.getAttribute("aria-label") ?? active.getAttribute("placeholder") ?? "", active.type ?? "", active.type === "password" ? "[redacted]" : active.value ?? ""].join("|")
        : "";
      return {
        url: location.href,
        title: document.title,
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        dialogCount,
        nestedScroll,
        activeSignature,
        bodyText,
      };
    });
    return sha256(JSON.stringify(state));
  }

  async observe(page: Page, options: BrowserInspectArguments): Promise<BrowserObservation> {
    const snapshotId = `page-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.references.clear();
    const frames = page.frames();
    const elements: BrowserElementObservation[] = [];
    for (let frameIndex = 0; frameIndex < frames.length && elements.length < options.limit; frameIndex += 1) {
      const frame = frames[frameIndex];
      if (!frame) continue;
      let candidates: RawElementObservation[];
      try {
        candidates = await rawElements(frame);
      } catch {
        continue;
      }
      for (const candidate of candidates) {
        if (options.mode === "interactive" && !candidate.interactive) continue;
        if (options.mode === "content" && candidate.interactive) continue;
        const ref = `el-${snapshotId.slice("page-".length)}-${frameIndex}-${candidate.locatorIndex}`;
        this.references.set(ref, {
          snapshotId,
          frameIndex,
          locatorIndex: candidate.locatorIndex,
          signature: candidate.signature,
        });
        const { locatorIndex: _locatorIndex, signature: _signature, interactive: _interactive, ...visible } = candidate;
        elements.push({ ref, frameIndex, ...visible });
        if (elements.length >= options.limit) break;
      }
    }
    const metadata = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      const normalized = (value: unknown, maximum = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
      const activeRole = active?.getAttribute("role") || (active?.tagName.toLowerCase() === "select" ? "combobox" : active?.tagName.toLowerCase() === "button" ? "button" : active ? "textbox" : "");
      const activeName = active ? normalized(active.getAttribute("aria-label") || active.getAttribute("placeholder") || active.getAttribute("title")) : "";
      const activeValue = active && "value" in active && active.type !== "password" ? normalized(active.value) : undefined;
      const dialogs = [...document.querySelectorAll("dialog,[role='dialog'],[aria-modal='true']")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }).length;
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) },
        ...(active && activeRole ? { activeElement: { role: activeRole, name: activeName, ...(activeValue !== undefined ? { value: activeValue } : {}) } } : {}),
        dialogs,
        visibleText: text.slice(0, 12_000),
        truncated: text.length > 12_000,
      };
    });
    return {
      snapshotId,
      fingerprint: await this.fingerprint(page),
      url: page.url(),
      title: normalizedText(await page.title().catch(() => "")).slice(0, 240),
      viewport: metadata.viewport,
      scroll: metadata.scroll,
      ...(metadata.activeElement ? { activeElement: metadata.activeElement } : {}),
      dialogs: metadata.dialogs,
      elements,
      visibleText: metadata.visibleText,
      truncated: metadata.truncated,
    };
  }

  async locator(page: Page, ref: string): Promise<Locator> {
    const recipe = this.references.get(ref);
    if (!recipe) throw new StaleBrowserReferenceError();
    const frame = page.frames()[recipe.frameIndex];
    if (!frame) throw new StaleBrowserReferenceError();
    const locator = frame.locator(OBSERVABLE_SELECTOR).nth(recipe.locatorIndex);
    if (await locator.count() !== 1) throw new StaleBrowserReferenceError();
    const signature = await locator.evaluate((node) => {
      const element = node as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
      const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
      const role = explicit || (tag === "button" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "summary" ? "button" : /^h[1-6]$/.test(tag) ? "heading" : tag === "li" ? "listitem" : tag === "article" ? "article" : tag === "tr" ? "row" : tag === "input" ? type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : ["button", "submit", "reset"].includes(type) ? "button" : "textbox" : "generic");
      const normalized = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
      const labels = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ? [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ")
        : "";
      const placeholder = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : "";
      const name = normalized(element.getAttribute("aria-label")) || normalized(labelledText) || normalized(labels) || normalized(placeholder) || normalized(element.getAttribute("title") || element.getAttribute("alt") || element.textContent);
      return [tag, role, name, type].join("|").slice(0, 1_000);
    });
    if (signature !== recipe.signature) throw new StaleBrowserReferenceError();
    return locator;
  }

  async click(page: Page, ref: string): Promise<ClickMode> {
    return clickWithDomFallback(await this.locator(page, ref), page);
  }

  async waitForChange(page: Page, beforeFingerprint: string, timeoutMs = 2_500): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let latest = beforeFingerprint;
    let stableChanged = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(150);
      const current = await this.fingerprint(page);
      if (current !== beforeFingerprint) {
        stableChanged = current === latest ? stableChanged + 1 : 1;
        latest = current;
        if (stableChanged >= 2) return current;
      }
    }
    return this.fingerprint(page);
  }

  async scroll(page: Page, args: BrowserScrollArguments): Promise<void> {
    const delta = args.direction === "down" ? args.amount : -args.amount;
    if (args.ref) {
      const locator = await this.locator(page, args.ref);
      await locator.evaluate((node, amount) => {
        const hasScrollSurface = (candidate: HTMLElement): boolean => {
          const style = window.getComputedStyle(candidate);
          return (candidate.scrollHeight > candidate.clientHeight + 1 && /(?:auto|scroll|overlay)/.test(style.overflowY))
            || (candidate.scrollWidth > candidate.clientWidth + 1 && /(?:auto|scroll|overlay)/.test(style.overflowX));
        };
        let target: HTMLElement | null = node as HTMLElement;
        for (let depth = 0; target && depth < 8 && !hasScrollSurface(target); depth += 1) target = target.parentElement;
        if (target && hasScrollSurface(target)) target.scrollBy({ top: amount, behavior: "instant" });
        else window.scrollBy({ top: amount, behavior: "instant" });
      }, delta);
      return;
    }
    await page.evaluate((amount) => window.scrollBy({ top: amount, behavior: "instant" }), delta);
  }

  async wait(page: Page, args: BrowserWaitArguments): Promise<void> {
    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() <= deadline) {
      let satisfied = false;
      if (args.condition === "url_contains") satisfied = page.url().includes(args.value!);
      else if (args.condition === "text_visible" || args.condition === "text_hidden") {
        const body = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        const found = body.toLowerCase().includes(args.value!.toLowerCase());
        satisfied = args.condition === "text_visible" ? found : !found;
      } else if (args.condition === "page_changed") satisfied = await this.fingerprint(page) !== args.fingerprint;
      else {
        try {
          const locator = await this.locator(page, args.ref!);
          if (args.condition === "element_visible") satisfied = await locator.isVisible();
          else if (args.condition === "element_hidden") satisfied = !await locator.isVisible();
          else if (args.condition === "value_equals") satisfied = await locator.inputValue().catch(() => "") === args.value;
        } catch (error) {
          if (args.condition === "element_hidden" && error instanceof StaleBrowserReferenceError) satisfied = true;
          else throw error;
        }
      }
      if (satisfied) return;
      await page.waitForTimeout(150);
    }
    throw new Error(`Timed out waiting for ${args.condition}`);
  }
}
