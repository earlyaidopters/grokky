import { describe, expect, it } from "vitest";
import { boundedJson, MAX_JSON_BYTES } from "../src/http";

function streamedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  return new Request("https://gateway.example/execute", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("boundedJson", () => {
  it("parses a streamed JSON object without requiring Content-Length", async () => {
    await expect(boundedJson(streamedRequest(["{\"action\":", "\"capture_screen\"}"]))).resolves.toEqual({
      action: "capture_screen",
    });
  });

  it("rejects an oversized streamed body when Content-Length is absent", async () => {
    const oversized = `{"value":"${"x".repeat(MAX_JSON_BYTES)}"}`;
    await expect(boundedJson(streamedRequest([oversized.slice(0, 120_000), oversized.slice(120_000)])))
      .rejects.toThrow("Request body is too large");
  });

  it("requires the top-level JSON value to be an object", async () => {
    await expect(boundedJson(streamedRequest(["[]"]))).rejects.toThrow("JSON object required");
  });
});
