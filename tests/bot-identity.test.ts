import { describe, expect, it } from "vitest";
import { botVariantForIdentity } from "../src/renderer/src/bot-identity";

describe("bot identity", () => {
  it("gives built-in roles distinct persistent profiles", () => {
    expect(botVariantForIdentity("explorer")).toBe("cyan");
    expect(botVariantForIdentity("worker")).toBe("coral");
    expect(botVariantForIdentity("reviewer")).toBe("violet");
    expect(botVariantForIdentity("builder")).toBe("amber");
    expect(botVariantForIdentity("tester")).toBe("mint");
  });

  it("does not change a profile when status changes elsewhere", () => {
    const before = botVariantForIdentity("custom_release_scout");
    const after = botVariantForIdentity("custom_release_scout");
    expect(after).toBe(before);
  });
});
