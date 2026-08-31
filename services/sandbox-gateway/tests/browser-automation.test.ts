import { describe, expect, test } from "vitest";
import { BrowserAutomation, clickWithDomFallback, fillWithVisibleFallback, StaleBrowserReferenceError } from "../src/browser-automation";
import type { Locator } from "@cloudflare/playwright";
import type { Page } from "@cloudflare/playwright";

function travelPage(): Page {
  const candidates = [
    { locatorIndex: 0, signature: "input|textbox|Where from?|text", interactive: true, role: "textbox", name: "Where from?", tag: "input", type: "text", value: "Montreal", visible: true, bounds: { x: 80, y: 120, width: 260, height: 44 } },
    { locatorIndex: 1, signature: "input|textbox|Where to?|text", interactive: true, role: "textbox", name: "Where to?", tag: "input", type: "text", value: "Istanbul", visible: true, bounds: { x: 360, y: 120, width: 260, height: 44 } },
    { locatorIndex: 2, signature: "button|button|Departure|", interactive: true, role: "button", name: "Departure", tag: "button", text: "Departure", visible: true, bounds: { x: 640, y: 120, width: 170, height: 44 } },
    { locatorIndex: 3, signature: "button|button|December 13, 2026|", interactive: true, role: "button", name: "December 13, 2026", tag: "button", text: "13", dateHint: "2026-12-13", visible: true, bounds: { x: 700, y: 280, width: 42, height: 42 } },
    { locatorIndex: 4, signature: "button|button|Search|", interactive: true, role: "button", name: "Search", tag: "button", text: "Search", visible: true, bounds: { x: 830, y: 120, width: 120, height: 44 } },
    { locatorIndex: 5, signature: "h1|heading|Flight results|", interactive: false, role: "heading", name: "Flight results", tag: "h1", text: "Flight results", visible: true, bounds: { x: 80, y: 400, width: 300, height: 50 } },
  ];
  const locator = {
    evaluateAll: async () => candidates,
    nth: (index: number) => ({
      count: async () => 1,
      evaluate: async () => candidates[index]?.signature,
    }),
  };
  const frame = { locator: () => locator };
  return {
    frames: () => [frame],
    evaluate: async (callback: unknown) => {
      const source = String(callback);
      if (source.includes("maxY")) {
        return { viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0, maxY: 900 }, dialogs: 1, visibleText: "Montreal Istanbul Departure December 13, 2026 Search Flight results", truncated: false };
      }
      return { url: "https://fixture.test/flights", title: "Travel fixture", x: 0, y: 0, dialogCount: 1, activeSignature: "", bodyText: "Montreal Istanbul Departure December 13, 2026 Search Flight results" };
    },
    title: async () => "Travel fixture",
    url: () => "https://fixture.test/flights",
  } as unknown as Page;
}

