import { expect, test, vi } from "vitest";
import { ConversationDrafts, type DraftImage } from "../src/renderer/src/conversation-drafts";

test("switching conversations preserves separate text and attachments until sent or deleted", () => {
  const revoke = vi.fn();
  const drafts = new ConversationDrafts(revoke);
  const image = { id: "image", previewUrl: "blob:fixture" } as DraftImage;
  drafts.update("a", { text: "First draft", images: [image] });
  drafts.update("b", { text: "Second draft" });
  expect(drafts.get("a")).toEqual({ text: "First draft", images: [image] });
  expect(revoke).not.toHaveBeenCalled();
  drafts.clearSubmitted("a", drafts.get("a"));
  expect(drafts.get("b").text).toBe("Second draft");
  expect(drafts.get("a")).toEqual({ text: "", images: [] });
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
});

test("a delayed send cannot erase a newer draft and deletion releases retained previews", () => {
  const revoke = vi.fn();
  const drafts = new ConversationDrafts(revoke);
  drafts.update("a", { text: "Sending" });
  const sending = drafts.get("a");
  drafts.update("a", { text: "Follow-up", images: [{ id: "new", previewUrl: "blob:new" } as DraftImage] });
  drafts.clearSubmitted("a", sending);
  expect(drafts.get("a").text).toBe("Follow-up");
  drafts.retain(new Set(["b"]));
  expect(drafts.get("a").text).toBe("");
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:new");
});
