import { describe, expect, test } from "vitest";
import { MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES } from "../src/shared/contracts";
import { requireImageInputs, requireMessageOrImages } from "../src/shared/validation";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image input validation", () => {
  test("allows an image-only message and preserves typed bytes", () => {
    const images = requireImageInputs([{ name: "diagram.png", mimeType: "image/png", data: pngBytes }]);
    expect(requireMessageOrImages("", images.length)).toBe("");
    expect(images[0]).toMatchObject({ name: "diagram.png", mimeType: "image/png", data: pngBytes });
  });

  test("rejects unsupported types, oversized files, and too many images", () => {
    expect(() => requireImageInputs([{ name: "photo.gif", mimeType: "image/gif", data: pngBytes }])).toThrow("PNG, JPEG, or WebP");
    expect(() => requireImageInputs([{ name: "huge.png", mimeType: "image/png", data: new Uint8Array(MAX_IMAGE_BYTES + 1) }])).toThrow("smaller than");
    expect(() => requireImageInputs(Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, (_, index) => ({
      name: `${index}.png`,
      mimeType: "image/png",
      data: pngBytes,
    })))).toThrow(`up to ${MAX_IMAGE_ATTACHMENTS}`);
  });

  test("still rejects a fully empty message", () => {
    expect(() => requireMessageOrImages("  ", 0)).toThrow("cannot be empty");
  });
});
