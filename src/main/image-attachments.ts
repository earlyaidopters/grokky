import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { ImageAttachment, ImageInput, ImageMimeType } from "../shared/contracts";
import { MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES } from "../shared/contracts";

const extensionForMime: Record<ImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function detectedMime(data: Uint8Array): ImageMimeType | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && String.fromCharCode(...data.slice(0, 4)) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function safeDisplayName(value: string, mimeType: ImageMimeType): string {
  const name = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  return name || `image${extensionForMime[mimeType]}`;
}

export class ImageAttachmentStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async persist(conversationId: string, inputs: ImageInput[]): Promise<ImageAttachment[]> {
    if (!inputs.length) return [];
    if (inputs.length > MAX_IMAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
    let totalBytes = 0;
    const validated = inputs.map((input) => {
      if (input.data.byteLength === 0 || input.data.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image ${input.name} is too large`);
      totalBytes += input.data.byteLength;
      if (totalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error("Attached images are too large in total");
      const mimeType = detectedMime(input.data);
      if (!mimeType || mimeType !== input.mimeType) throw new Error(`Image ${input.name} has invalid or mismatched file data`);
      return { input, mimeType };
    });
    const directory = this.conversationDirectory(conversationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attachments: ImageAttachment[] = [];
    for (const { input, mimeType } of validated) {
      const id = randomUUID().replaceAll("-", "");
      const localPath = join(directory, `${id}${extensionForMime[mimeType]}`);
      try {
        await writeFile(localPath, input.data, { mode: 0o600 });
        attachments.push({
          id,
          name: safeDisplayName(input.name, mimeType),
          mimeType,
          size: input.data.byteLength,
          localPath,
        });
      } catch (error) {
        await Promise.all([
          this.remove(attachments),
          unlink(localPath).catch(() => undefined),
        ]);
        throw error;
      }
    }
    return attachments;
  }

  async dataUrl(attachment: ImageAttachment): Promise<string> {
    const pathname = this.requireManagedPath(attachment.localPath);
    const data = await readFile(pathname);
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) throw new Error("Stored image data is unavailable or invalid");
    const mimeType = detectedMime(data);
    if (!mimeType || mimeType !== attachment.mimeType) throw new Error("Stored image data is unavailable or invalid");
    return `data:${mimeType};base64,${data.toString("base64")}`;
  }

  async remove(attachments: ImageAttachment[]): Promise<void> {
    await Promise.all(attachments.map(async (attachment) => {
      try {
        await unlink(this.requireManagedPath(attachment.localPath));
      } catch {
        // Cleanup is best-effort; sending and cancellation should not fail on a missing image.
      }
    }));
  }

  async removeConversation(conversationId: string): Promise<void> {
    await rm(this.conversationDirectory(conversationId), { recursive: true, force: true });
  }

  private conversationDirectory(conversationId: string): string {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(conversationId)) throw new Error("Invalid conversation attachment directory");
    return this.requireManagedPath(join(this.root, conversationId));
  }

  private requireManagedPath(pathname: string): string {
    const absolute = resolve(pathname);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${sep}`)) throw new Error("Image attachment path is outside Grokky storage");
    return absolute;
  }
}
