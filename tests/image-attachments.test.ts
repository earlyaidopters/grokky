import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ImageAttachmentStore } from "../src/main/image-attachments";

const onePixelPng = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

describe("ImageAttachmentStore", () => {
  test("persists validated images and returns provider-ready data URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-images-"));
    const store = new ImageAttachmentStore(join(directory, "attachments"));
    const [attachment] = await store.persist("conversation0001", [{
      name: "reference.png",
      mimeType: "image/png",
      data: onePixelPng,
    }]);

    expect(attachment).toMatchObject({ name: "reference.png", mimeType: "image/png", size: onePixelPng.byteLength });
    await expect(access(attachment!.localPath)).resolves.toBeUndefined();
    await expect(store.dataUrl(attachment!)).resolves.toMatch(/^data:image\/png;base64,/);

    await store.remove([attachment!]);
    await expect(access(attachment!.localPath)).rejects.toThrow();
  });

  test("rejects mismatched bytes before creating attachment files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-images-"));
    const store = new ImageAttachmentStore(join(directory, "attachments"));
    await expect(store.persist("conversation0002", [{
      name: "not-really.webp",
      mimeType: "image/webp",
      data: onePixelPng,
    }])).rejects.toThrow("mismatched file data");
  });

  test("never reads paths outside its managed attachment root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-images-"));
    const store = new ImageAttachmentStore(join(directory, "attachments"));
    await expect(store.dataUrl({
      id: "outside0001",
      name: "outside.png",
      mimeType: "image/png",
      size: onePixelPng.byteLength,
      localPath: join(directory, "outside.png"),
    })).rejects.toThrow("outside Grokky storage");
  });
});
