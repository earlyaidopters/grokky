import { describe, expect, test } from "vitest";
import { needsCrewMeeting, parseMeetingResolution, parseMeetingReview } from "../src/main/providers/openrouter-provider";

describe("OpenRouter crew meeting routing", () => {
  test("adds the peer-review round only when the user asks for collaboration", () => {
    expect(needsCrewMeeting("Hold a review meeting and agree on one decision.")).toBe(true);
    expect(needsCrewMeeting("Have the agents challenge each other before answering.")).toBe(true);
    expect(needsCrewMeeting("Read README.md independently and summarize it.")).toBe(false);
    expect(needsCrewMeeting("Summarize these meeting notes and list the decisions.")).toBe(false);
    expect(needsCrewMeeting("I have a meeting at four; draft my agenda.")).toBe(false);
  });

  test("requires complete specialist and moderator records before consensus", () => {
    expect(parseMeetingReview('{"challenge":"Missing proof","agreement":"The scope is right","decision":"Verify it","actionItem":"Run the focused check"}')).toEqual({
      challenge: "Missing proof", agreement: "The scope is right", decision: "Verify it", actionItem: "Run the focused check",
    });
    expect(parseMeetingReview('{"challenge":"Missing proof"}')).toBeNull();
    expect(parseMeetingReview("not json")).toBeNull();
    expect(parseMeetingResolution('{"decision":"Ship","actionItem":"Publish the verified patch","dissent":"No material dissent."}')).toEqual({
      decision: "Ship", actionItem: "Publish the verified patch", dissent: "No material dissent.",
    });
    expect(parseMeetingResolution('{"decision":"Ship","actionItem":""}')).toBeNull();
  });
});