describe("semantic browser observations", () => {
  test("exposes travel controls and date cells as bounded accessible refs", async () => {
    const automation = new BrowserAutomation();
    const page = travelPage();
    const observation = await automation.observe(page, { mode: "both", limit: 20 });

    expect(observation.snapshotId).toMatch(/^page-[a-f0-9]{16}$/);
    expect(observation.elements.map((element) => [element.role, element.name])).toEqual(expect.arrayContaining([
      ["textbox", "Where from?"],
      ["textbox", "Where to?"],
      ["button", "Departure"],
      ["button", "December 13, 2026"],
      ["button", "Search"],
      ["heading", "Flight results"],
    ]));
    const date = observation.elements.find((element) => element.name === "December 13, 2026");
    expect(date?.ref).toMatch(/^el-[a-f0-9]{16}-0-3$/);
    expect(date?.dateHint).toBe("2026-12-13");
    await expect(automation.locator(page, date!.ref)).resolves.toBeTruthy();
  });

  test("expires every old ref when a new page observation is issued", async () => {
    const automation = new BrowserAutomation();
    const page = travelPage();
    const first = await automation.observe(page, { mode: "interactive", limit: 20 });
    const oldRef = first.elements.find((element) => element.name === "Departure")!.ref;
    const second = await automation.observe(page, { mode: "interactive", limit: 20 });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    await expect(automation.locator(page, oldRef)).rejects.toBeInstanceOf(StaleBrowserReferenceError);
  });

  test("uses a verified DOM click when a visible JS-driven card times out under pointer actionability checks", async () => {
    let domClicks = 0;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => { throw new Error("locator.click: Timeout 10000ms exceeded"); },
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return false;
        if (source.includes("select flight")) return false;
        if (source.includes("getBoundingClientRect")) return true;
        domClicks += 1;
        return undefined;
      },
    } as unknown as Locator;

    await expect(clickWithDomFallback(locator)).resolves.toBe("dom");
    expect(domClicks).toBe(1);
  });

  test("does not bypass non-timeout click failures", async () => {
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => { throw new Error("Element is disabled"); },
      evaluate: async () => true,
    } as unknown as Locator;

    await expect(clickWithDomFallback(locator)).rejects.toThrow("Element is disabled");
  });

  test("retries a JS-driven link through the DOM when a successful pointer click has no page effect", async () => {
    let domClicks = 0;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return true;
        if (source.includes("select flight")) return false;
        if (source.includes("getBoundingClientRect")) return true;
        domClicks += 1;
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({ url: "https://fixture.test/flights", dialogs: 0, hasSelectFlight: false }),
      waitForTimeout: async () => undefined,
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("dom_after_no_effect");
    expect(domClicks).toBe(1);
  });

  test("does not double-activate a JS-driven link when its pointer click navigates", async () => {
    let stateReads = 0;
    let domClicks = 0;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return true;
        if (source.includes("select flight")) return false;
        domClicks += 1;
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({
        url: stateReads++ ? "https://fixture.test/returning" : "https://fixture.test/flights",
        dialogs: 0,
        hasSelectFlight: false,
      }),
      waitForTimeout: async () => undefined,
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("pointer");
    expect(domClicks).toBe(0);
  });

  test("uses a flight card's disclosure edge when its center click leaves the card collapsed", async () => {
    let edgeClick: { x: number; y: number } | undefined;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return true;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 100, y: 200, width: 900, height: 80 };
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({ url: "https://fixture.test/flights", dialogs: 0, hasSelectFlight: false }),
      waitForTimeout: async () => undefined,
      mouse: { click: async (x: number, y: number) => { edgeClick = { x, y }; } },
      locator: () => ({ evaluateAll: async () => false }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_edge");
    expect(edgeClick).toEqual({ x: 968, y: 240 });
  });

  test("activates Select flight after expanding a Google Flights result card", async () => {
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return true;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 100, y: 200, width: 900, height: 80 };
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({ url: "https://fixture.test/flights", dialogs: 0, hasSelectFlight: false }),
      waitForTimeout: async () => undefined,
      mouse: { click: async () => undefined },
      locator: () => ({ evaluateAll: async () => true }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_select");
  });

  test("uses the labelled flight-card ancestor geometry when the model selects a nested child", async () => {
    let edgeClick: { x: number; y: number } | undefined;
    let centered = false;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return false;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 40, y: 160, width: 1040, height: 96 };
        if (source.includes("scrollIntoView")) {
          centered = true;
          return true;
        }
        if (source.includes("labelledCard || visualResultRow")) return { x: 80, y: 300, width: 1000, height: 100 };
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({ url: "https://fixture.test/flights", dialogs: 0, hasSelectFlight: false }),
      waitForTimeout: async () => undefined,
      mouse: { click: async (x: number, y: number) => { edgeClick = { x, y }; } },
      locator: () => ({ evaluateAll: async () => false }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_edge");
    expect(centered).toBe(true);
    expect(edgeClick).toEqual({ x: 1048, y: 350 });
  });

  test("uses a held pointer sequence on the centered result link before lower-level fallbacks", async () => {
    let stateReads = 0;
    const events: string[] = [];
    let locatorClickOptions: Record<string, unknown> | undefined;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async (options: Record<string, unknown>) => { locatorClickOptions = options; },
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return true;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 100, y: 250, width: 900, height: 80 };
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({
        url: "https://fixture.test/flights",
        dialogs: 0,
        hasSelectFlight: false,
        hasReturningFlights: stateReads++ >= 2,
      }),
      waitForTimeout: async () => undefined,
      mouse: {
        click: async () => undefined,
        move: async () => { events.push("move"); },
        down: async () => { events.push("down"); },
        up: async () => { events.push("up"); },
      },
      locator: () => ({ evaluateAll: async () => false }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_select");
    expect(locatorClickOptions).toMatchObject({ delay: 140, steps: 6, timeout: 10_000 });
    expect(events).toEqual(["move", "down", "up"]);
  });

  test("activates the nearest actionable flight-card ancestor when the disclosure edge does not transition", async () => {
    let stateReads = 0;
    let cardActivations = 0;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return false;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 60, y: 180, width: 1000, height: 90 };
        if (source.includes("const target = labelledAction")) {
          cardActivations += 1;
          return true;
        }
        if (source.includes("current.tabIndex")) return false;
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({
        url: "https://fixture.test/flights",
        dialogs: 0,
        hasSelectFlight: false,
        hasReturningFlights: stateReads++ >= 4,
      }),
      waitForTimeout: async () => undefined,
      mouse: { click: async () => undefined },
      locator: () => ({ evaluateAll: async () => false }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_dom");
    expect(cardActivations).toBe(1);
  });

  test("uses keyboard semantics when pointer, disclosure, and DOM activation do not transition", async () => {
    let stateReads = 0;
    let enterPresses = 0;
    const locator = {
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
      evaluate: async (callback: unknown) => {
        const source = String(callback);
        if (source.includes('getAttribute("role")')) return false;
        if (source.includes("ownText") && source.includes("depth === 0")) return { x: 60, y: 180, width: 1000, height: 90 };
        if (source.includes("const target = labelledAction")) return true;
        if (source.includes("current.tabIndex")) return true;
        return undefined;
      },
    } as unknown as Locator;
    const page = {
      evaluate: async () => ({
        url: "https://fixture.test/flights",
        dialogs: 0,
        hasSelectFlight: false,
        hasReturningFlights: stateReads++ >= 5,
      }),
      waitForTimeout: async () => undefined,
      mouse: { click: async () => undefined },
      keyboard: { press: async (key: string) => { if (key === "Enter") enterPresses += 1; } },
      locator: () => ({ evaluateAll: async () => false }),
    } as unknown as Page;

    await expect(clickWithDomFallback(locator, page)).resolves.toBe("flight_card_keyboard");
    expect(enterPresses).toBe(1);
  });
});

