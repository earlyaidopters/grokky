import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openRouterToolContent } from "../src/main/providers/openrouter-provider";

describe("OpenRouter screen tool content", () => {
  test("attaches a local screen capture as model-visible image content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-screen-tool-"));
    const pathname = join(directory, "screen.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(pathname, png);

    const content = await openRouterToolContent("capture_screen", `Captured the current display to ${pathname}`);
    expect(content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "image_url",
        imageUrl: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" },
      },
    ]);
  });

  test("keeps ordinary tool output textual", async () => {
    await expect(openRouterToolContent("read_file", "hello")).resolves.toBe("hello");
  });
});
