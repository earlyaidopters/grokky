import type { ImageMimeType } from "../../shared/contracts";

export interface DraftImage {
  id: string;
  file: File;
  name: string;
  mimeType: ImageMimeType;
  previewUrl: string;
}
export interface ConversationDraft { text: string; images: DraftImage[] }
const empty: ConversationDraft = { text: "", images: [] };

/** Window-lifetime drafts. Files and private text are never written to browser storage. */
export class ConversationDrafts {
  private drafts = new Map<string, ConversationDraft>();
  private listeners = new Set<() => void>();
  constructor(private revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)) {}
  get(id: string): ConversationDraft { return this.drafts.get(id) ?? empty; }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  update(id: string, patch: Partial<ConversationDraft>): void {
    const previous = this.get(id);
    const next = { ...previous, ...patch };
    for (const image of previous.images) {
      if (!next.images.some((item) => item.previewUrl === image.previewUrl)) this.revoke(image.previewUrl);
    }
    this.drafts.set(id, next);
    this.listeners.forEach((listener) => listener());
  }
  clearSubmitted(id: string, submitted: ConversationDraft): void {
    // An in-flight send must never erase a newer draft, even after switching chats.
    if (this.get(id) === submitted) this.update(id, empty);
  }
  retain(ids: Set<string>): void {
    for (const [id, draft] of this.drafts) {
      if (ids.has(id)) continue;
      draft.images.forEach((image) => this.revoke(image.previewUrl));
      this.drafts.delete(id);
    }
  }
}