describe("resilient field filling", () => {
  test("retargets a hidden duplicate date input to its visible equivalent and commits the range", async () => {
    let visibleFill = "";
    let doneClicks = 0;
    const identity = { tag: "input", label: "Return", placeholder: "Return", name: "", type: "text" };
    const hiddenCandidate = {
      isVisible: async () => false,
    };
    const visibleCandidate = {
      isVisible: async () => true,
      evaluate: async () => true,
      inputValue: async () => "",
      fill: async (value: string) => { visibleFill = value; },
    };
    const locator = {
      evaluate: async () => identity,
      inputValue: async () => "",
      isVisible: async () => false,
    } as unknown as Locator;
    const page = {
      locator: () => ({
        count: async () => 2,
        nth: (index: number) => index === 0 ? hiddenCandidate : visibleCandidate,
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => true,
          click: async () => { doneClicks += 1; },
        }),
      }),
    } as unknown as Page;

    await expect(fillWithVisibleFallback(locator, page, "11/22/2026")).resolves.toEqual({
      mode: "visible_equivalent",
      committedDatePicker: true,
    });
    expect(visibleFill).toBe("11/22/2026");
    expect(doneClicks).toBe(1);
  });

  test("fills a visible field directly without opening unrelated commit controls", async () => {
    let directFill = "";
    const locator = {
      evaluate: async () => ({ tag: "input", label: "Where to?", placeholder: "", name: "", type: "text" }),
      inputValue: async () => "",
      isVisible: async () => true,
      fill: async (value: string) => { directFill = value; },
    } as unknown as Locator;
    const page = {
      getByRole: () => { throw new Error("Done lookup should not occur"); },
    } as unknown as Page;

    await expect(fillWithVisibleFallback(locator, page, "LIS")).resolves.toEqual({
      mode: "direct",
      committedDatePicker: false,
    });
    expect(directFill).toBe("LIS");
  });
});
